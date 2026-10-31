// The replay engine: the counterfactual sampler the evidence layer runs on.
//
// For an operation under review, each call samples one arm once:
//   baseline   every outside message unchanged
//   control    every outside message paraphrased, its requests KEPT (placebo)
//   treatment  every outside message neutralized, its requests removed
//
// How one sample works. Starting from the message that triggered the action,
// walk the recorded chain backwards through the AgentLogs: each internal
// message was produced by exactly one recorded agent step (its sentRelayIds),
// and that step saw an exact recorded context. The sample re-runs every step on
// the path from the outside message to the privileged agent, each with its own
// system prompt and tools and the context it actually had, substituting only
// the replayed text of the messages it read. Earlier state stays fixed: human
// messages, the task, and anything not descending from outside content are
// reused verbatim. The privileged agent's replayed tool call is the sample.
//
// Isolation. The engine only reads the Lineage and AgentLogs and calls the
// model. It never sends Relay messages, never invokes actions, never writes to
// any port, so a twin cannot have a side effect: a twin's "tool call" is just
// data returned to the experiment.
//
// Failure. Anything it cannot reconstruct exactly (a missing step, a context
// that no longer contains the text it read, an unknown agent) throws, and so
// does any model failure, timeout, or exhausted budget. runTrial turns every
// throw into an "error" verdict: the operation is held for a human.
//
// Rewrites are made once per arm and reused across rounds, so every round
// tests the same counterfactual world; the agents are then sampled
// independently each round at their normal settings.

import type { AgentResult, ContextMessage, ModelSettings } from "./agents.ts"
import type { ArmSampler } from "./experiment.ts"
import type { ActorPorts } from "./ports.ts"
import type { AgentSpec } from "./scenario.ts"
import type { Arm, MessageRecord, Op, StepRecord, ToolCall } from "./types.ts"

export interface ReplayStats {
    modelCalls: number
    rewriteCalls: number
    promptTokens: number
    completionTokens: number
    ms: number
    /** Settings the replay ran with, when known: the same ones the agents ran with. */
    settings?: Omit<ModelSettings, "timeoutMs">
}

export interface ReplayDeps {
    /** Calls the model for one agent step. Live: runAgent. Tests: a scripted model. */
    model: (spec: AgentSpec, context: ContextMessage[]) => Promise<AgentResult>
    /** Rewrites one outside message for an arm (control: paraphrase, treatment: neutralize). */
    rewrite: (arm: "control" | "treatment", text: string) => Promise<{ text: string; usage?: AgentResult["usage"] }>
    /** Role → the exact spec that agent ran with. */
    agents: Record<string, AgentSpec>
    /** Tool name → action name, for the privileged agent's tools. */
    toolToAction: Record<string, string>
    /** Tool names that send a message to the next agent, and the argument holding its text. */
    sendTools: Record<string, string>
    /** Hard caps: past either, the replay throws and the review fails closed. */
    maxModelCalls?: number
    deadlineMs?: number
    /** Per model call; a call past it fails the replay (runAgent also times out on its own). */
    callTimeoutMs?: number
    settings?: Omit<ModelSettings, "timeoutMs">
}

export class ReplayError extends Error {}

const FACT = /https?:\/\/[^\s"'<>)]+|[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+|[\w.+-]+@[\w-]+\.[\w.-]+|ssh-[a-z0-9-]+ [A-Za-z0-9+/=]+|\b\d+(?:[.:]\d+)*%?/gi

/** Authority-relevant facts in a message: URLs and other scheme paths, email addresses, SSH keys, numbers. */
export function factsOf(text: string): string[] {
    return [...new Set((text.match(FACT) ?? []).map(f => f.replace(/[.,;:!?]+$/, "")).filter(f => f.length >= 2))]
}

/** Facts of the original that the rewrite no longer contains (case-insensitive). */
export function missingFacts(original: string, rewrite: string): string[] {
    const r = rewrite.toLowerCase()
    return factsOf(original).filter(f => !r.includes(f.toLowerCase()))
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReplayError(`${what} timed out after ${ms} ms`)), ms)
    })
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

interface Plan {
    /** The privileged agent's step that made the call under review. */
    final: { role: string; step: StepRecord }
    /** Producer step of each internal message on the chain. */
    producers: Map<string, { role: string; step: StepRecord }>
    messages: Map<string, MessageRecord>
    outside: Set<string>
}

async function loadPlan(op: Op, ports: ActorPorts, deps: ReplayDeps): Promise<Plan> {
    const messages = new Map((await ports.lineage.all()).map(m => [m.relayId, m]))
    const steps: { role: string; step: StepRecord }[] = []
    for (const role of Object.keys(deps.agents)) for (const step of await ports.log(role).steps()) steps.push({ role, step })

    const finals = steps.filter(
        s => s.role === op.requestedBy && s.step.read.includes(op.triggerRelayId) && s.step.toolCalls.some(c => deps.toolToAction[c.name] === op.action)
    )
    if (finals.length === 0) throw new ReplayError(`no recorded step of ${op.requestedBy} made ${op.action} after reading ${op.triggerRelayId}`)
    // The most recent matching step is the one that produced this invocation.
    const final = finals[finals.length - 1]

    const producers = new Map<string, { role: string; step: StepRecord }>()
    const outside = new Set(op.lineage.externalRelayIds)
    const visit = (relayId: string, depth: number) => {
        if (depth > 16) throw new ReplayError("chain too deep to replay")
        const m = messages.get(relayId)
        if (!m) throw new ReplayError(`message ${relayId} is not in the lineage`)
        if (m.trust !== "internal_agent") return
        const producer = steps.find(s => s.step.sentRelayIds.includes(relayId))
        if (!producer) throw new ReplayError(`no recorded step sent ${relayId}`)
        producers.set(relayId, producer)
        for (const r of producer.step.read) visit(r, depth + 1)
    }
    for (const r of final.step.read) visit(r, 0)
    return { final, producers, messages, outside }
}

/** Puts the replayed text of every message a step read into its recorded context. */
function substitute(step: StepRecord, original: Map<string, string>, replayed: Map<string, string>): ContextMessage[] {
    return step.context.map(entry => {
        if (!entry.relayId || !replayed.has(entry.relayId)) return { ...entry }
        const before = original.get(entry.relayId) ?? ""
        const after = replayed.get(entry.relayId) as string
        if (before === after) return { ...entry }
        if (!before || !entry.content.includes(before)) throw new ReplayError(`step ${step.step} of ${step.agent}: its context no longer contains message ${entry.relayId}`)
        return { ...entry, content: entry.content.replace(before, () => after) }
    })
}

export function createReplaySampler(op: Op, ports: ActorPorts, deps: ReplayDeps): ArmSampler & { stats(): ReplayStats } {
    const maxCalls = deps.maxModelCalls ?? 400
    const callTimeout = deps.callTimeoutMs ?? 60_000
    const deadline = Date.now() + (deps.deadlineMs ?? 180_000)
    const stats: ReplayStats = { modelCalls: 0, rewriteCalls: 0, promptTokens: 0, completionTokens: 0, ms: 0, settings: deps.settings }
    let plan: Promise<Plan> | null = null
    const rewrites = new Map<string, Promise<string>>()

    const budget = () => {
        if (Date.now() > deadline) throw new ReplayError("replay deadline exceeded")
        if (stats.modelCalls + stats.rewriteCalls >= maxCalls) throw new ReplayError(`replay budget of ${maxCalls} model calls exhausted`)
    }
    const count = (u: AgentResult["usage"]) => {
        stats.promptTokens += u?.promptTokens ?? 0
        stats.completionTokens += u?.completionTokens ?? 0
    }

    // Each rewrite must keep every authority-relevant fact of the original (URLs, paths, addresses, keys,
    // numbers). One retry; if a fact is still missing the replay fails and the action is held: a twin that
    // lost a value would look "uninfluenced" for the wrong reason.
    const rewriteOnce = async (arm: "control" | "treatment", m: MessageRecord) => {
        budget()
        stats.rewriteCalls++
        const r = await withTimeout(deps.rewrite(arm, m.text), callTimeout, `${arm} rewrite`)
        count(r.usage)
        if (!r.text.trim()) throw new ReplayError(`empty ${arm} rewrite of ${m.relayId}`)
        return r.text
    }
    const rewritten = (arm: "control" | "treatment", m: MessageRecord) => {
        const key = `${arm}:${m.relayId}`
        let p = rewrites.get(key)
        if (!p) {
            p = (async () => {
                let text = await rewriteOnce(arm, m)
                let lost = missingFacts(m.text, text)
                if (lost.length) {
                    text = await rewriteOnce(arm, m)
                    lost = missingFacts(m.text, text)
                }
                if (lost.length) throw new ReplayError(`the ${arm} rewrite of ${m.relayId} dropped facts (${lost.slice(0, 3).join(", ")}): no fair twin, held for a human`)
                return text
            })()
            rewrites.set(key, p)
        }
        return p
    }

    const step = async (role: string, spec: AgentSpec | undefined, context: ContextMessage[]) => {
        if (!spec) throw new ReplayError(`no spec for agent ${role}`)
        budget()
        stats.modelCalls++
        const r = await withTimeout(deps.model(spec, context), callTimeout, `replay of ${role}`)
        count(r.usage)
        return r
    }

    const sample: ArmSampler = async (arm: Arm): Promise<ToolCall | null> => {
        const t0 = performance.now()
        try {
            plan ??= loadPlan(op, ports, deps)
            const p = await plan
            // One independent world per sample: a message replayed once, used by every step that read it.
            const memo = new Map<string, Promise<string | null>>()
            const textOf = (relayId: string): Promise<string | null> => {
                let v = memo.get(relayId)
                if (v) return v
                v = (async () => {
                    const m = p.messages.get(relayId) as MessageRecord
                    if (p.outside.has(relayId)) return arm === "baseline" ? m.text : rewritten(arm, m)
                    const producer = p.producers.get(relayId)
                    if (!producer) return m.text // human or other fixed input: earlier state stays as it was
                    const ctx = await contextFor(producer.step)
                    if (!ctx) return null
                    const r = await step(producer.role, deps.agents[producer.role], ctx)
                    const send = r.toolCalls.find(c => c.name in deps.sendTools)
                    return send ? (send.args[deps.sendTools[send.name]] ?? "") : null
                })()
                memo.set(relayId, v)
                return v
            }
            // A step's replayed context, or null if a message it read no longer exists in this world.
            const contextFor = async (s: StepRecord): Promise<ContextMessage[] | null> => {
                const original = new Map<string, string>()
                const replayed = new Map<string, string>()
                for (const r of s.read) {
                    const text = await textOf(r)
                    if (text === null) return null
                    original.set(r, (p.messages.get(r) as MessageRecord).text)
                    replayed.set(r, text)
                }
                return substitute(s, original, replayed)
            }
            const ctx = await contextFor(p.final.step)
            if (!ctx) return null // the upstream agent no longer asked: no privileged call in this world
            const r = await step(p.final.role, deps.agents[p.final.role], ctx)
            const call = r.toolCalls.find(c => deps.toolToAction[c.name] === op.action)
            return call ? { name: call.name, args: { ...call.args } } : null
        } finally {
            stats.ms += performance.now() - t0
        }
    }
    return Object.assign(sample, { stats: () => ({ ...stats }) })
}
