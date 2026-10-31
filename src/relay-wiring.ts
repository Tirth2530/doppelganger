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
//     epoch the Court stamped here.

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
    /** Called once per operation that goes UNDER_REVIEW: start the experiment here. */
    onReview?: (op: Op) => void
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

const roleOf = (name: string, roster: Roster) => roster.roles[name] ?? name

function split(input: unknown): { args: Args; trigger: string } {
    const raw = (input ?? {}) as Record<string, unknown>
    const args: Args = {}
    for (const [k, v] of Object.entries(raw)) if (k !== TRIGGER_FIELD && typeof v === "string") args[k] = v
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
            const { args } = split(input)
            const d = await ports.court.checkScope(roleOf(ctx.caller.name, roster), spec.name, args)
            return { allowed: d.allowed, reason: d.reason }
        }

        const handle = host.registerAction<Args, { opId: string; state: string; reason: string }>({
            name: spec.name,
            description: spec.description,
            input: schemaFor(spec.required),
            visibility: "agent",
            policy,
            handler: async ({ input, agent }) => {
                const { args, trigger } = split(input)
                const opId = `op-${Date.now().toString(36)}-${++counter}`
                const requestedBy = roleOf(agent.name, roster)
                emit({ type: "invoke", agent: requestedBy, action: spec.name, args, triggerRelayId: trigger, opId })
                options.onAttempt?.({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger })
                const op = await ports.court.submit({ opId, action: spec.name, args, requestedBy, triggerRelayId: trigger, lineage: await lineageFor(trigger) })
                emit({ type: "court", state: await ports.court.getState() })
                if (op.state === "UNDER_REVIEW") options.onReview?.(op)
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
                const { args, trigger } = split(event.input)
                const opId = `denied-${spec.name}-${event.at}`
                const requestedBy = roleOf(event.agent.name, roster)
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
