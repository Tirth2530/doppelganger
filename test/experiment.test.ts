import { describe, expect, test } from "bun:test"

import { attribute, certify, observeRound, startExperiment, verifyCertificate, type ExperimentState } from "../src/experiment.ts"
import { DEFAULT_EXPERIMENT } from "../src/stats.ts"
import type { ExperimentConfig } from "../src/types.ts"
import { KEYS, mulberry32, REAL, twin } from "./helpers.ts"

function run(pBase: number, pControl: number, pTreatment: number, seed: number, config: ExperimentConfig = DEFAULT_EXPERIMENT): ExperimentState {
    const rand = mulberry32(seed)
    let s = startExperiment(`op-${seed}`, REAL, KEYS, config)
    while (s.verdict === "running") s = observeRound(s, { baseline: twin(rand, pBase), control: twin(rand, pControl), treatment: twin(rand, pTreatment) })
    return s
}

describe("verdicts", () => {
    test("a laundered destination is found influenced, quickly, with the sink attributed", () => {
        for (const seed of [1, 2, 3, 4, 5]) {
            const s = run(0.96, 0.92, 0.05, seed)
            expect(s.verdict).toBe("influenced")
            expect(s.rounds.length).toBeLessThanOrEqual(12)
            const sink = attribute(s).find(a => a.arg === "sink")!
            expect(sink.driven).toBe(true)
            expect(sink.twinValue).toBe("internal://logs/webhooks")
            expect(attribute(s).find(a => a.arg === "service")!.driven).toBe(false)
        }
    })

    test("an action that survives neutralization is robust", () => {
        for (const seed of [1, 2, 3]) expect(run(0.98, 0.97, 0.97, seed).verdict).toBe("robust")
    })

    test("an action that does not even reproduce unchanged is unstable", () => {
        for (const seed of [1, 2, 3]) expect(run(0.2, 0.2, 0.2, seed).verdict).toBe("unstable")
    })

    test("a placebo-sensitive action is inconclusive, and futility stops it well before the budget", () => {
        for (const seed of [1, 2, 3, 4, 5]) {
            const s = run(0.95, 0.25, 0.25, seed)
            expect(s.verdict).toBe("inconclusive")
            expect(s.stoppedFor).toBe("futility")
            expect(s.rounds.length).toBeLessThan(DEFAULT_EXPERIMENT.maxRounds)
        }
    })
})

describe("guarantees", () => {
    test("under the null the false-influenced rate stays under α (Monte Carlo, 600 runs)", () => {
        let influenced = 0
        const N = 600
        for (let seed = 0; seed < N; seed++) if (run(0.95, 0.6, 0.6, 10_000 + seed).verdict === "influenced") influenced++
        expect(influenced / N).toBeLessThanOrEqual(DEFAULT_EXPERIMENT.alpha + 0.02)
    })

    test("futility stopping never makes a false 'influenced' more likely, and saves rounds", () => {
        const off = { ...DEFAULT_EXPERIMENT, futility: false }
        let onInfluenced = 0
        let offInfluenced = 0
        let onRounds = 0
        let offRounds = 0
        for (let seed = 0; seed < 300; seed++) {
            const a = run(0.95, 0.5, 0.5, 20_000 + seed)
            const b = run(0.95, 0.5, 0.5, 20_000 + seed, off)
            if (a.verdict === "influenced") onInfluenced++
            if (b.verdict === "influenced") offInfluenced++
            onRounds += a.rounds.length
            offRounds += b.rounds.length
        }
        expect(onInfluenced).toBeLessThanOrEqual(offInfluenced)
        expect(onRounds).toBeLessThan(offRounds * 0.85)
    })
})

describe("certificates", () => {
    test("a certificate recomputes to the same verdict, and tampering is caught", () => {
        const s = run(0.96, 0.92, 0.05, 7)
        const cert = certify(s)
        expect(verifyCertificate(cert)).toMatchObject({ valid: true, recomputedVerdict: "influenced" })

        const forged = structuredClone(cert)
        forged.verdict = "robust"
        expect(verifyCertificate(forged).valid).toBe(false)

        const edited = structuredClone(cert)
        edited.rounds[0].treatment.call = { ...REAL } // claim the twin had kept the sink
        edited.rounds[0].treatment.reproduced = 1
        expect(verifyCertificate(edited).valid).toBe(false)
    })

    test("rounds drawn after a decision are refused", () => {
        const s = run(0.98, 0.97, 0.97, 3)
        expect(() => observeRound(s, { baseline: REAL, control: REAL, treatment: REAL })).toThrow()
    })
})
