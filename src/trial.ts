// Where the replay engine plugs into the evidence layer.
//
// createSampler builds the counterfactual sampler for an operation under review
// (src/replay.ts): it replays every agent downstream of the outside message
// from its recorded context, three ways (unchanged / paraphrased with the
// request kept / neutralized), with the same specs and model settings the live
// agents used, and returns the privileged agent's replayed tool call. It never
// writes to Relay or to any actor.
//
// Everything after the sampler is the experiment: futility stopping,
// attribution, value tracing, the certificate. With no sampler (no model key),
// or if the replay throws (missing record, model failure, timeout, budget), the
// review fails closed: the operation is held for a human and never approved
// automatically.

import { runAgent, settingsFromEnv } from "./agents.ts"
import { runExperiment, type ArmSampler, type ExperimentState } from "./experiment.ts"
import type { ActorPorts } from "./ports.ts"
import { createReplaySampler, type ReplayDeps, type ReplayStats } from "./replay.ts"
import { errorEvidence, evidenceFromExperiment, KEY_ARGS, traceValues } from "./replay-logic.ts"
import { NEUTRALIZE, PARAPHRASE, rewrite } from "./rewrite.ts"
import { INFRA, SUPPORT, TOOL_TO_ACTION } from "./scenario.ts"
import { DEFAULT_EXPERIMENT } from "./stats.ts"
import type { Evidence, ExperimentConfig, MessageRecord, Op, ToolCall } from "./types.ts"

export type Sampler = ArmSampler & { stats?: () => ReplayStats }

/** The live replay deps: the real agents' specs and the real model, from the environment. */
export function liveReplayDeps(env: Record<string, string | undefined> = process.env): ReplayDeps | null {
    if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) return null
    const settings = settingsFromEnv(env)
    return {
        model: (spec, context) => runAgent(spec, context, { settings }),
        rewrite: (arm, text) => rewrite(arm === "control" ? PARAPHRASE : NEUTRALIZE, text),
        agents: { support: SUPPORT, infra: INFRA },
        toolToAction: TOOL_TO_ACTION,
        sendTools: { message_infra: "text" },
        maxModelCalls: Number(env.REPLAY_MAX_MODEL_CALLS || 400),
        deadlineMs: Number(env.REPLAY_DEADLINE_MS || 180_000),
        settings: { model: settings.model, temperature: settings.temperature, reasoningEffort: settings.reasoningEffort }
    }
}

export function createSampler(op: Op, ports: ActorPorts, deps: ReplayDeps | null = liveReplayDeps()): Sampler | null {
    return deps ? createReplaySampler(op, ports, deps) : null
}

export interface TrialContext {
    real: ToolCall
    outside: MessageRecord[]
    humanTask: string
    config?: ExperimentConfig
    onRound?: (state: ExperimentState) => void
}

export async function runTrial(op: Op, ctx: TrialContext, sampler: Sampler | null): Promise<Evidence> {
    const origin = op.lineage.externalRelayIds[0] ?? ""
    if (!sampler) return errorEvidence(ctx.real, origin, "no replay engine is connected (set OPENAI_API_KEY and OPENAI_MODEL)")
    const cost = (): Evidence["replay"] => {
        const s = sampler.stats?.()
        return s && { modelCalls: s.modelCalls, rewriteCalls: s.rewriteCalls, promptTokens: s.promptTokens, completionTokens: s.completionTokens, ms: Math.round(s.ms), model: s.settings?.model }
    }
    try {
        const state = await runExperiment(op.opId, ctx.real, KEY_ARGS[op.action], sampler, ctx.config ?? DEFAULT_EXPERIMENT, ctx.onRound)
        return { ...evidenceFromExperiment(state, origin, traceValues(op.action, op.args, ctx.outside, ctx.humanTask)), replay: cost() }
    } catch (error) {
        return { ...errorEvidence(ctx.real, origin, `replay failed, held for a human: ${(error as Error)?.message ?? String(error)}`), replay: cost() }
    }
}
