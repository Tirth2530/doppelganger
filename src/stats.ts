// The statistics behind the evidence layer.
//
// Influence test. Each round pairs a control twin (instruction kept, wording
// changed) with a treatment twin (instruction neutralized, wording changed).
// Only disagreeing rounds carry information: "up" when control keeps the action
// and treatment drops it, "down" for the reverse. Under the null "the
// instruction has no specific effect", up is no more likely than down, so
//
//     E_n = (2·q1)^up · (2·(1 − q1))^down
//
// has expectation ≤ 1 at every step: a non-negative supermartingale. Ville's
// inequality then gives P(sup_n E_n ≥ 1/α) ≤ α. The bound holds at ANY stopping
// round, which is what lets the court stop as soon as the evidence is in, and
// stop early for futility, without paying for it.

import type { ArmDraw, ExperimentConfig, Interval, ToolCall } from "./types.ts"

export const DEFAULT_EXPERIMENT: ExperimentConfig = {
    q1: 0.9,
    alpha: 0.05,
    conf: 0.95,
    tauBase: 0.8,
    tauRobust: 0.7,
    minRounds: 4,
    maxRounds: 20,
    futility: true
}

export function validateConfig(c: ExperimentConfig): void {
    const ok =
        c.q1 > 0.5 &&
        c.q1 < 1 &&
        c.alpha > 0 &&
        c.alpha < 1 &&
        c.conf > 0 &&
        c.conf < 1 &&
        c.tauBase > 0 &&
        c.tauBase <= 1 &&
        c.tauRobust > 0 &&
        c.tauRobust <= 1 &&
        Number.isInteger(c.minRounds) &&
        Number.isInteger(c.maxRounds) &&
        c.minRounds >= 1 &&
        c.maxRounds >= c.minRounds
    if (!ok) throw new Error(`invalid experiment config ${JSON.stringify(c)}`)
}

/** Values compare after trimming, lower-casing and dropping trailing slashes. */
export function normalizeValue(value: string | undefined): string {
    return (value ?? "").trim().toLowerCase().replace(/\/+$/, "")
}

/** Reduces a twin's call to what the test needs. */
export function toArmDraw(real: ToolCall, twin: ToolCall | null, keyArgs: string[]): ArmDraw {
    const tool = twin !== null && twin.name === real.name
    const args: Record<string, boolean> = {}
    for (const k of keyArgs) args[k] = tool && normalizeValue(twin?.args[k]) === normalizeValue(real.args[k])
    return { reproduced: tool && keyArgs.every(k => args[k]) ? 1 : 0, tool, args, call: twin }
}

export const influenceThreshold = (alpha: number): number => 1 / alpha

export function influenceFactor(q1: number, z: 0 | 1): number {
    return z === 1 ? 2 * q1 : 2 * (1 - q1)
}

export function eValue(q1: number, up: number, down: number): number {
    return Math.exp(up * Math.log(2 * q1) + down * Math.log(2 * (1 - q1)))
}

/** The most the e-process can still grow: every remaining round disagrees upward. */
export function influenceReachable(ev: number, q1: number, remaining: number, threshold: number): boolean {
    return Math.log(ev) + remaining * Math.log(2 * q1) >= Math.log(threshold) - 1e-12
}

// ---- exact binomial bounds ---------------------------------------------------

function logChoose(n: number, k: number): number {
    let s = 0
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i)
    return s
}

export function binomialCdf(k: number, n: number, p: number): number {
    if (k < 0) return 0
    if (k >= n) return 1
    if (p <= 0) return 1
    if (p >= 1) return 0
    let s = 0
    for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))
    return Math.min(1, s)
}

function bisect(f: (p: number) => number, target: number, increasing: boolean): number {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2
        const v = f(mid)
        if (increasing ? v < target : v > target) lo = mid
        else hi = mid
    }
    return (lo + hi) / 2
}

/** Exact two-sided Clopper–Pearson interval. */
export function clopperPearson(successes: number, n: number, confidence = 0.95): Interval {
    if (n === 0) return { lower: 0, upper: 1 }
    const tail = (1 - confidence) / 2
    const lower = successes === 0 ? 0 : bisect(p => 1 - binomialCdf(successes - 1, n, p), tail, true)
    const upper = successes === n ? 1 : bisect(p => binomialCdf(successes, n, p), tail, false)
    return { lower, upper }
}

/** Exact one-sided lower confidence bound. */
export function clopperLower(successes: number, n: number, confidence = 0.95): number {
    if (n === 0 || successes === 0) return 0
    return bisect(p => 1 - binomialCdf(successes - 1, n, p), 1 - confidence, true)
}

/** Exact one-sided upper confidence bound. */
export function clopperUpper(successes: number, n: number, confidence = 0.95): number {
    if (n === 0 || successes === n) return 1
    return bisect(p => binomialCdf(successes, n, p), 1 - confidence, false)
}

/** Could the treatment arm still clear the robust bar if every remaining twin reproduced? */
export function robustReachable(treatmentReproduced: number, n: number, remaining: number, config: ExperimentConfig): boolean {
    return clopperLower(treatmentReproduced + remaining, n + remaining, config.conf) >= config.tauRobust
}

// ---- operating characteristic ---------------------------------------------

export interface InfluenceOperating {
    pControl: number
    pTreatment: number
    /** P(the influence e-process crosses 1/α within maxRounds). An upper bound on P(declared influenced). */
    influenced: number
}

/**
 * Exact, by dynamic programming over (up, down) counts. It tracks only the
 * influence path, so it upper-bounds the real rule, which also stops for
 * robustness, instability and futility (each of which can only lower it).
 */
export function influenceOperating(config: ExperimentConfig, pControl: number, pTreatment: number): InfluenceOperating {
    const thr = influenceThreshold(config.alpha)
    const up = pControl * (1 - pTreatment)
    const down = (1 - pControl) * pTreatment
    const tie = 1 - up - down
    let alive = new Map<string, number>([["0,0", 1]])
    let influenced = 0
    for (let n = 1; n <= config.maxRounds; n++) {
        const next = new Map<string, number>()
        const add = (a: number, b: number, mass: number) => {
            if (mass <= 0) return
            const key = `${a},${b}`
            next.set(key, (next.get(key) ?? 0) + mass)
        }
        for (const [key, mass] of alive) {
            const [a, b] = key.split(",").map(Number)
            add(a, b, mass * tie)
            if (up > 0) {
                if (eValue(config.q1, a + 1, b) >= thr - 1e-12) influenced += mass * up
                else add(a + 1, b, mass * up)
            }
            add(a, b + 1, mass * down)
        }
        alive = next
    }
    return { pControl, pTreatment, influenced }
}

/** Worst false-"influenced" rate over the whole null region (control no likelier than treatment). */
export function worstTypeI(config: ExperimentConfig, grid = 30): number {
    let worst = 0
    for (let i = 0; i <= grid; i++) {
        const pt = i / grid
        for (let j = 0; j <= i; j++) worst = Math.max(worst, influenceOperating(config, j / grid, pt).influenced)
    }
    return worst
}

/** Detection probability as the control rate rises, with the treatment rate pinned. */
export function powerCurve(config: ExperimentConfig, pTreatment: number, points = 41): InfluenceOperating[] {
    return Array.from({ length: points }, (_, i) => influenceOperating(config, i / (points - 1), pTreatment))
}
