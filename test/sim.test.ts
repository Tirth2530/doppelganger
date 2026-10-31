import { describe, expect, test } from "bun:test"

import { INTERNAL_DEFAULT_SINK } from "../src/court-logic.ts"
import type { ExperimentView, UiEvent } from "../src/events.ts"
import { verifyCertificate } from "../src/experiment.ts"
import { Simulation } from "../src/sim.ts"
import type { CourtState } from "../src/types.ts"

const SEEDS = [1, 2, 3, 31, 99]

function harness(seed = 31) {
    const events: UiEvent[] = []
    const sim = new Simulation(e => events.push(e), { seed, speed: 1e5 })
    const court = (): CourtState => [...events].reverse().find((e): e is Extract<UiEvent, { type: "court" }> => e.type === "court")!.state
    const view = (): ExperimentView | null => [...events].reverse().find((e): e is Extract<UiEvent, { type: "experiment" }> => e.type === "experiment")?.view ?? null
    sim.reset()
    return { sim, court, view }
}

describe("the six demo cases", () => {
    test("0: the human's own request executes with no experiment", async () => {
        const { sim, court, view } = harness()
        await sim.runBeat(0)
        expect(court().ops[0].state).toBe("EXECUTED")
        expect(view()).toBeNull()
    })

    test("1: out of scope is denied by the safety layer alone", async () => {
        const { sim, court, view } = harness()
        await sim.runBeat(1)
        expect(court().ops[0]).toMatchObject({ state: "DENIED" })
        expect(court().ops[0].reason).toMatch(/^authorization/)
        expect(view()).toBeNull()
    })

    test("2: laundered through a teammate → influenced, held, certified; the human's correction is what executes", async () => {
        for (const seed of SEEDS) {
            const { sim, court, view } = harness(seed)
            await sim.runBeat(2)
            const op = court().ops[0]
            expect(op.state).toBe("HELD")
            expect(view()!.verdict).toBe("influenced")
            expect(view()!.attribution.find(a => a.arg === "sink")!.driven).toBe(true)
            expect(verifyCertificate(view()!.certificate!).valid).toBe(true)
            sim.decide(op.opId, true, { sink: INTERNAL_DEFAULT_SINK })
            expect(court().ops[0].state).toBe("EXECUTED")
            expect(court().config.logSink).toBe(INTERNAL_DEFAULT_SINK)
        }
    })

    test("3: a fragile action is inconclusive, stopped early for futility, held, never accused", async () => {
        for (const seed of SEEDS) {
            const { sim, court, view } = harness(seed)
            await sim.runBeat(3)
            expect(court().ops[0].state).toBe("HELD")
            expect(view()!.verdict).toBe("inconclusive")
            expect(view()!.stoppedFor).toBe("futility")
            expect(view()!.rounds).toBeLessThan(20)
        }
    })

    test("4: legitimate from an outside-touched history is cleared with no human", async () => {
        for (const seed of SEEDS) {
            const { sim, court, view } = harness(seed)
            await sim.runBeat(4)
            expect(court().ops[0].state).toBe("EXECUTED")
            expect(view()!.verdict).toBe("robust")
        }
    })

    test("5: revoked mid-review → the evidence says robust, the fence says no", async () => {
        for (const seed of SEEDS) {
            const { sim, court, view } = harness(seed)
            await sim.runBeat(5)
            expect(view()!.verdict).toBe("robust")
            expect(court().ops[0].state).toBe("DENIED")
            expect(court().ops[0].reason).toContain("stale verdict")
            expect(court().config.logSink).toBe(INTERNAL_DEFAULT_SINK)
        }
    })
})
