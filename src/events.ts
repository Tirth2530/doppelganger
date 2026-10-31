// The protocol the dashboard renders. The simulation emits it in the browser;
// the live runner emits the same events over /events (src/server.ts).

import { armSummary, attribute, certify, pointTwin, type ExperimentState } from "./experiment.ts"
import { influenceThreshold } from "./stats.ts"
import type { ActionName, ArgAttribution, Arm, ArmSummary, Args, Certificate, CourtState, LedgerPoint, StopReason, ToolCall, Trust } from "./types.ts"
import type { ShadowState } from "./unprotected.ts"

export interface FeedMessage {
    relayId: string
    from: string
    to: string
    trust: Trust
    summary: string
    inputs: string[]
    at: string
}

/** A serializable snapshot of an experiment in progress or decided. */
export interface ExperimentView {
    opId: string
    real: ToolCall
    keyArgs: string[]
    verdict: ExperimentState["verdict"]
    stoppedFor: StopReason | null
    rounds: number
    maxRounds: number
    arms: Record<Arm, ArmSummary>
    eValue: number
    threshold: number
    ledger: LedgerPoint[]
    attribution: ArgAttribution[]
    pointTwin: ToolCall | null
    hops: number
    /** Model calls spent so far: rounds × 3 arms × agents replayed. */
    calls: number
    originRelayId: string
    certificate: Certificate | null
}

export function viewOf(state: ExperimentState, hops: number, originRelayId: string): ExperimentView {
    const decided = state.verdict !== "running" && state.verdict !== "error"
    return {
        opId: state.opId,
        real: state.real,
        keyArgs: state.keyArgs,
        verdict: state.verdict,
        stoppedFor: state.stoppedFor,
        rounds: state.rounds.length,
        maxRounds: state.config.maxRounds,
        arms: { baseline: armSummary(state, "baseline"), control: armSummary(state, "control"), treatment: armSummary(state, "treatment") },
        eValue: state.ev,
        threshold: influenceThreshold(state.config.alpha),
        ledger: state.ledger,
        attribution: attribute(state),
        pointTwin: pointTwin(state),
        hops,
        calls: state.rounds.length * 3 * Math.max(1, hops),
        originRelayId,
        certificate: decided ? certify(state) : null
    }
}

export type UiEvent =
    | { type: "reset"; mode: "simulation" | "live" }
    | { type: "court"; state: CourtState }
    | { type: "message"; message: FeedMessage }
    | { type: "agent"; agent: string; status: "idle" | "thinking" | "acting"; note: string }
    | { type: "invoke"; agent: string; action: ActionName; args: Args; triggerRelayId: string; opId: string }
    | { type: "experiment"; view: ExperimentView }
    | { type: "narrate"; text: string }
    | { type: "busy"; busy: boolean }
    /** The same request, run on the unprotected copy of the system. */
    | { type: "shadow"; state: ShadowState; opId: string | null }
