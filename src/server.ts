// Serves the dashboard and streams the live runner's events.
//   bun run start            dashboard only (simulation mode, no keys needed)
//   bun run live             live runner + this server; open /?mode=live
//
// Commands are authorized per role (src/session.ts). The presenter token is
// only ever handed to a page loaded from this laptop.

import { readFileSync } from "node:fs"

import { hub, parseCommand } from "./live.ts"
import { createSession, isLoopback, type Session } from "./session.ts"

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

export function startServer(port = Number(process.env.PORT ?? 3000), session: Session = createSession()) {
    const server = Bun.serve({
        port,
        idleTimeout: 0,
        async fetch(req, srv) {
            const url = new URL(req.url)
            const from = srv.requestIP(req)?.address

            if (url.pathname === "/events") {
                let unsubscribe = () => {}
                const stream = new ReadableStream({
                    start(controller) {
                        const enc = new TextEncoder()
                        unsubscribe = hub.subscribe(e => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)))
                    },
                    cancel() {
                        unsubscribe()
                    }
                })
                return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
            }

            // The presenter's page, on this laptop only, learns its token and the on-call link to show as a QR code.
            if (url.pathname === "/session") {
                if (!isLoopback(from)) return json({ error: "the presenter session is only available on this laptop" }, 403)
                return json({ token: session.presenterToken, expiresAt: session.expiresAt, joinUrls: session.joinUrls(server.port) })
            }

            if (url.pathname === "/command" && req.method === "POST") {
                const body = await req.json().catch(() => ({}))
                const command = parseCommand(url, body)
                if (!command) return json({ error: "bad command" }, 400)
                const role = session.roleOf(req.headers.get("x-demo-session"))
                if (!role) return json({ error: "missing or expired demo session" }, 401)
                if (!session.allows(role, command)) return json({ error: `the ${role} role cannot ${command.kind}` }, 403)
                return (await hub.command(command)) ? json({ ok: true }) : json({ error: "no live runner attached" }, 409)
            }

            if (url.pathname === "/" || url.pathname === "/index.html") {
                try {
                    return new Response(readFileSync("web/dist/index.html"), { headers: { "content-type": "text/html; charset=utf-8" } })
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
