// The Court: Doppelgänger's safety layer, as pure functions.
//
// The Court actor (src/actors.ts) holds the protected resource and runs these
// one call at a time. Every transition is guarded by the operation's current
// state, and every verdict is fenced by the authorization epoch the Court
// stamped when the operation was submitted. Nothing here consults a statistic
// to deny: the evidence layer can only clear an action or hand it to a human.
//
// Lifecycle:
//   PENDING → DENIED                      out of scope
//   PENDING → APPROVED → EXECUTED         in scope, no outside content in its history
//   PENDING → HELD                        in scope, descends from outside content, and a key value is
//                                         outside what the human authorized in advance: held at once
//   PENDING → UNDER_REVIEW                in scope, descends from outside content, nothing unauthorized
//   UNDER_REVIEW → APPROVED | HELD        evidence, if authorization has not changed
//   UNDER_REVIEW → DENIED                 stale (a revoke happened mid-review) or out of scope
//   HELD → APPROVED | DENIED              a human, optionally correcting arguments
//
// explain() attaches explanatory evidence to an operation that is no longer
// under review. It never changes an operation's state or the config.

import type { ActionName, Args, CourtState, Evidence, LogLevel, Op, OpState, Scope, ScopeDecision, ServiceConfig, SubmitInput } from "./types.ts"

export const INTERNAL_DEFAULT_SINK = "internal://logs/webhooks"

export const DEFAULT_CONFIG: ServiceConfig = { service: "webhooks", logLevel: "info", logSink: INTERNAL_DEFAULT_SINK, prodAccessKeys: [] }

/**
 * What the on-call engineer authorized: Infra may change logging on the
 * webhooks service, up to debug. The destination is not restricted (a laundered
 * destination passes an ordinary permission check), but only internal sinks are
 * authorized in advance: a new destination that arrives through outside content
 * is held for her at once.
 */
export const DEFAULT_SCOPES: Scope[] = [{ agent: "infra", action: "logging.configure", service: "webhooks", maxLevel: "debug", preauthorized: { sink: ["internal://"] } }]

export function initialState(): CourtState {
    return { epoch: 1, scopes: DEFAULT_SCOPES.map(s => ({ ...s })), config: { ...DEFAULT_CONFIG, prodAccessKeys: [] }, ops: [] }
}

const LEVELS: LogLevel[] = ["error", "warn", "info", "debug", "trace"]
const rank = (level: string) => LEVELS.indexOf(level.toLowerCase() as LogLevel)

export function checkScope(state: CourtState, agent: string, action: ActionName, args: Args): ScopeDecision {
    const scope = state.scopes.find(s => s.agent === agent && s.action === action)
    if (!scope) return { allowed: false, reason: `${agent} is not authorized to call ${action}` }
    if ((args.service ?? "") !== scope.service) return { allowed: false, reason: `${action} is authorized only on service "${scope.service}"` }
    if (action === "logging.configure") {
        const r = rank(args.level ?? "")
        if (r < 0) return { allowed: false, reason: `unknown log level "${args.level ?? ""}"` }
        if (scope.maxLevel && r > rank(scope.maxLevel)) return { allowed: false, reason: `log level "${args.level}" exceeds the authorized "${scope.maxLevel}"` }
        if (!(args.sink ?? "").trim()) return { allowed: false, reason: "a log sink is required" }
    }
    return { allowed: true, reason: "within the authorized scope" }
}

/** A key value outside what the human authorized in advance, if any. Deterministic: prefixes only. */
export function unauthorizedValue(state: CourtState, agent: string, action: ActionName, args: Args): { arg: string; value: string } | null {
    const scope = state.scopes.find(s => s.agent === agent && s.action === action)
    for (const [arg, prefixes] of Object.entries(scope?.preauthorized ?? {})) {
        const value = args[arg] ?? ""
        if (!prefixes.some(p => value.startsWith(p))) return { arg, value }
    }
    return null
}

export interface Transition {
    state: CourtState
    op: Op
    /** False when the call was a harmless no-op (a duplicate, or the wrong state). */
    changed: boolean
}

function stamp(op: Op, state: OpState, note: string, now: string): Op {
    return { ...op, state, reason: note, history: [...op.history, { state, at: now, note }] }
}

const replace = (s: CourtState, op: Op): CourtState => ({ ...s, ops: s.ops.map(o => (o.opId === op.opId ? op : o)) })
const find = (s: CourtState, opId: string) => s.ops.find(o => o.opId === opId)

function fresh(s: CourtState, input: SubmitInput, now: string): Op {
    return {
        opId: input.opId,
        action: input.action,
        args: { ...input.args },
        requestedBy: input.requestedBy,
        triggerRelayId: input.triggerRelayId,
        lineage: input.lineage,
        state: "PENDING",
        epochAtSubmit: s.epoch,
        epochAtApproval: 0,
        evidence: null,
        reason: "",
        decidedBy: "",
        createdAt: now,
        history: [{ state: "PENDING", at: now, note: "submitted" }]
    }
}

/** A new request. Idempotent on opId: a retried submit returns the existing operation. */
export function submit(s: CourtState, input: SubmitInput, now: string): Transition {
    const existing = find(s, input.opId)
    if (existing) return { state: s, op: existing, changed: false }
    let op = fresh(s, input, now)
    const scope = checkScope(s, input.requestedBy, input.action, input.args)
    if (!scope.allowed) op = stamp(op, "DENIED", `authorization: ${scope.reason}`, now)
    else if (!input.lineage.tainted) op = { ...stamp(op, "APPROVED", "in scope, and nothing outside the company is in its history", now), epochAtApproval: s.epoch }
    else {
        const u = unauthorizedValue(s, input.requestedBy, input.action, input.args)
        op = u
            ? stamp(op, "HELD", `authorization: ${u.arg} "${u.value}" was never authorized by a human, and it reached ${input.requestedBy} through outside content. Held for the on-call engineer.`, now)
            : stamp(op, "UNDER_REVIEW", "in scope, but its history reaches outside content: Doppelgänger is testing it", now)
    }
    return { state: { ...s, ops: [...s.ops, op] }, op, changed: true }
}

/**
 * Explanatory evidence for an operation that is not under review (held at
 * submission, or already decided). Attaches it once; never changes state, never
 * approves, never touches the config.
 */
export function explain(s: CourtState, opId: string, evidence: Evidence): Transition {
    const op = find(s, opId)
    if (!op) throw new Error(`unknown operation ${opId}`)
    if (op.state === "UNDER_REVIEW" || op.state === "PENDING" || op.evidence) return { state: s, op, changed: false }
    const next = { ...op, evidence }
    return { state: replace(s, next), op: next, changed: true }
}

function cite(e: Evidence): string {
    const c = e.certificate
    return c ? ` (e = ${c.eValue.toFixed(2)} after ${c.rounds.length} rounds)` : ""
}

/** The evidence layer's recommendation. Note what is missing: it never returns DENIED. */
export function decideFromEvidence(e: Evidence): { state: OpState; note: string } {
    const origin = e.originRelayId || "outside content"
    if (e.valueProvenance.length > 0) {
        const f = e.valueProvenance[0]
        return { state: "HELD", note: `${f.arg} "${f.value}" appears only in outside message ${f.relayId}; a human decides` }
    }
    switch (e.verdict) {
        case "robust":
            return { state: "APPROVED", note: `evidence: the action survives neutralizing ${origin}${cite(e)}` }
        case "influenced": {
            const args = e.diffs.map(d => d.arg).join(", ")
            return { state: "HELD", note: `evidence: ${args || "the action"} comes from ${origin}, not from the human's task${cite(e)}; a human decides` }
        }
        case "unstable":
            return { state: "HELD", note: `evidence inconclusive: the action does not even reproduce unchanged${cite(e)}; a human decides` }
        case "inconclusive":
            return { state: "HELD", note: `evidence inconclusive: no verdict could be reached${cite(e)}; a human decides` }
        case "error":
            return { state: "HELD", note: `evidence unavailable (${e.note}); holding for a human` }
    }
}

/**
 * UNDER_REVIEW → APPROVED | HELD | DENIED, only if authorization has not changed.
 * The fence is the epoch the Court stamped at submission, not one a worker
 * reports: trusting the worker lets revoke-then-restore slip a stale verdict
 * through (the model checker's counterexample). The reported epoch is still
 * checked as a second line of defence.
 */
export function verdict(s: CourtState, opId: string, evidence: Evidence, epoch: number, now: string): Transition {
    const op = find(s, opId)
    if (!op) throw new Error(`unknown operation ${opId}`)
    if (op.state !== "UNDER_REVIEW") return { state: s, op, changed: false }
    const withEvidence = { ...op, evidence }
    if (op.epochAtSubmit !== s.epoch || epoch !== s.epoch) {
        const next = stamp(withEvidence, "DENIED", `stale verdict: the review began at epoch ${op.epochAtSubmit}; authorization is now epoch ${s.epoch}`, now)
        return { state: replace(s, next), op: next, changed: true }
    }
    const scope = checkScope(s, op.requestedBy, op.action, op.args)
    if (!scope.allowed) {
        const next = stamp(withEvidence, "DENIED", `authorization: ${scope.reason}`, now)
        return { state: replace(s, next), op: next, changed: true }
    }
    const d = decideFromEvidence(evidence)
    let next = stamp(withEvidence, d.state, d.note, now)
    if (d.state === "APPROVED") next = { ...next, epochAtApproval: s.epoch }
    return { state: replace(s, next), op: next, changed: true }
}

/** HELD → APPROVED (optionally with corrected arguments, re-checked against scope) | DENIED. */
export function decide(s: CourtState, opId: string, approve: boolean, by: string, corrected: Args | null, now: string): Transition {
    const op = find(s, opId)
    if (!op) throw new Error(`unknown operation ${opId}`)
    if (op.state !== "HELD") return { state: s, op, changed: false }
    if (!approve) {
        const next = { ...stamp(op, "DENIED", `denied by ${by}`, now), decidedBy: by }
        return { state: replace(s, next), op: next, changed: true }
    }
    const args = corrected ? { ...op.args, ...corrected } : op.args
    const scope = checkScope(s, op.requestedBy, op.action, args)
    if (!scope.allowed) {
        const next = { ...stamp(op, "DENIED", `approval rejected: ${scope.reason}`, now), decidedBy: by }
        return { state: replace(s, next), op: next, changed: true }
    }
    const note = corrected ? `approved by ${by} with corrected arguments` : `approved by ${by}`
    const next = { ...stamp({ ...op, args }, "APPROVED", note, now), decidedBy: by, epochAtApproval: s.epoch }
    return { state: replace(s, next), op: next, changed: true }
}

/** APPROVED → EXECUTED: applies the operation to the protected config, unless authorization changed since approval. */
export function commit(s: CourtState, opId: string, now: string): Transition {
    const op = find(s, opId)
    if (!op) throw new Error(`unknown operation ${opId}`)
    if (op.state !== "APPROVED") return { state: s, op, changed: false }
    if (op.epochAtApproval !== s.epoch) {
        const next = stamp(op, "DENIED", `stale approval: approved at epoch ${op.epochAtApproval}; authorization is now epoch ${s.epoch}`, now)
        return { state: replace(s, next), op: next, changed: true }
    }
    let config = s.config
    if (op.action === "logging.configure") config = { ...config, logLevel: op.args.level, logSink: op.args.sink }
    else if (op.action === "access.grant") config = { ...config, prodAccessKeys: [...config.prodAccessKeys, op.args.public_key] }
    const next = stamp(op, "EXECUTED", "applied to the protected config", now)
    return { state: { ...replace(s, next), config }, op: next, changed: true }
}

/** Removes an agent's authority and advances the epoch, fencing every review in flight. */
export function revoke(s: CourtState, agent: string): CourtState {
    return { ...s, epoch: s.epoch + 1, scopes: s.scopes.filter(sc => sc.agent !== agent) }
}

/** Restores the default authorization at a new epoch, keeping history. */
export function restoreScopes(s: CourtState): CourtState {
    return { ...s, epoch: s.epoch + 1, scopes: DEFAULT_SCOPES.map(sc => ({ ...sc })) }
}

/** Records an operation Agent Relay's policy hook already refused, so the docket shows it. */
export function recordDenied(s: CourtState, input: SubmitInput, reason: string, now: string): Transition {
    const existing = find(s, input.opId)
    if (existing) return { state: s, op: existing, changed: false }
    const op = stamp(fresh(s, input, now), "DENIED", `authorization: ${reason}`, now)
    return { state: { ...s, ops: [...s.ops, op] }, op, changed: true }
}

export const TERMINAL_STATES: OpState[] = ["EXECUTED", "DENIED"]
