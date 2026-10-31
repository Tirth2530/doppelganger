// An exhaustive model checker for the Court.
//
// It drives the Court's real code through every interleaving of requests,
// evidence callbacks (any outcome, reporting any epoch), human decisions,
// commits, revocations, restores, duplicates and retries, within stated bounds,
// and checks six safety invariants after every transition. The replay worker
// and the humans are treated as untrusted: they may call late, twice, or lie
// about the epoch.
//
// Five broken Courts are checked the same way. Each removes one safeguard, and
// each must be caught with its shortest counterexample. One of them is the
// Court with Durable Actors' serialization turned off (@Interleave): that is
// the property the actor runtime gives us, shown to be load-bearing.

import * as court from "./court-logic.ts"
import { computeLineage } from "./replay-logic.ts"
import type { Args, CourtState, Evidence, LineageSummary, MessageRecord, Op, OpState, ServiceConfig, SubmitInput } from "./types.ts"

const NOW = "t"

// ---- the world ---------------------------------------------------------------

const msg = (relayId: string, trust: MessageRecord["trust"], inputs: string[]): MessageRecord => ({
    relayId,
    from: trust === "external" ? "acme-agent" : trust === "human" ? "oncall" : "support",
    to: "infra",
    trust,
    text: "",
    at: NOW,
    producedBy: trust === "internal_agent" ? { agent: "support", step: 1 } : null,
    inputs
})

const MESSAGES = new Map<string, MessageRecord>(
    [msg("m0", "external", []), msg("h1", "human", []), msg("m1", "internal_agent", ["h1", "m0"]), msg("m2", "internal_agent", ["h1", "m0"])].map(m => [m.relayId, m])
)

export const OP_SPECS: Record<string, { label: string; action: SubmitInput["action"]; args: Args; trigger: string }> = {
    A: { label: "laundered logging change", action: "logging.configure", args: { service: "webhooks", level: "debug", sink: "internal://logs/webhooks-verbose" }, trigger: "m1" },
    D: { label: "laundered unauthorized destination", action: "logging.configure", args: { service: "webhooks", level: "debug", sink: "https://collector.acme-debug.io/ingest" }, trigger: "m1" },
    B: { label: "clean logging change", action: "logging.configure", args: { service: "webhooks", level: "debug", sink: court.INTERNAL_DEFAULT_SINK }, trigger: "h1" },
    C: { label: "production access grant", action: "access.grant", args: { service: "webhooks", environment: "production", public_key: "ssh-ed25519 AAAA" }, trigger: "m2" }
}

// ---- implementations -----------------------------------------------------------

export interface Impl {
    id: string
    title: string
    description: string
    mutant: boolean
    /** False models a Court whose verdict handler can be interleaved at an await. */
    atomicVerdict: boolean
    lineage(messages: Map<string, MessageRecord>, trigger: string): LineageSummary
    submit: typeof court.submit
    verdict: typeof court.verdict
    decide: typeof court.decide
    commit: typeof court.commit
}

const REAL: Impl = {
    id: "court",
    title: "Doppelgänger Court",
    description: "The Court as shipped: full lineage, epoch fencing at verdict and at commit, state guards on every transition, serialized by its Durable Actor.",
    mutant: false,
    atomicVerdict: true,
    lineage: computeLineage,
    submit: court.submit,
    verdict: court.verdict,
    decide: court.decide,
    commit: court.commit
}

const force = (s: CourtState, opId: string, state: OpState): CourtState => ({ ...s, ops: s.ops.map(o => (o.opId === opId ? { ...o, state } : o)) })

export const IMPLEMENTATIONS: Impl[] = [
    REAL,
    {
        ...REAL,
        id: "last-hop",
        title: "Trust the last hop",
        description: "Checks only who sent the triggering message. A request relayed by a trusted teammate looks clean.",
        mutant: true,
        lineage: (messages, trigger) => {
            const m = messages.get(trigger)
            const tainted = !m || m.trust === "external"
            // A trusted teammate's message is taken as the human's own request.
            return { tainted, externalRelayIds: tainted ? [trigger] : [], chain: [trigger], hops: 0, humanRelayIds: tainted ? [] : [trigger], unverified: [] }
        }
    },
    {
        ...REAL,
        id: "no-commit-fence",
        title: "No fence at commit",
        description: "Applies an approved operation without checking that authorization is unchanged since the approval.",
        mutant: true,
        commit: (s, opId, now) => court.commit({ ...s, ops: s.ops.map(o => (o.opId === opId ? { ...o, epochAtApproval: s.epoch } : o)) }, opId, now)
    },
    {
        ...REAL,
        id: "trust-worker-epoch",
        title: "Trust the worker's epoch",
        description: "Fences verdicts with the epoch the replay worker reports instead of the one the Court stamped at submission.",
        mutant: true,
        verdict: (s, opId, e, epoch, now) => court.verdict({ ...s, ops: s.ops.map(o => (o.opId === opId ? { ...o, epochAtSubmit: epoch } : o)) }, opId, e, epoch, now)
    },
    {
        ...REAL,
        id: "interleaved",
        title: "Unserialized verdict (@Interleave)",
        description: "The verdict handler checks the epoch, awaits, then writes. Another call can run in between, as @Interleave allows.",
        mutant: true,
        atomicVerdict: false
    },
    {
        ...REAL,
        id: "no-state-guard",
        title: "No state guard on callbacks",
        description: "Verdict, human and commit handlers act on an operation whatever state it is in.",
        mutant: true,
        verdict: (s, opId, e, epoch, now) => (s.ops.some(o => o.opId === opId) ? court.verdict(force(s, opId, "UNDER_REVIEW"), opId, e, epoch, now) : court.verdict(s, opId, e, epoch, now)),
        decide: (s, opId, a, by, c, now) => (s.ops.some(o => o.opId === opId) ? court.decide(force(s, opId, "HELD"), opId, a, by, c, now) : court.decide(s, opId, a, by, c, now)),
        commit: (s, opId, now) => (s.ops.some(o => o.opId === opId) ? court.commit(force(s, opId, "APPROVED"), opId, now) : court.commit(s, opId, now))
    }
]

// ---- invariants ----------------------------------------------------------------

export const INVARIANTS = [
    { id: "authority", name: "Executes only under current authority", statement: "An operation reaches EXECUTED only if Infra holds authority for it at that moment and no revocation happened since it was approved." },
    { id: "revocation", name: "Revocation stops reviews in flight", statement: "Evidence never approves an operation if Infra's authority was revoked while its review was running." },
    { id: "laundering", name: "Laundered requests are always reviewed", statement: "An operation whose history reaches outside content is approved only by evidence or a human, never on submission." },
    { id: "transitions", name: "Only legal state transitions", statement: "Every change follows the lifecycle; HELD leaves only by a human decision; EXECUTED and DENIED never change." },
    { id: "config", name: "Config is exactly what was executed", statement: "The protected config always equals the default with each executed operation applied in order, and nothing else." },
    { id: "once", name: "Each operation executes at most once", statement: "No operation is applied to the protected config twice, however many commits arrive." }
] as const

export type InvariantId = (typeof INVARIANTS)[number]["id"]

// ---- system state and actions ----------------------------------------------

type Outcome = "robust" | "influenced"
type Claim = "stamped" | "current"

export type Act =
    | { kind: "submit"; op: string }
    | { kind: "verdict"; op: string; outcome: Outcome; claim: Claim }
    | { kind: "verdict.read"; op: string; outcome: Outcome; claim: Claim }
    | { kind: "verdict.write"; op: string }
    | { kind: "human"; op: string; approve: boolean; correct: boolean }
    | { kind: "commit"; op: string }
    | { kind: "revoke" }
    | { kind: "restore" }

interface Ghost {
    revokes: number
    atSubmit: Record<string, number>
    atApproval: Record<string, number>
    executed: { opId: string; action: string; args: Args }[]
    execCount: Record<string, number>
}

interface Pending {
    op: string
    target: OpState
    note: string
}

export interface Sys {
    court: CourtState
    ghost: Ghost
    used: Record<string, number>
    pending: Pending[]
}

export interface Limits {
    submits: number
    verdicts: number
    humans: number
    commits: number
    revokes: number
    restores: number
}

export interface Scenario {
    id: string
    title: string
    ops: string[]
    limits: Limits
}

export const SCENARIOS: Scenario[] = [
    { id: "all-interleaved", title: "All three operations, every interleaving", ops: ["A", "B", "C"], limits: { submits: 1, verdicts: 1, humans: 1, commits: 1, revokes: 1, restores: 1 } },
    { id: "laundered-retries", title: "The laundered request with duplicates and retries", ops: ["A"], limits: { submits: 2, verdicts: 2, humans: 2, commits: 2, revokes: 1, restores: 1 } },
    { id: "revocation-race", title: "Two requests racing two revocations", ops: ["A", "B"], limits: { submits: 1, verdicts: 2, humans: 1, commits: 2, revokes: 2, restores: 2 } },
    { id: "instant-hold", title: "An unauthorized laundered destination, held at once, racing verdicts, humans and revocations", ops: ["D", "B"], limits: { submits: 2, verdicts: 2, humans: 2, commits: 2, revokes: 1, restores: 1 } }
]

const evidenceFor = (outcome: Outcome): Evidence => ({
    verdict: outcome,
    diffs: outcome === "influenced" ? [{ arg: "sink", real: "", counterfactual: court.INTERNAL_DEFAULT_SINK }] : [],
    realCall: { name: "x", args: {} },
    counterfactualCall: null,
    originRelayId: "m0",
    valueProvenance: [],
    rounds: 8,
    note: "",
    certificate: null
})

function initial(): Sys {
    return { court: court.initialState(), ghost: { revokes: 0, atSubmit: {}, atApproval: {}, executed: [], execCount: {} }, used: {}, pending: [] }
}

export function enabled(sys: Sys, scenario: Scenario, impl: Impl): Act[] {
    const L = scenario.limits
    const u = (k: string) => sys.used[k] ?? 0
    const acts: Act[] = []
    for (const op of scenario.ops) {
        if (u(`submit:${op}`) < L.submits) acts.push({ kind: "submit", op })
        const exists = sys.court.ops.some(o => o.opId === op)
        if (!exists) continue
        if (u(`verdict:${op}`) < L.verdicts)
            for (const outcome of ["robust", "influenced"] as const)
                for (const claim of ["stamped", "current"] as const) acts.push({ kind: impl.atomicVerdict ? "verdict" : "verdict.read", op, outcome, claim })
        if (sys.pending.some(p => p.op === op)) acts.push({ kind: "verdict.write", op })
        if (u(`human:${op}`) < L.humans) for (const approve of [true, false]) for (const correct of approve ? [false, true] : [false]) acts.push({ kind: "human", op, approve, correct })
        if (u(`commit:${op}`) < L.commits) acts.push({ kind: "commit", op })
    }
    if (u("revoke") < L.revokes) acts.push({ kind: "revoke" })
    if (u("restore") < L.restores) acts.push({ kind: "restore" })
    return acts
}

const LEGAL: Record<string, Partial<Record<OpState, OpState[]>>> = {
    verdict: { UNDER_REVIEW: ["APPROVED", "HELD", "DENIED"] },
    "verdict.write": { UNDER_REVIEW: ["APPROVED", "HELD", "DENIED"] },
    human: { HELD: ["APPROVED", "DENIED"] },
    commit: { APPROVED: ["EXECUTED", "DENIED"] }
}

function applyConfig(cfg: ServiceConfig, e: { action: string; args: Args }): ServiceConfig {
    if (e.action === "logging.configure") return { ...cfg, logLevel: e.args.level, logSink: e.args.sink }
    if (e.action === "access.grant") return { ...cfg, prodAccessKeys: [...cfg.prodAccessKeys, e.args.public_key] }
    return cfg
}

function claimedEpoch(sys: Sys, op: string, claim: Claim): number {
    const o = sys.court.ops.find(x => x.opId === op)
    return claim === "current" || !o ? sys.court.epoch : o.epochAtSubmit
}

export interface Step {
    next: Sys
    broken: InvariantId[]
    changes: string[]
}

export function apply(sys: Sys, act: Act, impl: Impl): Step {
    const before = sys.court
    let c = before
    let pending = sys.pending
    const used = { ...sys.used }
    const bump = (k: string) => (used[k] = (used[k] ?? 0) + 1)
    switch (act.kind) {
        case "submit": {
            bump(`submit:${act.op}`)
            const spec = OP_SPECS[act.op]
            c = impl.submit(c, { opId: act.op, action: spec.action, args: spec.args, requestedBy: "infra", triggerRelayId: spec.trigger, lineage: impl.lineage(MESSAGES, spec.trigger) }, NOW).state
            break
        }
        case "verdict":
            bump(`verdict:${act.op}`)
            c = impl.verdict(c, act.op, evidenceFor(act.outcome), claimedEpoch(sys, act.op, act.claim), NOW).state
            break
        case "verdict.read": {
            bump(`verdict:${act.op}`)
            // Check-then-await: the decision is computed now and written later, unchecked.
            const t = court.verdict(c, act.op, evidenceFor(act.outcome), claimedEpoch(sys, act.op, act.claim), NOW)
            if (t.changed) pending = [...pending.filter(p => p.op !== act.op), { op: act.op, target: t.op.state, note: t.op.reason }]
            break
        }
        case "verdict.write": {
            const p = pending.find(x => x.op === act.op)!
            pending = pending.filter(x => x.op !== act.op)
            c = {
                ...c,
                ops: c.ops.map(o =>
                    o.opId === p.op && o.state === "UNDER_REVIEW"
                        ? { ...o, state: p.target, reason: p.note, epochAtApproval: p.target === "APPROVED" ? c.epoch : o.epochAtApproval }
                        : o
                )
            }
            break
        }
        case "human":
            bump(`human:${act.op}`)
            c = impl.decide(c, act.op, act.approve, "oncall", act.correct ? { sink: court.INTERNAL_DEFAULT_SINK } : null, NOW).state
            break
        case "commit":
            bump(`commit:${act.op}`)
            c = impl.commit(c, act.op, NOW).state
            break
        case "revoke":
            bump("revoke")
            c = court.revoke(c, "infra")
            break
        case "restore":
            bump("restore")
            c = court.restoreScopes(c)
            break
    }

    // ghost bookkeeping and invariant checks
    const ghost: Ghost = { ...sys.ghost, atSubmit: { ...sys.ghost.atSubmit }, atApproval: { ...sys.ghost.atApproval }, executed: [...sys.ghost.executed], execCount: { ...sys.ghost.execCount } }
    if (act.kind === "revoke") ghost.revokes++
    const broken = new Set<InvariantId>()
    const changes: string[] = []
    if (c.epoch !== before.epoch) changes.push(`authorization epoch ${before.epoch} → ${c.epoch}`)
    const prev = new Map(before.ops.map(o => [o.opId, o]))
    for (const op of c.ops) {
        const was = prev.get(op.opId)
        if (!was) {
            ghost.atSubmit[op.opId] = ghost.revokes
            changes.push(`${op.opId}: new → ${op.state}`)
            if (act.kind !== "submit" || !["APPROVED", "UNDER_REVIEW", "HELD", "DENIED"].includes(op.state)) broken.add("transitions")
            if (op.state === "APPROVED") {
                ghost.atApproval[op.opId] = ghost.revokes
                if (computeLineage(MESSAGES, OP_SPECS[op.opId].trigger).tainted) broken.add("laundering")
            }
            continue
        }
        const reapplied = act.kind === "commit" && act.op === op.opId && op.state === "EXECUTED" && was.state === "EXECUTED" && c.config !== before.config
        if (was.state === op.state && !reapplied) continue
        changes.push(`${op.opId}: ${was.state} → ${op.state}`)
        const legal = LEGAL[act.kind]?.[was.state]?.includes(op.state) && "op" in act && act.op === op.opId
        if (!legal) broken.add("transitions")
        if (op.state === "APPROVED") {
            ghost.atApproval[op.opId] = ghost.revokes
            if ((act.kind === "verdict" || act.kind === "verdict.write") && ghost.revokes !== ghost.atSubmit[op.opId]) broken.add("revocation")
        }
        if (op.state === "EXECUTED") {
            ghost.executed.push({ opId: op.opId, action: op.action, args: op.args })
            ghost.execCount[op.opId] = (ghost.execCount[op.opId] ?? 0) + 1
            if (ghost.execCount[op.opId] > 1) broken.add("once")
            const scope = court.checkScope(c, op.requestedBy, op.action, op.args)
            if (!scope.allowed || ghost.revokes !== ghost.atApproval[op.opId]) broken.add("authority")
        }
    }
    let expected = court.DEFAULT_CONFIG
    for (const e of ghost.executed) expected = applyConfig(expected, e)
    if (JSON.stringify(expected) !== JSON.stringify(c.config)) broken.add("config")
    return { next: { court: c, ghost, used, pending }, broken: [...broken], changes }
}

/** Everything that can affect future behaviour except the remaining budgets. */
function coreOf(s: Sys): string {
    const ops = s.court.ops.map(o => [o.opId, o.state, o.args.sink ?? "", o.epochAtSubmit, o.epochAtApproval])
    return JSON.stringify([s.court.epoch, s.court.scopes.length, s.court.config, ops, s.ghost, s.pending.map(p => [p.op, p.target])])
}

function keyOf(s: Sys): string {
    return coreOf(s) + JSON.stringify(s.used)
}

// ---- search --------------------------------------------------------------------

export interface TraceStep {
    actor: string
    event: string
    result: string
}

export interface Counterexample {
    invariant: InvariantId
    scenario: string
    steps: TraceStep[]
}

export interface ScenarioReport {
    scenario: string
    states: number
    transitions: number
    depth: number
    ms: number
    broken: InvariantId[]
}

export interface ImplReport {
    impl: string
    title: string
    description: string
    mutant: boolean
    states: number
    transitions: number
    depth: number
    ms: number
    scenarios: ScenarioReport[]
    invariants: { id: InvariantId; held: boolean }[]
    counterexamples: Counterexample[]
}

function describe(act: Act): { actor: string; event: string } {
    const label = (op: string) => `${op} (${OP_SPECS[op].label})`
    switch (act.kind) {
        case "submit":
            return { actor: "Infra", event: `requests ${label(act.op)}` }
        case "verdict":
        case "verdict.read":
            return { actor: "Replay worker", event: `reports ${act.op} ${act.outcome}${act.claim === "current" ? ", claiming the current epoch" : ""}${act.kind === "verdict.read" ? " (checked, then awaiting)" : ""}` }
        case "verdict.write":
            return { actor: "Replay worker", event: `finishes writing the verdict for ${act.op}` }
        case "human":
            return { actor: "On-call engineer", event: `${act.approve ? "approves" : "denies"} ${act.op}${act.correct ? " with the sink corrected" : ""}` }
        case "commit":
            return { actor: "Court", event: `commits ${act.op}` }
        case "revoke":
            return { actor: "On-call engineer", event: "revokes Infra's authority" }
        case "restore":
            return { actor: "On-call engineer", event: "restores Infra's authority" }
    }
}

export function check(impl: Impl, scenario: Scenario): { report: ScenarioReport; counterexamples: Counterexample[] } {
    const t0 = performance.now()
    const start = initial()
    const parents = new Map<string, { parent: string | null; act: Act | null; changes: string[] }>()
    const startKey = keyOf(start)
    parents.set(startKey, { parent: null, act: null, changes: [] })
    let frontier: { key: string; sys: Sys }[] = [{ key: startKey, sys: start }]
    let transitions = 0
    let depth = 0
    const found = new Map<InvariantId, Counterexample>()
    const trace = (key: string, last: { act: Act; changes: string[] }): TraceStep[] => {
        const steps: TraceStep[] = []
        const push = (act: Act, changes: string[]) => steps.unshift({ ...describe(act), result: changes.join("; ") || "no change" })
        push(last.act, last.changes)
        let k: string | null = key
        while (k) {
            const p: { parent: string | null; act: Act | null; changes: string[] } = parents.get(k)!
            if (p.act) push(p.act, p.changes)
            k = p.parent
        }
        return steps
    }
    while (frontier.length) {
        const next: typeof frontier = []
        for (const { key, sys } of frontier) {
            for (const act of enabled(sys, scenario, impl)) {
                transitions++
                const step = apply(sys, act, impl)
                for (const inv of step.broken) if (!found.has(inv)) found.set(inv, { invariant: inv, scenario: scenario.id, steps: trace(key, { act, changes: step.changes }) })
                if (step.broken.length) continue // do not explore past a violation
                // A call that changed nothing only spent budget. Every future of the
                // poorer state is a future of this one, so skipping it loses nothing.
                if (coreOf(step.next) === coreOf(sys)) continue
                const k = keyOf(step.next)
                if (parents.has(k)) continue
                parents.set(k, { parent: key, act, changes: step.changes })
                next.push({ key: k, sys: step.next })
            }
        }
        if (next.length) depth++
        frontier = next
    }
    return {
        report: { scenario: scenario.id, states: parents.size, transitions, depth, ms: Math.round(performance.now() - t0), broken: [...found.keys()] },
        counterexamples: [...found.values()]
    }
}

export function checkImpl(impl: Impl): ImplReport {
    const scenarios: ScenarioReport[] = []
    const best = new Map<InvariantId, Counterexample>()
    for (const sc of SCENARIOS) {
        const r = check(impl, sc)
        scenarios.push(r.report)
        for (const cx of r.counterexamples) {
            const prev = best.get(cx.invariant)
            if (!prev || cx.steps.length < prev.steps.length) best.set(cx.invariant, cx)
        }
    }
    return {
        impl: impl.id,
        title: impl.title,
        description: impl.description,
        mutant: impl.mutant,
        states: scenarios.reduce((n, s) => n + s.states, 0),
        transitions: scenarios.reduce((n, s) => n + s.transitions, 0),
        depth: Math.max(...scenarios.map(s => s.depth)),
        ms: scenarios.reduce((n, s) => n + s.ms, 0),
        scenarios,
        invariants: INVARIANTS.map(i => ({ id: i.id, held: !best.has(i.id) })),
        counterexamples: [...best.values()].sort((a, b) => a.steps.length - b.steps.length)
    }
}

export function checkAll(): ImplReport[] {
    return IMPLEMENTATIONS.map(checkImpl)
}

export type { Op }
