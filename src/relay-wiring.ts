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
import type { ActionName, Args, MessageRecord, Op, Trust } from "./types.ts"

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

function schemaFor(required: string[]) {
    return {
        type: "object" as const,
        required: [...required, TRIGGER_FIELD],
        additionalProperties: false,
        properties: Object.fromEntries([...required, TRIGGER_FIELD].map(k => [k, { type: "string" as const }]))
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

/** Registers the privileged actions on Relay with the Court as their policy and handler. Returns a disposer. */
export function wireCourt(options: WiringOptions): () => void {
    const { host, stream, ports, roster } = options
    const emit = options.emit ?? (() => {})
    const disposers: (() => void)[] = []
    let counter = 0
    const lineageFor = async (trigger: string) => computeLineage(new Map((await ports.lineage.all()).map(m => [m.relayId, m])), trigger)

    for (const spec of PRIVILEGED_ACTIONS) {
        // The safety layer, as Relay's policy: runs before the handler, refusal is Relay's own.
        const policy = async (input: unknown, ctx: ActionContext): Promise<ActionPolicyDecision> => {
            const role = callerRole(ctx.caller?.name, roster)
            if (!role) return { allowed: false, reason: `authorization: caller "${ctx.caller?.name ?? "unknown"}" is not a registered agent of this team` }
            const { args } = split(input, spec.required)
            const d = await ports.court.checkScope(role, spec.name, args)
            return { allowed: d.allowed, reason: d.reason }
        }

        const handle = host.registerAction<Args, { opId: string; state: string; reason: string }>({
            name: spec.name,
            description: spec.description,
            input: schemaFor(spec.required),
            visibility: "agent",
            // Relay enforces this list too (server side and in the SDK), ahead of the policy.
            availableTo: options.callers ?? internalAgents(roster),
            policy,
            handler: async ({ input, agent }) => {
                // Defence in depth: the policy already refused unknown callers.
                const requestedBy = callerRole(agent?.name, roster)
                if (!requestedBy) throw new Error("caller is not a registered agent of this team")
                const { args, trigger } = split(input, spec.required)
                const opId = `op-${Date.now().toString(36)}-${++counter}`
                emit({ type: "invoke", agent: requestedBy, action: spec.name, args, triggerRelayId: trigger, opId })
                options.onAttempt?.({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger })
                const op = await ports.court.submit({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger, lineage: await lineageFor(trigger) })
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

        // Relay's own denial event is the record.
        disposers.push(
            host.addListener(handle.denied(), async event => {
                const { args, trigger } = split(event.input, spec.required)
                const opId = `denied-${spec.name}-${event.at}`
                const requestedBy = callerRole(event.agent?.name, roster) ?? `unknown:${event.agent?.name ?? "?"}`
                options.onAttempt?.({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger })
                await ports.court.recordDenied(
                    { opId, action: spec.name, args, requestedBy, triggerRelayId: trigger, lineage: await lineageFor(trigger) },
                    event.reason ?? "refused by the Court, running as the action's policy"
                )
                emit({ type: "court", state: await ports.court.getState() })
            })
        )
    }

    // Lineage from the wire. `metadata.inputs` is what the sender had read; trust is the roster's call.
    disposers.push(
        stream.addListener("message.created", async ({ message }: RelayMessageEvent<"message.created">) => {
            const from = message.from.name ?? message.from.id ?? "unknown"
            const meta = (message.metadata ?? {}) as Record<string, unknown>
            const trust = trustOf(from, roster)
            const t = message.target
            const to = t?.kind === "agent" && typeof t.agentName === "string" ? t.agentName : t?.kind === "channel" && typeof t.channelName === "string" ? `#${t.channelName}` : (message.channel?.name ?? "")
            const record: MessageRecord = {
                relayId: message.id,
                from,
                to,
                trust,
                text: message.text ?? "",
                at: message.createdAt ?? new Date().toISOString(),
                producedBy: trust === "internal_agent" ? { agent: from, step: Number(meta.step ?? 0) } : null,
                inputs: trust === "internal_agent" && Array.isArray(meta.inputs) ? meta.inputs.filter((v): v is string => typeof v === "string") : []
            }
            await ports.lineage.record(record)
            emit({ type: "message", message: { relayId: record.relayId, from: roleOf(from, roster), to: roleOf(to, roster), trust, summary: record.text, inputs: record.inputs, at: record.at } })
        })
    )

    return () => {
        for (const d of disposers.splice(0)) d()
    }
}

/** Send a message whose lineage survives the hop: what it was produced from travels in metadata. */
export function sendTracked(agent: RelayAgentClient, to: string, text: string, inputs: string[], step?: number) {
    return agent.sendMessage({ to, text, metadata: { inputs, ...(step !== undefined ? { step } : {}) } })
}

/** Invocation input: the action's arguments plus the message that led to it. */
export const actionInput = (args: Args, triggerRelayId: string): Record<string, string> => ({ ...args, [TRIGGER_FIELD]: triggerRelayId })
