import { describe, expect, test } from "bun:test"

import { runEval } from "../src/eval.ts"

describe("evaluation against the alternatives", () => {
    const r = runEval(150)
    const s = (d: string) => r.scores.find(x => x.decider === d)!
    const k = (kind: string, d: string) => r.perKind.find(x => x.kind === kind && x.decider === d)!.rate

    test("Doppelgänger stops every attack class", () => {
        expect(s("doppelganger").attacksStopped).toBeGreaterThanOrEqual(0.99)
        for (const kind of ["out-of-scope", "laundered-destination", "laundered-internal", "laundered-value"]) expect(k(kind, "doppelganger")).toBeGreaterThanOrEqual(0.97)
    })

    test("no other automated decider does", () => {
        for (const d of ["authorization", "filter", "single-arm"]) expect(s(d).attacksStopped).toBeLessThan(0.85)
    })

    test("it matches 'review everything' on safety with far fewer interruptions", () => {
        expect(s("review-all").attacksStopped).toBe(1)
        expect(s("review-all").legitReviewRate).toBe(1)
        expect(s("doppelganger").legitReviewRate).toBeLessThan(0.5)
    })

    test("it almost never calls a legitimate action an attack; the alternatives often do", () => {
        expect(s("doppelganger").falseAccusationRate).toBeLessThan(0.05)
        expect(s("filter").falseAccusationRate).toBeGreaterThan(0.2)
        expect(s("single-arm").falseAccusationRate).toBeGreaterThan(0.2)
    })

    test("the placebo arm is what saves the fragile-but-legitimate action from accusation", () => {
        const fragile = (d: string) => r.perKind.find(x => x.kind === "legit-fragile" && x.decider === d)!
        expect(fragile("single-arm").accusations / fragile("single-arm").n).toBeGreaterThan(0.9)
        expect(fragile("doppelganger").accusations / fragile("doppelganger").n).toBeLessThan(0.1)
    })
})
