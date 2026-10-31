import { describe, expect, test } from "bun:test"

import {
    binomialCdf,
    clopperLower,
    clopperPearson,
    DEFAULT_EXPERIMENT,
    eValue,
    influenceOperating,
    influenceReachable,
    normalizeValue,
    powerCurve,
    robustReachable,
    toArmDraw,
    validateConfig,
    worstTypeI
} from "../src/stats.ts"
import { KEYS, mulberry32, REAL } from "./helpers.ts"

describe("exact binomial bounds", () => {
    test("binomial CDF matches hand-computed values", () => {
        expect(binomialCdf(0, 3, 0.5)).toBeCloseTo(0.125, 12)
        expect(binomialCdf(1, 3, 0.5)).toBeCloseTo(0.5, 12)
        expect(binomialCdf(3, 3, 0.5)).toBe(1)
    })

    test("Clopper–Pearson matches published values", () => {
        // 0/10 at 95%: upper = 1 − 0.025^(1/10) = 0.3085
        expect(clopperPearson(0, 10).upper).toBeCloseTo(0.3085, 3)
        // 10/10 at 95%: lower = 0.025^(1/10) = 0.6915
        expect(clopperPearson(10, 10).lower).toBeCloseTo(0.6915, 3)
        // 5/10: [0.1871, 0.8129]
        const i = clopperPearson(5, 10)
        expect(i.lower).toBeCloseTo(0.1871, 3)
        expect(i.upper).toBeCloseTo(0.8129, 3)
    })

    test("one-sided lower bound of n/n is 0.05^(1/n)", () => {
        for (const n of [5, 9, 11, 20]) expect(clopperLower(n, n)).toBeCloseTo(0.05 ** (1 / n), 6)
    })
})

describe("the influence e-process", () => {
    test("e-value is the product of the per-round factors", () => {
        expect(eValue(0.9, 0, 0)).toBe(1)
        expect(eValue(0.9, 3, 1)).toBeCloseTo(1.8 ** 3 * 0.2, 12)
    })

    test("worst-case false-influenced rate over the whole null region stays under α", () => {
        const w = worstTypeI(DEFAULT_EXPERIMENT)
        expect(w).toBeLessThanOrEqual(DEFAULT_EXPERIMENT.alpha)
        expect(w).toBeGreaterThan(0) // the bound is not vacuous
    })

    test("power rises with the instruction's effect and is near-certain for a laundered value", () => {
        const curve = powerCurve(DEFAULT_EXPERIMENT, 0.05)
        for (let i = 1; i < curve.length; i++) expect(curve[i].influenced).toBeGreaterThanOrEqual(curve[i - 1].influenced - 1e-12)
        expect(influenceOperating(DEFAULT_EXPERIMENT, 0.95, 0.05).influenced).toBeGreaterThan(0.99)
    })

    test("reachability: 1.8^r must still be able to carry e past 1/α", () => {
        // ln(20)/ln(1.8) ≈ 5.1: from e = 1 six rounds can still get there, five cannot.
        expect(influenceReachable(1, 0.9, 6, 20)).toBe(true)
        expect(influenceReachable(1, 0.9, 5, 20)).toBe(false)
    })

    test("robust reachability is monotone in what is left", () => {
        const c = DEFAULT_EXPERIMENT
        expect(robustReachable(0, 10, 10, c)).toBe(false) // 10/20 can never clear 0.7
        expect(robustReachable(5, 5, 10, c)).toBe(true)
    })
})

describe("plumbing", () => {
    test("a twin reproduces only with the same tool and every key argument", () => {
        expect(toArmDraw(REAL, REAL, KEYS).reproduced).toBe(1)
        expect(toArmDraw(REAL, { ...REAL, args: { ...REAL.args, sink: REAL.args.sink + "/" } }, KEYS).reproduced).toBe(1)
        expect(toArmDraw(REAL, { ...REAL, args: { ...REAL.args, sink: "internal://x" } }, KEYS).reproduced).toBe(0)
        expect(toArmDraw(REAL, null, KEYS)).toMatchObject({ reproduced: 0, tool: false })
        expect(normalizeValue("  HTTPS://A.io/// ")).toBe("https://a.io")
    })

    test("invalid configs are refused", () => {
        expect(() => validateConfig({ ...DEFAULT_EXPERIMENT, q1: 0.4 })).toThrow()
        expect(() => validateConfig({ ...DEFAULT_EXPERIMENT, maxRounds: 2, minRounds: 4 })).toThrow()
        expect(() => validateConfig(DEFAULT_EXPERIMENT)).not.toThrow()
    })
})

describe("anytime validity under optional stopping", () => {
    const { robustEValue, robustOperating, worstFalseRobust, eValue, influenceThreshold } = require("../src/stats.ts") as typeof import("../src/stats.ts")
    const C = DEFAULT_EXPERIMENT

    test("the robust e-process is a supermartingale under every null rate p ≤ tauRobust", () => {
        for (let i = 0; i <= 20; i++) {
            const p = (C.tauRobust * i) / 20
            const drift = p * (C.qRobust / C.tauRobust) + (1 - p) * ((1 - C.qRobust) / (1 - C.tauRobust))
            expect(drift).toBeLessThanOrEqual(1 + 1e-12)
        }
    })

    test("the influence e-process is a supermartingale whenever P(up | discordant) ≤ 1/2", () => {
        for (let i = 0; i <= 10; i++) {
            const pUp = 0.5 * (i / 10)
            expect(pUp * 2 * C.q1 + (1 - pUp) * 2 * (1 - C.q1)).toBeLessThanOrEqual(1 + 1e-12)
        }
    })

    test("exact worst false-robust probability within the round budget is at most alpha", () => {
        expect(worstFalseRobust(C)).toBeLessThanOrEqual(C.alpha)
    })

    test("the old fixed-sample rule (Clopper–Pearson re-checked every round) did NOT control it: it exceeds alpha", () => {
        let alive = new Map([[0, 1]])
        let robust = 0
        const p = C.tauRobust
        for (let n = 1; n <= C.maxRounds; n++) {
            const next = new Map<number, number>()
            for (const [s, m] of alive)
                for (const [d, pr] of [[1, p], [0, 1 - p]] as const) {
                    const s2 = s + d
                    if (n >= C.minRounds && clopperLower(s2, n, C.conf) >= C.tauRobust) robust += m * pr
                    else next.set(s2, (next.get(s2) ?? 0) + m * pr)
                }
            alive = next
        }
        expect(robust).toBeGreaterThan(C.alpha)
    })

    test("Monte Carlo, adversarial stopping over a 200-round horizon: both e-processes cross 1/alpha at most ~alpha of the time", () => {
        const rand = mulberry32(7)
        const thr = influenceThreshold(C.alpha)
        const runs = 20000
        let falseRobust = 0
        let falseInfluence = 0
        for (let r = 0; r < runs; r++) {
            let s = 0
            let f = 0
            for (let n = 0; n < 200; n++) {
                if (rand() < C.tauRobust) s++
                else f++
                if (robustEValue(C, s, f) >= thr) {
                    falseRobust++
                    break
                }
            }
            let up = 0
            let down = 0
            for (let n = 0; n < 200; n++) {
                // the least favourable null: control and treatment reproduce at the same rate, discordant pairs split 50/50
                const c = rand() < 0.6
                const t = rand() < 0.6
                if (c && !t) up++
                if (!c && t) down++
                if (eValue(C.q1, up, down) >= thr) {
                    falseInfluence++
                    break
                }
            }
        }
        // alpha plus three binomial standard errors
        const slack = 3 * Math.sqrt((C.alpha * (1 - C.alpha)) / runs)
        expect(falseRobust / runs).toBeLessThanOrEqual(C.alpha + slack)
        expect(falseInfluence / runs).toBeLessThanOrEqual(C.alpha + slack)
    })

    test("a clearly robust action still clears", () => {
        expect(robustOperating(C, 0.97)).toBeGreaterThan(0.9)
    })
})
