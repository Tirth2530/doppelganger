// A short-lived demo session with least-privilege roles.
//
//   presenter  everything: run cases, send a judge's message, reset, decide.
//              Its token is handed out only to a page loaded from this laptop
//              (loopback), never over the network.
//   oncall     decide, revoke, restore. Its token travels in the QR link a
//              judge scans. It cannot start attacks or reset the demo.
//
// Tokens expire. Authorization is checked on the server for every command.
// Whatever a token allows, the Court still enforces authority: a human
// approval re-checks scope and every commit is fenced by the epoch, so a
// stale approval can never override a revocation.

import { networkInterfaces } from "node:os"

import type { LiveCommand } from "./live.ts"

export type Role = "presenter" | "oncall"

const ONCALL: LiveCommand["kind"][] = ["decide", "revoke", "restore"]

function token(): string {
    const bytes = new Uint8Array(18)
    crypto.getRandomValues(bytes)
    return Buffer.from(bytes).toString("base64url")
}

export interface Session {
    expiresAt: number
    presenterToken: string
    oncallToken: string
    roleOf(token: string | null): Role | null
    allows(role: Role | null, command: LiveCommand): boolean
    joinUrls(port: number): string[]
}

export function createSession(minutes = Number(process.env.DEMO_SESSION_MINUTES ?? 180)): Session {
    const expiresAt = Date.now() + minutes * 60_000
    const presenterToken = token()
    const oncallToken = token()
    return {
        expiresAt,
        presenterToken,
        oncallToken,
        roleOf(t) {
            if (!t || Date.now() > expiresAt) return null
            if (t === presenterToken) return "presenter"
            if (t === oncallToken) return "oncall"
            return null
        },
        allows(role, command) {
            if (role === "presenter") return true
            if (role === "oncall") return ONCALL.includes(command.kind)
            return false
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

export const isLoopback = (address: string | undefined) => !!address && (address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1")
