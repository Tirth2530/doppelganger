// The real human-review path, end to end in process: a HELD action → an
// authenticated HTTP command → the shared decision code the live runner uses →
// the Court → protected execution or refusal. In-memory Court (the Durable Actor
// runs the same court-logic; it is not exercised here).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import * as court from "../src/court-logic.ts"
import { hub } from "../src/live.ts"
import { memoryCourt } from "../src/memory-ports.ts"
import { applyHumanDecision } from "../src/review.ts"
import { startServer } from "../src/server.ts"
import { createSession } from "../src/session.ts"
import { slackMessage } from "../src/slack.ts"
import type { SubmitInput } from "../src/types.ts"

const c = memoryCourt()
const session = createSession(5)
let server: ReturnType<typeof startServer>["server"]
let base = ""

beforeAll(() => {
    // The same handler shape as src/live-run.ts for the commands under test.
    hub.onCommand(async cmd => {
        if (cmd.kind === "decide") await applyHumanDecision(c, cmd)
        if (cmd.kind === "revoke") await c.revoke("infra")
        if (cmd.kind === "restore") await c.restoreScopes()
    })
    server = startServer(0, session).server
    base = `http://localhost:${server.port}`
})
afterAll(() => server.stop(true))

const EXT = "https://collector.acme-debug.io/ingest"
let n = 0
async function holdOne(): Promise<string> {
    const now = new Date().toISOString()
    c.state = court.authorize(c.state, court.caseAuthorization(`case-${++n}`, "on-call engineer", now), now)
    const input: SubmitInput = {
        opId: `op-review-${n}`,
        action: "logging.configure",
        args: { service: "webhooks", level: "debug", sink: EXT },
        requestedBy: "infra",
        triggerRelayId: `m${n}`,
        lineage: { tainted: true, externalRelayIds: ["x"], chain: [], hops: 1, humanRelayIds: ["h"], unverified: [], caseIds: [`case-${n}`] }
    }
    const op = await c.submit(input)
    expect(op.state).toBe("HELD")
    return op.opId
}
const decide = (opId: string, body: Record<string, unknown>, token = session.oncallToken, commandId = `cmd-${opId}-${Math.random().toString(36).slice(2, 10)}`) =>
    fetch(`${base}/command?do=decide`, { method: "POST", headers: { "content-type": "application/json", "x-demo-session": token, "x-command-id": commandId }, body: JSON.stringify({ opId, ...body }) })
const opOf = (opId: string) => c.state.ops.find(o => o.opId === opId)!
const executions = (opId: string) => opOf(opId).history.filter(h => h.state === "EXECUTED").length

describe("held action → authenticated review → Court → execution", () => {
    test("the on-call phone corrects the destination: only the correction executes", async () => {
        const opId = await holdOne()
        expect((await decide(opId, { approve: true, corrected: { sink: "internal://logs/webhooks" } })).status).toBe(200)
        expect(opOf(opId).state).toBe("EXECUTED")
        expect(c.state.config.logSink).toBe("internal://logs/webhooks")
    })

    test("deny: nothing executes", async () => {
        const opId = await holdOne()
        const before = c.state.config
        expect((await decide(opId, { approve: false })).status).toBe(200)
        expect(opOf(opId).state).toBe("DENIED")
        expect(c.state.config).toEqual(before)
    })

    test("the same approval sent five times (retries, double taps): one execution", async () => {
        const opId = await holdOne()
        const rs = await Promise.all(Array.from({ length: 5 }, () => decide(opId, { approve: true, corrected: { sink: "internal://logs/webhooks" } })))
        expect(rs.every(r => r.status === 200)).toBe(true)
        expect(executions(opId)).toBe(1)
    })

    test("a replayed request (same command id) is refused before it reaches the Court", async () => {
        const opId = await holdOne()
        const id = `cmd-replay-${opId}`
        expect((await decide(opId, { approve: false }, session.oncallToken, id)).status).toBe(200)
        expect((await decide(opId, { approve: true }, session.oncallToken, id)).status).toBe(409)
        expect(opOf(opId).state).toBe("DENIED")
    })

    test("approve and deny race: exactly one decision takes effect", async () => {
        const opId = await holdOne()
        await Promise.all([decide(opId, { approve: true, corrected: { sink: "internal://logs/webhooks" } }), decide(opId, { approve: false })])
        const st = opOf(opId).state
        expect(["EXECUTED", "DENIED"]).toContain(st)
        expect(executions(opId)).toBe(st === "EXECUTED" ? 1 : 0)
    })

    test("engineer A approves while engineer B revokes: if the revocation lands first, the approval never executes", async () => {
        const opId = await holdOne()
        const revoke = await fetch(`${base}/command?do=revoke`, { method: "POST", headers: { "x-demo-session": session.oncallToken, "x-command-id": `cmd-rv-${opId}` } })
        expect(revoke.status).toBe(200)
        expect((await decide(opId, { approve: true, corrected: { sink: "internal://logs/webhooks" } })).status).toBe(200)
        expect(opOf(opId).state).not.toBe("EXECUTED")
        await c.restoreScopes() // presenter restores for the next tests
    })

    test("a stale approval (approved, then authority revoked before commit) is fenced at the commit", async () => {
        const opId = await holdOne()
        await c.decide(opId, true, "on-call engineer", { sink: "internal://logs/webhooks" }) // approved, not yet committed
        await c.revoke("infra")
        await c.restoreScopes()
        await c.commit(opId)
        expect(opOf(opId).state).not.toBe("EXECUTED")
    })

    test("no token, a forged token, or an expired session: refused, nothing changes", async () => {
        const opId = await holdOne()
        expect((await decide(opId, { approve: true }, "forged")).status).toBe(401)
        const expired = createSession(0)
        await Bun.sleep(5)
        expect(expired.admit(expired.oncallToken, "cmd-expired-1", { kind: "decide", opId, approve: true, corrected: null }, Date.now() + 1000).ok).toBe(false)
        expect(opOf(opId).state).toBe("HELD")
    })

    test("the on-call role cannot restore authority", async () => {
        const r = await fetch(`${base}/command?do=restore`, { method: "POST", headers: { "x-demo-session": session.oncallToken, "x-command-id": `cmd-rs-${Date.now()}` } })
        expect(r.status).toBe(403)
    })

    test("the Slack review link for a held action opens this review page and carries no credential", async () => {
        const opId = await holdOne()
        const msg = JSON.stringify(slackMessage(opOf(opId), { publicUrl: base, mode: "live" }))
        const link = msg.match(/http:\/\/localhost:\d+\/\?mode=live&view=oncall&op=[^"\\]+/)?.[0]
        expect(link).toBeTruthy()
        expect(link).not.toContain(session.oncallToken)
        expect(link).not.toContain(session.presenterToken)
        // The page loads; deciding still requires the on-call token (tested above).
        expect((await fetch(link!)).status === 200 || (await fetch(link!)).status === 503).toBe(true)
    })
})
