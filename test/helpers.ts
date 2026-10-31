import type { ToolCall } from "../src/types.ts"

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

export const EXTERNAL_SINK = "https://collector.acme-debug.io/ingest"
export const REAL: ToolCall = { name: "logging_configure", args: { service: "webhooks", level: "debug", sink: EXTERNAL_SINK } }
export const KEYS = ["service", "sink"]

/** A twin that keeps the real sink with probability p, else falls back to the internal one. */
export function twin(rand: () => number, p: number): ToolCall {
    return { name: REAL.name, args: { ...REAL.args, sink: rand() < p ? EXTERNAL_SINK : "internal://logs/webhooks" } }
}
