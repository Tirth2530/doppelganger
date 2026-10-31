// Serves the dashboard and streams the live runner's events.
//   bun run start            dashboard only (simulation in the browser, no keys)
//   bun run demo             simulation on this laptop; phones can join
//   bun run live             live runner + this server; open /?mode=live
//
// Commands are authenticated, authorized per role, single-use and rate-limited
// (src/session.ts). The presenter token is only ever handed to a page loaded on
// this laptop itself, never through a tunnel.

import { readFileSync } from "node:fs"

import type { UiEvent } from "./events.ts"
import { hub, parseCommand } from "./live.ts"
import { redactArgs } from "./slack.ts"
import { createSession, isLocalRequest, type Session } from "./session.ts"

/**
 * What a phone may see. No raw message text (outside content), no agent notes, no Relay event details, and
 * credential-like arguments shortened. The Court state it needs to decide stays.
 */
export function forOncall(e: UiEvent): UiEvent | null {
    if (e.type === "message" || e.type === "agent" || e.type === "relay" || e.type === "experiment") return null
    if (e.type === "court") return { ...e, state: { ...e.state, ops: e.state.ops.map(o => ({ ...o, args: redactArgs(o.args), evidence: o.evidence ? { ...o.evidence, certificate: null, valueProvenance: [] } : null })) } }
    if (e.type === "invoke") return { ...e, args: redactArgs(e.args) }
    if (e.type === "shadow") return { ...e, state: { ...e.state, config: { ...e.state.config, prodAccessKeys: e.state.config.prodAccessKeys.map(k => redactArgs({ key: k }).key) }, executed: [] } }
    return e
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

export function startServer(port = Number(process.env.PORT ?? 3000), session: Session = createSession()) {
    const server = Bun.serve({
        port,
        idleTimeout: 0,
        async fetch(req, srv) {
            const url = new URL(req.url)
            const local = isLocalRequest(req, srv.requestIP(req)?.address)

            if (url.pathname === "/events") {
                // EventSource cannot send headers, so the token rides in the query (pages set no-referrer).
                const role = session.roleOf(url.searchParams.get("t"))
                if (!role) return json({ error: "missing or expired demo session" }, 401)
                let unsubscribe = () => {}
                const stream = new ReadableStream({
                    start(controller) {
                        const enc = new TextEncoder()
                        unsubscribe = hub.subscribe(e => {
                            const out = role === "oncall" ? forOncall(e) : e
                            if (out) controller.enqueue(enc.encode(`data: ${JSON.stringify(out)}\n\n`))
                        })
                    },
                    cancel() {
                        unsubscribe()
                    }
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
            }

            if (url.pathname === "/session") {
                if (!local) return json({ error: "the presenter session is only available on the presenter's laptop" }, 403)
                return json({ token: session.presenterToken, expiresAt: session.expiresAt, joinUrls: session.joinUrls(server.port) })
            }

            // Lock out every phone holding the current on-call link, and issue a new one.
            if (url.pathname === "/session/rotate" && req.method === "POST") {
                if (!local || session.roleOf(req.headers.get("x-demo-session")) !== "presenter") return json({ error: "only the presenter, on the presenter's laptop, can rotate the on-call link" }, 403)
                session.rotateOncall()
                return json({ joinUrls: session.joinUrls(server.port) })
            }

            if (url.pathname === "/command" && req.method === "POST") {
                const body = await req.json().catch(() => ({}))
                const command = parseCommand(url, body)
                if (!command) return json({ error: "bad command" }, 400)
                const admission = session.admit(req.headers.get("x-demo-session"), req.headers.get("x-command-id"), command)
                if (!admission.ok) return json({ error: admission.error }, admission.status)
                return (await hub.command(command)) ? json({ ok: true }) : json({ error: "no live runner attached" }, 409)
            }

            if (url.pathname === "/" || url.pathname === "/index.html") {
                try {
                    return new Response(readFileSync("web/dist/index.html"), { headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" } })
                } catch {
                    return new Response("Run `bun run build:web` first.", { status: 503 })
                }
            }
            return new Response("not found", { status: 404 })
        }
    })
    return { server, session }
}

if (import.meta.main) {
    const { server } = startServer()
    console.log(`Doppelgänger dashboard on http://localhost:${server.port}`)
}
