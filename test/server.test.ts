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

let n = 0
const id = () => `cmd-${Date.now()}-${++n}`
const post = (query: string, token: string | null, body: unknown = {}, commandId: string | null = id()) =>
    fetch(`${base}/command?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-demo-session": token } : {}), ...(commandId ? { "x-command-id": commandId } : {}) },
        body: JSON.stringify(body)
    })

describe("the presenter token never leaves the laptop", () => {
    test("a direct browser on this machine gets it", async () => {
        const r = await fetch(`${base}/session`)
        expect(r.status).toBe(200)
        expect((await r.json()).token).toBe(session.presenterToken)
    })

    test("a request forwarded by a tunnel (cloudflared, ngrok) does not, even though it arrives from 127.0.0.1", async () => {
        for (const headers of [
            { "x-forwarded-for": "203.0.113.9" },
            { "cf-connecting-ip": "203.0.113.9" },
            { forwarded: "for=203.0.113.9" },
            { host: "random-words.trycloudflare.com" }
        ]) {
            const r = await fetch(`${base}/session`, { headers })
            expect(r.status).toBe(403)
        }
    })

    test("rotating the on-call link requires the presenter on this machine", async () => {
        expect((await fetch(`${base}/session/rotate`, { method: "POST", headers: { "x-demo-session": session.oncallToken } })).status).toBe(403)
        expect((await fetch(`${base}/session/rotate`, { method: "POST", headers: { "x-demo-session": session.presenterToken, "x-forwarded-for": "203.0.113.9" } })).status).toBe(403)
    })
})

describe("command authorization", () => {
    test("no token or a forged token: refused", async () => {
        expect((await post("do=revoke", null)).status).toBe(401)
        expect((await post("do=revoke", "forged-token-forged-token")).status).toBe(401)
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

    test("every command needs a fresh id, and a captured command cannot be replayed", async () => {
        const t = session.presenterToken
        expect((await post("do=restore", t, {}, null)).status).toBe(400)
        const once = id()
        expect((await post("do=restore", t, {}, once)).status).toBe(200)
        expect((await post("do=restore", t, {}, once)).status).toBe(409)
    })

    test("malformed commands are refused", async () => {
        expect((await post("do=say", session.presenterToken, { text: "" })).status).toBe(400)
        expect((await post("do=decide", session.presenterToken, { opId: 7 })).status).toBe(400)
        expect((await post("do=decide", session.presenterToken, { opId: "x", approve: true, corrected: { sink: 1 } })).status).toBe(400)
        expect((await post("do=decide", session.presenterToken, { opId: "x", approve: true, corrected: { epoch: "9" } })).status).toBe(400)
    })
})

describe("session lifecycle", () => {
    test("rotation locks out every phone holding the old link", () => {
        const s = createSession(5)
        const old = s.oncallToken
        s.rotateOncall()
        expect(s.roleOf(old)).toBeNull()
        expect(s.roleOf(s.oncallToken)).toBe("oncall")
    })

    test("an expired session admits nothing", () => {
        const s = createSession(-1)
        expect(s.admit(s.presenterToken, "cmd-000000001", { kind: "reset" }).ok).toBe(false)
        expect(s.admit(s.oncallToken, "cmd-000000002", { kind: "revoke" }).ok).toBe(false)
    })

    test("a phone is rate-limited", () => {
        const s = createSession(5)
        const now = Date.now()
        let last: ReturnType<typeof s.admit> = { ok: true, role: "oncall" }
        for (let i = 0; i < 25; i++) last = s.admit(s.oncallToken, `cmd-rate-${i}-xxxx`, { kind: "restore" }, now)
        expect(last).toMatchObject({ ok: false, status: 429 })
        expect(s.admit(s.oncallToken, "cmd-rate-later-x", { kind: "restore" }, now + 11_000).ok).toBe(true)
    })
})
