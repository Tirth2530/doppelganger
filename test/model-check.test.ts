import { describe, expect, test } from "bun:test"

import { check, checkImpl, IMPLEMENTATIONS, SCENARIOS } from "../src/model-check.ts"

const impl = (id: string) => IMPLEMENTATIONS.find(i => i.id === id)!
const scenario = (id: string) => SCENARIOS.find(s => s.id === id)!

describe("model checker", () => {
    test("the shipped Court holds every invariant in every scenario", () => {
        const r = checkImpl(impl("court"))
        expect(r.invariants.every(i => i.held)).toBe(true)
        expect(r.states).toBeGreaterThan(20_000)
        expect(r.invariants.map(i => i.id)).toContain("authorized")
    }, 60_000)

    test("trusting the last hop lets a laundered request through on submission", () => {
        const r = check(impl("last-hop"), scenario("laundered-retries"))
        expect(r.counterexamples[0].invariant).toBe("laundering")
        expect(r.counterexamples[0].steps).toHaveLength(1)
    })

    test("an unserialized verdict lets a revoke slip between check and write", () => {
        const r = check(impl("interleaved"), scenario("laundered-retries"))
        const cx = r.counterexamples.find(c => c.invariant === "revocation")!
        expect(cx.steps.map(s => s.event).join(" | ")).toMatch(/checked, then awaiting.*revokes.*finishes writing/)
    })

    test("trusting the worker's epoch lets revoke-then-restore launder a stale verdict", () => {
        const r = check(impl("trust-worker-epoch"), scenario("laundered-retries"))
        expect(r.counterexamples.some(c => c.invariant === "revocation")).toBe(true)
    })

    test("missing guards are caught: no commit fence, no state guard", () => {
        expect(check(impl("no-commit-fence"), scenario("laundered-retries")).counterexamples.some(c => c.invariant === "authority")).toBe(true)
        expect(check(impl("no-state-guard"), scenario("laundered-retries")).counterexamples.some(c => c.invariant === "transitions")).toBe(true)
    })

    test("approval that checks only general scope is caught: an unauthorized destination executes", () => {
        const r = check(impl("scope-only-approval"), scenario("instant-hold"))
        const cx = r.counterexamples.find(c => c.invariant === "authorized")
        expect(cx).toBeTruthy()
    })

    test("…and an operation held before a revoke executes under authority restored afterwards", () => {
        // Only the human's corrected (internal) destination: the case authorization covers the arguments,
        // so the only thing that can be wrong is the epoch it was granted under.
        const r = check(impl("scope-only-approval"), scenario("stale-hold"))
        const cx = r.counterexamples.find(c => c.invariant === "authorized")
        expect(cx).toBeTruthy()
        expect(cx!.steps.map(s => s.event).join(" | ")).toMatch(/restores/)
    })
})
