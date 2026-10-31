import { describe, expect, test } from "bun:test"

import { check, checkImpl, IMPLEMENTATIONS, SCENARIOS } from "../src/model-check.ts"

const impl = (id: string) => IMPLEMENTATIONS.find(i => i.id === id)!
const scenario = (id: string) => SCENARIOS.find(s => s.id === id)!

describe("model checker", () => {
    test("the shipped Court holds every invariant in every scenario", () => {
        const r = checkImpl(impl("court"))
        expect(r.invariants.every(i => i.held)).toBe(true)
        expect(r.states).toBeGreaterThan(40_000)
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
})
