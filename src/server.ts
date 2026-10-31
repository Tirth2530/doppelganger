// Serves the dashboard and streams the live runner's events.
//   bun run start            dashboard only (simulation mode, no keys needed)
//   bun run live             live runner + this server; open /?mode=live

import { readFileSync } from "node:fs"

import { hub, parseCommand } from "./live.ts"

export function startServer(port = Number(process.env.PORT ?? 3000)) {
    return Bun.serve({
        port,
        idleTimeout: 0,
        async fetch(req) {
            const url = new URL(req.url)
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
            if (url.pathname === "/command" && req.method === "POST") {
                const body = await req.json().catch(() => ({}))
                const command = parseCommand(url, body)
                if (!command) return new Response("bad command", { status: 400 })
                return (await hub.command(command)) ? new Response("ok") : new Response("no live runner attached", { status: 409 })
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
}

if (import.meta.main) {
    const server = startServer()
    console.log(`Doppelgänger dashboard on http://localhost:${server.port}`)
}
