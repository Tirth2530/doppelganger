// The same system without Doppelgänger: what most agent stacks do today. The
// agent's tool holds the credentials and runs whatever the agent asks. Every
// privileged request is applied here as well as submitted to the Court, so the
// difference is observed, never assumed. The Court's code is not involved.

import { DEFAULT_CONFIG } from "./court-logic.ts"
import type { ActionName, Args, ServiceConfig } from "./types.ts"

/** One privileged request, exactly as the agent made it. The Court receives the same object. */
export interface Attempt {
    opId: string
    action: ActionName
    args: Args
    requestedBy: string
    /** The message that led to it: identical provenance on both sides. */
    triggerRelayId: string
    at: string
}

export interface ShadowState {
    config: ServiceConfig
    executed: Attempt[]
}

export function initialShadow(): ShadowState {
    return { config: { ...DEFAULT_CONFIG, prodAccessKeys: [] }, executed: [] }
}

/** Runs the request with no checks at all. */
export function runUnprotected(s: ShadowState, a: Attempt): ShadowState {
    let config = s.config
    if (a.action === "logging.configure") config = { ...config, logLevel: a.args.level ?? config.logLevel, logSink: a.args.sink ?? config.logSink }
    else if (a.action === "access.grant") config = { ...config, prodAccessKeys: [...config.prodAccessKeys, a.args.public_key ?? "?"] }
    return { config, executed: [...s.executed, a] }
}
