import { describe, expect, test } from "bun:test"

import * as court from "../src/court-logic.ts"
import { slackMessage, slackNotifier } from "../src/slack.ts"
import type { CourtState, SubmitInput } from "../src/types.ts"

const T = new Date().toISOString()
const held = (): CourtState => {
    const s = court.authorize(court.initialState(), court.caseAuthorization("c1", "oncall", T), T)
    const input: SubmitInput = {
        opId: "op-abc",
        action: "logging.configure",
        args: { service: "webhooks", level: "debug", sink: "https://collector.acme-debug.io/ingest" },
        requestedBy: "infra",
        triggerRelayId: "m1",
        lineage: { tainted: true, externalRelayIds: ["m0"], chain: ["m1", "h1", "m0"], hops: 1, humanRelayIds: ["h1"], unverified: [], caseIds: ["c1"] }
    }
    const t = court.submit(s, input, T)
    expect(t.op.state).toBe("HELD")
    return t.state
}

function fakeFetch(responses: (number | "hang" | "throw")[]) {
    const calls: { url: string; body: string }[] = []
    const impl = (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) })
        const r = responses[Math.min(calls.length - 1, responses.length - 1)]
        if (r === "throw") throw new Error("ECONNREFUSED")
        if (r === "hang") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))
        return new Response("", { status: r })
    }) as unknown as typeof fetch
    return { impl, calls }
}

const opts = (impl: typeof fetch, extra = {}) => ({ webhookUrl: "https://hooks.slack.com/services/T/B/x", publicUrl: "https://demo.example", mode: "live" as const, fetchImpl: impl, timeoutMs: 50, ...extra })

describe("Slack review notifications", () => {
    test("one message per newly held operation, however often the Court state is observed", async () => {
        const f = fakeFetch([200])
        const n = slackNotifier(opts(f.impl))
        const s = held()
        n.observe(s)
        n.observe(s)
        n.observe(s)
        await n.flush()
        expect(f.calls).toHaveLength(1)
        expect(n.status.get("op-abc")).toBe("sent")
    })

    test("the message carries what the reviewer needs, and the review link carries no credential", () => {
        const op = held().ops[0]
        const m = slackMessage(op, { publicUrl: "https://demo.example", mode: "live" })
        const text = JSON.stringify(m)
        expect(text).toContain("Doppelgänger Security Review")
        expect(text).toContain("collector.acme-debug.io")
        expect(text).toContain("External party → Support → infra")
        expect(text).toContain("Case ID")
        expect(text).toContain("c1")
        expect(text).toContain("https://demo.example/?mode=live&view=oncall&op=op-abc")
        expect(text).not.toMatch(/[?&]t=/)
    })

    test("credential-like arguments are shortened", () => {
        const op = { ...held().ops[0], action: "access.grant" as const, args: { service: "webhooks", environment: "production", public_key: `ssh-ed25519 ${"A".repeat(120)}` } }
        expect(JSON.stringify(slackMessage(op, { publicUrl: "x", mode: "live" }))).not.toContain("A".repeat(40))
    })

    test("a rehearsal on the simulation is labelled as such", () => {
        expect(JSON.stringify(slackMessage(held().ops[0], { publicUrl: "x", mode: "simulation" }))).toContain("[SIMULATION]")
    })

    test("server errors are retried with backoff; a 4xx is not", async () => {
        const retry = fakeFetch([500, 503, 200])
        const a = slackNotifier(opts(retry.impl))
        a.observe(held())
        await a.flush()
        expect(retry.calls).toHaveLength(3)
        expect(a.status.get("op-abc")).toBe("sent")

        const bad = fakeFetch([404])
        const b = slackNotifier(opts(bad.impl))
        b.observe(held())
        await b.flush()
        expect(bad.calls).toHaveLength(1)
        expect(b.status.get("op-abc")).toBe("failed: HTTP 404")
    })

    test("timeouts and network errors end in a recorded failure, never an exception, and the action stays held", async () => {
        for (const r of ["hang", "throw"] as const) {
            const f = fakeFetch([r])
            const n = slackNotifier(opts(f.impl, { attempts: 2 }))
            const s = held()
            n.observe(s)
            await n.flush()
            expect(n.status.get("op-abc")).toMatch(/^failed: (timeout|network error)$/)
            expect(s.ops[0].state).toBe("HELD")
        }
    })

    test("not configured: nothing is sent and nothing else changes", async () => {
        const f = fakeFetch([200])
        const n = slackNotifier({ publicUrl: "x", mode: "live", fetchImpl: f.impl })
        n.observe(held())
        await n.flush()
        expect(n.enabled).toBe(false)
        expect(f.calls).toHaveLength(0)
    })
})
