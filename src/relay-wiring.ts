// The Court on Agent Relay. Typed against @agent-relay/sdk 15 as shipped
// (packages/sdk/src/facade.ts, agent-relay.ts, listeners.ts, actions/types.ts).
//
// The Court joins the workspace as an agent and OWNS the privileged actions.
// Per the SDK, an action registered from an agent client is relay-routed:
// other agents invoke it over Relay, Relay delivers the invocation to the Court
// agent, and the SDK runs the action's `policy` before its handler, in the
// Court agent's process. So:
//
//  1. The safety layer IS the action's policy hook. An out-of-scope call never
//     reaches a handler: the SDK refuses the invocation, completes it with an
//     error, and emits its own `action.denied`, and the docket records that
//     event, not an agent's account of it.
//  2. Provenance rides on the wire. Every message carries the relay ids it was
//     produced from in `metadata.inputs`; the Lineage actor is rebuilt from
//     `message.created`, and trust comes from the roster, never the message.
//  3. A request whose history touches outside content goes UNDER_REVIEW and is
//     handed to the evidence layer (onReview); its verdict is fenced by the
//     epoch the Court stamped here. If it also carries a value no human
//     authorized in advance, the Court holds it at once; the evidence layer
//     then only explains it.

import type { ActionContext, ActionPolicyDecision, AgentRelayAgent, RelayAgentClient, RelayMessageEvent } from "@agent-relay/sdk"

import type { UiEvent } from "./events.ts"
import type { ActorPorts } from "./ports.ts"
import { computeLineage } from "./replay-logic.ts"
import { createHash } from "node:crypto"

import { TOOL_TO_ACTION } from "./scenario.ts"
import type { ActionName, Args, LineageSummary, MessageRecord, Op, StepRecord, Trust } from "./types.ts"

export interface Roster {
    /** Agents outside the company. Their messages taint every request that descends from them. */
    external: string[]
    /** Humans: their messages are the task itself. */
    humans: string[]
    /** Relay agent name → the role scopes are written for (e.g. "infra-7f2c" → "infra"). */
    roles: Record<string, string>
}

export interface WiringOptions {
    /** The Court's own agent client: owns the actions and hears Relay's denials. */
    host: Pick<AgentRelayAgent, "registerAction" | "addListener">
    /** Sees every agent's messages (the workspace AgentRelay fans them in). */
    stream: Pick<AgentRelayAgent, "addListener">
    ports: ActorPorts
    roster: Roster
    emit?: (event: UiEvent) => void
    /** Called once per operation that goes UNDER_REVIEW (evidence decides) or is HELD at submission (evidence only explains). */
    onReview?: (op: Op) => void
    /** Agent-runtime attestations, for servers that report the caller as the runtime node. */
    attestations?: Attestations
    /** Caller names that mean "the agent runtime" (default ["node"]); accepted ONLY with a valid attestation. */
    runtimeCallers?: string[]
    /** Registered agent id → name, for messages whose sender arrives as an id only. */
    nameOfId?: Map<string, string>
    /** Verify provenance against the recorded agent steps (AgentLog). Default true; turn off only in tests of other layers. */
    verifyProvenance?: boolean
    /** Tool name → action, to match a call against the caller's recorded step. Default: the demo agents' tools. */
    toolToAction?: Record<string, ActionName>
    /** Agent names allowed to invoke the actions (Relay's availableTo). Default: the internal roster agents. */
    callers?: string[]
    /** Called for every privileged request, refused or not: what an agent tried to do. */
    onAttempt?: (attempt: { opId: string; action: ActionName; args: Args; requestedBy: string; triggerRelayId: string }) => void
}

export const PRIVILEGED_ACTIONS: { name: ActionName; description: string; required: string[] }[] = [
    {
        name: "logging.configure",
        description: "Change a service's log level and log destination. Authorized up to a level, on one service, by the on-call engineer.",
        required: ["service", "level", "sink"]
    },
    {
        name: "access.grant",
        description: "Grant an SSH public key access to an environment. Not authorized by default.",
        required: ["service", "environment", "public_key"]
    }
]

/** The extra input field every invocation carries: the message that led to it. */
export const TRIGGER_FIELD = "trigger_relay_id"
/** Optional: a one-time attestation from the agent runtime (see Attestations). Never part of the arguments. */
export const ATTESTATION_FIELD = "attestation"

function schemaFor(required: string[]) {
    return {
        type: "object" as const,
        required: [...required, TRIGGER_FIELD],
        additionalProperties: false,
        properties: Object.fromEntries([...required, TRIGGER_FIELD, ATTESTATION_FIELD].map(k => [k, { type: "string" as const }]))
    }
}

/** Only the arguments an action declares (what the Court will see), for binding an attestation. */
export function declaredArgs(action: ActionName, args: Args): Args {
    const spec = PRIVILEGED_ACTIONS.find(p => p.name === action)
    return spec ? split(args, spec.required).args : {}
}

/**
 * Invocation attestations from the agent runtime.
 *
 * Some Relay servers report an action's caller as the runtime NODE (e.g. "node") rather than the agent that
 * invoked it. That name proves nothing about which agent acted, so it is never trusted by itself. Instead,
 * the runtime that hosts the agents (this process; models cannot reach it) issues a random single-use token
 * for each invocation it makes on an agent's behalf, bound to that agent's role, the action, the exact
 * arguments and the trigger. The Court accepts a node caller only with a matching, unexpired, unused token,
 * and consumes it in the handler. A token cannot be replayed, moved to other arguments, or used for another
 * agent; an invocation without one from a node caller is refused.
 */
export class Attestations {
    private pending = new Map<string, { role: string; action: string; args: Args; trigger: string; expires: number }>()
    constructor(private ttlMs = 60_000) {}

    issue(role: string, action: string, args: Args, trigger: string): string {
        const token = crypto.randomUUID() + crypto.randomUUID()
        this.pending.set(token, { role, action, args: { ...args }, trigger, expires: Date.now() + this.ttlMs })
        return token
    }

    /** The role a token attests for this exact request, or null. `consume` uses it up. */
    check(token: string | undefined, action: string, args: Args, trigger: string, consume: boolean): string | null {
        if (!token) return null
        const a = this.pending.get(token)
        if (!a) return null
        if (Date.now() > a.expires) {
            this.pending.delete(token)
            return null
        }
        const same = a.action === action && a.trigger === trigger && JSON.stringify(Object.entries(a.args).sort()) === JSON.stringify(Object.entries(args).sort())
        if (!same) return null
        if (consume) this.pending.delete(token)
        return a.role
    }
}

function trustOf(name: string, roster: Roster): Trust {
    if (roster.external.includes(name)) return "external"
    if (roster.humans.includes(name)) return "human"
    return "internal_agent"
}

/** Display name for a sender or recipient (never used for authority). */
const roleOf = (name: string, roster: Roster) => roster.roles[name] ?? name

/**
 * The role a caller ACTS AS: only a registered, internal roster agent has one.
 * Authority never comes from action input, from a message, or from a name that
 * merely looks like a role. An unknown caller (a runtime placeholder such as
 * "node", a stray workspace agent, an outsider, a human client) has none, so
 * every scope check fails closed for it.
 */
export function callerRole(name: string | undefined, roster: Roster): string | null {
    if (!name || !Object.hasOwn(roster.roles, name)) return null
    if (roster.external.includes(name) || roster.humans.includes(name)) return null
    return roster.roles[name]
}

/** Agents allowed to invoke privileged actions at all: the internal roster agents. */
export const internalAgents = (roster: Roster) => Object.keys(roster.roles).filter(n => callerRole(n, roster) !== null)

/** The declared arguments only: anything else in the input (e.g. a claimed identity) is dropped, whatever the transport validated. */
function split(input: unknown, declared: string[]): { args: Args; trigger: string } {
    const raw = (input ?? {}) as Record<string, unknown>
    const args: Args = {}
    for (const k of declared) if (typeof raw[k] === "string") args[k] = raw[k] as string
    return { args, trigger: typeof raw[TRIGGER_FIELD] === "string" ? (raw[TRIGGER_FIELD] as string) : "" }
}

/**
 * The history of a request, verified against the recorded agent steps
 * (AgentLog): an internal message counts as produced from what the step that
 * SENT it read, never from the inputs it claims; and, given the call, a step of
 * the caller must have read the trigger and made exactly this call. Anything
 * that does not check out is listed as unverified, and the Court holds it.
 */
export async function verifiedLineage(
    ports: ActorPorts,
    roles: string[],
    trigger: string,
    call?: { role: string; action: ActionName; args: Args },
    toolToAction: Record<string, ActionName> = TOOL_TO_ACTION
): Promise<LineageSummary> {
    const messages = new Map((await ports.lineage.all()).map(m => [m.relayId, m]))
    const producers = new Map<string, StepRecord>()
    const stepsByRole = new Map<string, StepRecord[]>()
    for (const role of roles) {
        const steps = await ports.log(role).steps()
        stepsByRole.set(role, steps)
        for (const st of steps) for (const id of st.sentRelayIds) producers.set(id, st)
    }
    const lineage = computeLineage(messages, trigger, id => producers.get(id) ?? null)
    if (call) {
        const made = (stepsByRole.get(call.role) ?? []).some(
            st => st.read.includes(trigger) && st.toolCalls.some(c => toolToAction[c.name] === call.action && Object.entries(call.args).every(([k, v]) => c.args[k] === v))
        )
        if (!made) return { ...lineage, tainted: true, unverified: [...(lineage.unverified ?? []), `call:${trigger || "(none)"}`] }
    }
    return lineage
}

/** A stable operation id for one request: same caller, action, arguments and trigger → same id. */
export function operationId(role: string, action: ActionName, args: Args, trigger: string): string {
    const canon = JSON.stringify([role, action, trigger, Object.keys(args).sort().map(k => [k, args[k]])])
    return `op-${createHash("sha256").update(canon).digest("hex").slice(0, 16)}`
}

/** Registers the privileged actions on Relay with the Court as their policy and handler. Returns a disposer. */
export function wireCourt(options: WiringOptions): () => void {
    const { host, stream, ports, roster } = options
    const emit = options.emit ?? (() => {})
    const disposers: (() => void)[] = []
    const verify = options.verifyProvenance !== false
    const toolToAction = options.toolToAction ?? TOOL_TO_ACTION
    const roles = [...new Set(internalAgents(roster).map(n => roster.roles[n]))]

    const lineageFor = (trigger: string, call?: { role: string; action: ActionName; args: Args }) =>
        verify ? verifiedLineage(ports, roles, trigger, call, toolToAction) : ports.lineage.all().then(ms => computeLineage(new Map(ms.map(m => [m.relayId, m])), trigger))

    const runtimeCallers = options.runtimeCallers ?? ["node"]
    /** A roster agent by its Relay name; or, for a runtime-node caller, the role a valid attestation names. */
    const roleFor = (caller: string | undefined, input: unknown, action: ActionName, args: Args, trigger: string, consume: boolean): string | null => {
        const direct = callerRole(caller, roster)
        if (direct) return direct
        if (!options.attestations || !caller || !runtimeCallers.includes(caller)) return null
        const token = (input as Record<string, unknown> | null)?.[ATTESTATION_FIELD]
        return options.attestations.check(typeof token === "string" ? token : undefined, action, args, trigger, consume)
    }

    for (const spec of PRIVILEGED_ACTIONS) {
        // The safety layer, as Relay's policy: runs before the handler, refusal is Relay's own.
        const policy = async (input: unknown, ctx: ActionContext): Promise<ActionPolicyDecision> => {
            const { args, trigger } = split(input, spec.required)
            const role = roleFor(ctx.caller?.name, input, spec.name, args, trigger, false)
            if (!role) return { allowed: false, reason: `authorization: caller "${ctx.caller?.name ?? "unknown"}" is not a registered agent of this team, and carries no valid runtime attestation` }
            const d = await ports.court.checkScope(role, spec.name, args)
            return { allowed: d.allowed, reason: d.reason }
        }

        const handle = host.registerAction<Args, { opId: string; state: string; reason: string }>({
            name: spec.name,
            description: spec.description,
            input: schemaFor(spec.required),
            visibility: "agent",
            // Relay enforces this list too (server side and in the SDK), ahead of the policy.
            // With attestations on, the runtime node may call too, but only with a valid token (checked in policy and handler).
            availableTo: [...(options.callers ?? internalAgents(roster)), ...(options.attestations ? runtimeCallers : [])],
            policy,
            handler: async ({ input, agent }) => {
                // Defence in depth: the policy already refused unknown callers.
                const { args, trigger } = split(input, spec.required)
                const requestedBy = roleFor(agent?.name, input, spec.name, args, trigger, true)
                if (!requestedBy) throw new Error("caller is not a registered agent of this team, and carries no valid runtime attestation")
                // Idempotency: the SDK does not hand the handler an invocation id, so the key is the request
                // itself. A redelivered or retried invocation maps to the same operation and is never re-run.
                const opId = operationId(requestedBy, spec.name, args, trigger)
                const existing = (await ports.court.getState()).ops.find(o => o.opId === opId)
                if (existing) return { opId, state: existing.state, reason: `duplicate of ${opId}: ${existing.reason}` }
                emit({ type: "invoke", agent: requestedBy, action: spec.name, args, triggerRelayId: trigger, opId })
                options.onAttempt?.({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger })
                const op = await ports.court.submit({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger, lineage: await lineageFor(trigger, { role: requestedBy, action: spec.name, args }) })
                emit({ type: "court", state: await ports.court.getState() })
                // Under review: the evidence decides. Held at once: the evidence only explains (explain() never releases).
                if (op.state === "UNDER_REVIEW" || (op.state === "HELD" && op.lineage.tainted)) options.onReview?.(op)
                if (op.state === "APPROVED") {
                    await ports.court.commit(op.opId)
                    emit({ type: "court", state: await ports.court.getState() })
                }
                return { opId: op.opId, state: op.state, reason: op.reason }
            }
        })
        disposers.push(() => handle.unregister())

        // Relay's own lifecycle events, observed, shown as such. "completed" means the Court's handler
        // returned (possibly HELD); only the Court's EXECUTED state means the change happened.
        disposers.push(
            host.addListener(handle.invoked(), event => emit({ type: "relay", phase: "action.invoked", action: spec.name, caller: event.agent?.name ?? "?", at: event.at, detail: "" }))
        )
        disposers.push(
            host.addListener(handle.completed(), event => {
                const out = (event.output ?? {}) as { opId?: string; state?: string }
                emit({ type: "relay", phase: "action.completed", action: spec.name, caller: event.agent?.name ?? "?", at: event.at, detail: `handler returned ${out.state ?? "?"} for ${out.opId ?? "?"}` })
            })
        )
        disposers.push(
            host.addListener(handle.failed(), event => emit({ type: "relay", phase: "action.failed", action: spec.name, caller: event.agent?.name ?? "?", at: event.at, detail: String((event as { error?: unknown }).error ?? "") }))
        )

        // Relay's own denial event is the record.
        disposers.push(
            host.addListener(handle.denied(), async event => {
                const { args, trigger } = split(event.input, spec.required)
                const opId = `denied-${spec.name}-${event.at}`
                const requestedBy = callerRole(event.agent?.name, roster) ?? `unknown:${event.agent?.name ?? "?"}`
                emit({ type: "relay", phase: "action.denied", action: spec.name, caller: event.agent?.name ?? "?", at: event.at, detail: event.reason ?? "" })
                options.onAttempt?.({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger })
                await ports.court.recordDenied(
                    { opId, action: spec.name, args, requestedBy, triggerRelayId: trigger, lineage: await lineageFor(trigger) },
                    event.reason ?? "refused by the Court, running as the action's policy"
                )
                emit({ type: "court", state: await ports.court.getState() })
            })
        )
    }

    // Lineage from the wire: channel messages arrive as message.created, messages sent to an agent by name
    // as dm.received (no recipient name on the event). Trust is the roster's call; inputs come from the
    // recorded steps when verification is on. A record already written by our own human client keeps its
    // recipient and case.
    const seen = new Set<string>()
    const onMessage = async ({ message }: { message: RelayMessageEvent<"message.created">["message"] }) => {
        if (!message?.id || seen.has(message.id)) return
        seen.add(message.id)
        const from = message.from?.name || options.nameOfId?.get(message.from?.id ?? "") || message.from?.id || "unknown"
        const meta = (message.metadata ?? {}) as Record<string, unknown>
        const trust = trustOf(from, roster)
        const prev = await ports.lineage.get(message.id)
        const t = message.target
        const to =
            t?.kind === "agent" && typeof t.agentName === "string" ? t.agentName : t?.kind === "channel" && typeof t.channelName === "string" ? `#${t.channelName}` : (message.channel?.name ?? prev?.to ?? "")
        const record: MessageRecord = {
            relayId: message.id,
            from,
            to,
            trust,
            text: message.text ?? "",
            at: message.createdAt ?? new Date().toISOString(),
            producedBy: trust === "internal_agent" ? { agent: from, step: Number(meta.step ?? 0) } : null,
            inputs: trust === "internal_agent" && Array.isArray(meta.inputs) ? meta.inputs.filter((v): v is string => typeof v === "string") : [],
            // A case is opened only by a human message (roster humans: our own on-call client); anyone else's claim is ignored.
            caseId: trust === "human" ? (prev?.caseId ?? (typeof meta.case === "string" ? meta.case : undefined)) : undefined
        }
        await ports.lineage.record(record)
        emit({ type: "message", message: { relayId: record.relayId, from: roleOf(from, roster), to: roleOf(to, roster), trust, summary: record.text, inputs: record.inputs, at: record.at } })
    }
    disposers.push(stream.addListener("message.created", onMessage as never))
    disposers.push(stream.addListener("dm.received", onMessage as never))

    return () => {
        for (const d of disposers.splice(0)) d()
    }
}

/** Send a message whose lineage survives the hop: what it was produced from travels in metadata. */
export function sendTracked(agent: RelayAgentClient, to: string, text: string, inputs: string[], step?: number) {
    return agent.sendMessage({ to, text, metadata: { inputs, ...(step !== undefined ? { step } : {}) } })
}

/** Invocation input: the action's arguments plus the message that led to it. */
export const actionInput = (args: Args, triggerRelayId: string, attestation?: string): Record<string, string> => ({
    ...args,
    [TRIGGER_FIELD]: triggerRelayId,
    ...(attestation ? { [ATTESTATION_FIELD]: attestation } : {})
})
