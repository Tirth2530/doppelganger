import { afterAll, describe, expect, test } from "bun:test"

import { hub, type LiveCommand } from "../src/live.ts"
import { startServer } from "../src/server.ts"
import { createSession } from "../src/session.ts"

const received: LiveCommand[] = []
hub.onCommand(c => {
    received.push(c)
})

const session = createSession(5)
const { server } = startServer(0, session)
const base = `http://localhost:${server.port}`
afterAll(() => server.stop(true))

const post = (query: string, token: string | null, body: unknown = {}) =>
    fetch(`${base}/command?${query}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-demo-session": token } : {}) }, body: JSON.stringify(body) })

describe("demo session authorization", () => {
    test("no token: refused", async () => {
        expect((await post("do=revoke", null)).status).toBe(401)
        expect((await post("do=revoke", "forged-token")).status).toBe(401)
    })

    test("the on-call phone can decide, revoke and restore, but cannot start attacks or reset", async () => {
        const t = session.oncallToken
        expect((await post("do=decide", t, { opId: "op-1", approve: false })).status).toBe(200)
        expect((await post("do=revoke", t)).status).toBe(200)
        expect((await post("run=2", t)).status).toBe(403)
        expect((await post("do=say", t, { text: "anything" })).status).toBe(403)
        expect((await post("do=reset", t)).status).toBe(403)
    })

    test("the presenter can do everything", async () => {
        const t = session.presenterToken
        expect((await post("run=2", t)).status).toBe(200)
        expect((await post("do=say", t, { text: "Our logs are attached." })).status).toBe(200)
        expect(received.at(-1)).toEqual({ kind: "say", text: "Our logs are attached." })
    })

    test("malformed commands are refused before authorization", async () => {
        expect((await post("do=say", session.presenterToken, { text: "" })).status).toBe(400)
        expect((await post("do=decide", session.presenterToken, { opId: 7 })).status).toBe(400)
        expect((await post("do=decide", session.presenterToken, { opId: "x", approve: true, corrected: { sink: 1 } })).status).toBe(400)
    })

    test("an expired session is refused", () => {
        const old = createSession(-1)
        expect(old.roleOf(old.presenterToken)).toBeNull()
        expect(old.roleOf(old.oncallToken)).toBeNull()
    })

    test("the presenter token is handed out on this machine only", async () => {
        const r = await fetch(`${base}/session`)
        expect(r.status).toBe(200) // the test client is loopback
        expect((await r.json()).token).toBe(session.presenterToken)
    })
})
