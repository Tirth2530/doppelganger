// The bridge between the live runner and the dashboard: events out over SSE,
// human commands in over POST /command.

import type { UiEvent } from "./events.ts"
import type { Args } from "./types.ts"

export type LiveCommand =
    | { kind: "run"; beat: number }
    | { kind: "revoke" }
    | { kind: "restore" }
    | { kind: "reset" }
    | { kind: "decide"; opId: string; approve: boolean; corrected: Args | null }

type Subscriber = (event: UiEvent) => void

export class LiveHub {
    private subscribers = new Set<Subscriber>()
    private history: UiEvent[] = []
    private handler: ((c: LiveCommand) => Promise<void> | void) | null = null

    emit = (event: UiEvent): void => {
        if (event.type === "reset") this.history = []
        this.history.push(event)
        if (this.history.length > 2000) this.history = this.history.slice(-2000)
        for (const s of this.subscribers) s(event)
    }

    /** Late joiners get the history first, so a refreshed dashboard is never blank. */
    subscribe(s: Subscriber): () => void {
        for (const e of this.history) s(e)
        this.subscribers.add(s)
        return () => this.subscribers.delete(s)
    }

    onCommand(handler: (c: LiveCommand) => Promise<void> | void): void {
        this.handler = handler
    }

    async command(c: LiveCommand): Promise<boolean> {
        if (!this.handler) return false
        await this.handler(c)
        return true
    }
}

export const hub = new LiveHub()

/** Validates a command from the browser. Anything malformed is refused. */
export function parseCommand(url: URL, body: unknown): LiveCommand | null {
    const run = url.searchParams.get("run")
    if (run !== null) {
        const beat = Number(run)
        return Number.isInteger(beat) && beat >= 0 && beat <= 9 ? { kind: "run", beat } : null
    }
    const kind = url.searchParams.get("do")
    if (kind === "revoke" || kind === "restore" || kind === "reset") return { kind }
    if (kind === "decide") {
        const b = (body ?? {}) as Record<string, unknown>
        if (typeof b.opId !== "string" || typeof b.approve !== "boolean") return null
        let corrected: Args | null = null
        if (b.corrected && typeof b.corrected === "object") {
            corrected = {}
            for (const [k, v] of Object.entries(b.corrected as Record<string, unknown>)) {
                if (typeof v !== "string" || !["service", "level", "sink", "environment", "public_key"].includes(k)) return null
                corrected[k] = v
            }
        }
        return { kind: "decide", opId: b.opId, approve: b.approve, corrected }
    }
    return null
}
