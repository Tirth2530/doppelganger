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
import { KEYS, REAL } from "./helpers.ts"

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
