// A short-lived demo session with least-privilege roles.
//
//   presenter  everything: run cases, send a judge's message, reset, decide.
//              Its token is handed only to a page loaded on this laptop itself.
//              "On this laptop" means a loopback connection with NO proxy
//              headers and a localhost Host: a tunnel (cloudflared, ngrok)
//              connects from 127.0.0.1 too, so the address alone proves nothing.
//   oncall     decide and revoke. Its token travels in the QR link. It cannot
//              start attacks, reset, or restore authority (widening authority
//              is the presenter's call). The presenter can rotate it,
//              which immediately invalidates every phone that had the old one.
//
// The event stream needs a token too; on-call phones do not receive raw message
// text (outside content), only Court state, decisions and evidence.
//
// Every command carries a single-use id (a captured request cannot be
// replayed) and is rate-limited per role. Tokens expire, and are compared in
// constant time. Whatever a token allows, the Court still enforces authority:
// a human approval re-checks scope and every commit is fenced by the epoch, so
// a stale approval can never override a revocation.

import { timingSafeEqual } from "node:crypto"
import { networkInterfaces } from "node:os"

import type { LiveCommand } from "./live.ts"

export type Role = "presenter" | "oncall"

const ONCALL: LiveCommand["kind"][] = ["decide", "revoke"]
const RATE: Record<Role, { max: number; windowMs: number }> = { presenter: { max: 60, windowMs: 10_000 }, oncall: { max: 20, windowMs: 10_000 } }
const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/

function newToken(): string {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString("base64url")
}

function same(a: string, b: string): boolean {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

export type Admission = { ok: true; role: Role } | { ok: false; status: 400 | 401 | 403 | 409 | 429; error: string }

export interface Session {
    readonly expiresAt: number
    readonly presenterToken: string
    readonly oncallToken: string
    roleOf(token: string | null): Role | null
    allows(role: Role | null, command: LiveCommand): boolean
    /** Authenticates, authorizes, de-duplicates and rate-limits one command. */
    admit(token: string | null, commandId: string | null, command: LiveCommand, now?: number): Admission
    /** Issues a new on-call token; every phone holding the old one is locked out. */
    rotateOncall(): string
    joinUrls(port: number): string[]
}

export function createSession(minutes = Number(process.env.DEMO_SESSION_MINUTES ?? 180)): Session {
    const expiresAt = Date.now() + minutes * 60_000
    const presenterToken = newToken()
    let oncallToken = newToken()
    const seen = new Set<string>()
    const recent: Record<Role, number[]> = { presenter: [], oncall: [] }

    const roleOf = (t: string | null): Role | null => {
        if (!t || Date.now() > expiresAt) return null
        if (same(t, presenterToken)) return "presenter"
        if (same(t, oncallToken)) return "oncall"
        return null
    }
    const allows = (role: Role | null, command: LiveCommand) => role === "presenter" || (role === "oncall" && ONCALL.includes(command.kind))

    return {
        expiresAt,
        presenterToken,
        get oncallToken() {
            return oncallToken
        },
        roleOf,
        allows,
        admit(token, commandId, command, now = Date.now()) {
            const role = roleOf(token)
            if (!role) return { ok: false, status: 401, error: "missing or expired demo session" }
            if (!allows(role, command)) return { ok: false, status: 403, error: `the ${role} role cannot ${command.kind}` }
            if (!commandId || !COMMAND_ID.test(commandId)) return { ok: false, status: 400, error: "every command needs a fresh x-command-id" }
            if (seen.has(commandId)) return { ok: false, status: 409, error: "this command was already executed" }
            const window = recent[role].filter(t => now - t < RATE[role].windowMs)
            if (window.length >= RATE[role].max) return { ok: false, status: 429, error: "too many commands; slow down" }
            window.push(now)
            recent[role] = window
            seen.add(commandId)
            if (seen.size > 5000) seen.delete(seen.values().next().value as string)
            return { ok: true, role }
        },
        rotateOncall() {
            oncallToken = newToken()
            return oncallToken
        },
        joinUrls(port) {
            // Behind a tunnel (venue Wi-Fi often blocks device-to-device traffic), point phones at the public URL.
            const pub = process.env.PUBLIC_URL?.replace(/\/+$/, "")
            if (pub) return [`${pub}/?mode=live&view=oncall&t=${oncallToken}`]
            const ips = Object.values(networkInterfaces())
                .flat()
                .filter((n): n is NonNullable<typeof n> => !!n && n.family === "IPv4" && !n.internal)
                .map(n => n.address)
            return ips.map(ip => `http://${ip}:${port}/?mode=live&view=oncall&t=${oncallToken}`)
        }
    }
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "cf-connecting-ip", "cf-ray", "true-client-ip", "x-original-forwarded-for", "ngrok-trace-id"]

export const isLoopback = (address: string | undefined) => !!address && (address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1")

/**
 * True only for a request made by a browser on this machine directly: a
 * loopback peer, no proxy headers, and a localhost Host. A tunnel forwards
 * internet traffic from 127.0.0.1, so the peer address alone proves nothing.
 */
export function isLocalRequest(req: Request, peer: string | undefined): boolean {
    if (!isLoopback(peer)) return false
    if (PROXY_HEADERS.some(h => req.headers.has(h))) return false
    const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "")
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
}
