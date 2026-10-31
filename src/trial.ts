// Where the replay engine plugs into the evidence layer.
//
// YOUR TEAM WRITES `createSampler`. Given an operation under review, return a
// function that, for an arm, replays the chain from the recorded contexts in
// each agent's AgentLog and returns the privileged agent's tool call (or null
// if it made none):
//
//   baseline   replay with the outside message unchanged
//   control    replay with the outside message reworded, instruction KEPT
//              (src/rewrite.ts: paraphrase)
//   treatment  replay with the instruction neutralized, facts kept
//              (src/rewrite.ts: neutralize)
//
// Replay every agent downstream of the outside message (lineage.chain), each
// with the exact system prompt, tools and context it had (src/agents.ts:
// runAgent), substituting only the rewritten message. Sample at the agents'
// normal temperature: identical twins prove nothing.
//
// Everything after the sampler is done: the experiment, futility stopping,
// attribution, value tracing, the certificate. Without a sampler, or if it
// throws, the review fails closed: the operation is held for a human and never
// approved automatically.

import { runExperiment, type ArmSampler, type ExperimentState } from "./experiment.ts"
import type { ActorPorts } from "./ports.ts"
import { errorEvidence, evidenceFromExperiment, KEY_ARGS, traceValues } from "./replay-logic.ts"
import { DEFAULT_EXPERIMENT } from "./stats.ts"
import type { Evidence, ExperimentConfig, MessageRecord, Op, ToolCall } from "./types.ts"

export function createSampler(op: Op, ports: ActorPorts): ArmSampler | null {
    void op
    void ports
    return null // ← replace with your replay engine
}

export interface TrialContext {
    real: ToolCall
    outside: MessageRecord[]
    humanTask: string
    config?: ExperimentConfig
    onRound?: (state: ExperimentState) => void
}

export async function runTrial(op: Op, ctx: TrialContext, sampler: ArmSampler | null): Promise<Evidence> {
    const origin = op.lineage.externalRelayIds[0] ?? ""
    if (!sampler) return errorEvidence(ctx.real, origin, "no replay engine is connected")
    try {
        const state = await runExperiment(op.opId, ctx.real, KEY_ARGS[op.action], sampler, ctx.config ?? DEFAULT_EXPERIMENT, ctx.onRound)
        return evidenceFromExperiment(state, origin, traceValues(op.action, op.args, ctx.outside, ctx.humanTask))
    } catch (error) {
        return errorEvidence(ctx.real, origin, `replay failed: ${String(error)}`)
    }
}
