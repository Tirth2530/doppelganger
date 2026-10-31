// Doppelgänger's shared vocabulary.
//
// The question the whole system answers: may this agent take this action, or
// is it exercising authority that no human intended to give it?
//
// Two layers answer it, and neither does the other's job:
//   SAFETY   — the Court. Deterministic: scope, an authorization epoch used as
//              a fencing token, and serialized state on a Durable Actor. It can
//              deny on its own and never relies on a statistic.
//   EVIDENCE — the Doppelgänger engine. Advisory: a three-arm counterfactual
//              experiment that asks whether the action survives removing the
//              outside instruction. It never auto-denies; it can only clear an
//              action for automatic approval or hand it to a human.

export type Trust = "human" | "internal_agent" | "external"

export type ActionName = "logging.configure" | "access.grant"

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"

export type Args = { [key: string]: string }

export interface ToolCall {
    name: string
    args: Args
}

// ---- provenance --------------------------------------------------------------

/** One Agent Relay message, as the Lineage actor records it. */
export interface MessageRecord {
    relayId: string
    from: string
    to: string
    trust: Trust
    text: string
    at: string
    /** The agent step that produced it; null for messages from outside our harness. */
    producedBy: { agent: string; step: number } | null
    /** Relay ids the producing agent had read. Always empty for outside messages. */
    inputs: string[]
}

/** How a request descends from outside content. */
export interface LineageSummary {
    tainted: boolean
    /** Outside messages this request descends from. */
    externalRelayIds: string[]
    /** Relay ids from the trigger back to the outside origin. */
    chain: string[]
    /** Internal hops between the outside origin and the privileged action. */
    hops: number
}

/** One model call, kept in the agent's AgentLog actor so it can be replayed. */
export interface StepRecord {
    step: number
    agent: string
    at: string
    /** Relay ids this call read. */
    read: string[]
    /** The exact context the model saw. */
    context: { role: "system" | "user"; content: string; relayId?: string }[]
    outputText: string
    toolCalls: ToolCall[]
    sentRelayIds: string[]
}

// ---- the evidence layer: a three-arm experiment ---------------------------
//
// Removing an instruction changes two things at once: the instruction itself
// AND the message's wording. A before/after replay cannot separate them, which
// is why single-agent replay cries "attack" at requests that merely sound
// alarming. So every round replays the same recorded chain three ways:
//
//   baseline   the outside message unchanged    is the action even reproducible?
//   control    reworded, instruction KEPT       the placebo: wording only
//   treatment  instruction neutralized          the instruction's effect
//
// control and treatment share the rewording and differ only in whether the
// instruction survives, so comparing them isolates the instruction.

export type Arm = "baseline" | "control" | "treatment"

export const ARMS: Arm[] = ["baseline", "control", "treatment"]

/** One arm's sample in one round. */
export interface ArmDraw {
    /** 1 if the twin reproduced the action: same tool and every key argument equal. */
    reproduced: 0 | 1
    /** The twin called the same tool at all. */
    tool: boolean
    /** Per key argument: same tool and same value. */
    args: Record<string, boolean>
    call: ToolCall | null
}

export interface Round {
    baseline: ArmDraw
    control: ArmDraw
    treatment: ArmDraw
}

/**
 * influenced    the instruction drove the action (false-positive rate ≤ α, Ville)
 * robust        the action survives neutralizing the instruction (auto-approvable)
 * unstable      not even the unchanged replay reproduces the action
 * inconclusive  no verdict was reached, or none could be reached any more
 */
export type Verdict = "influenced" | "robust" | "unstable" | "inconclusive" | "error"

export interface ExperimentConfig {
    /** Lean of the alternative for the paired sign test on disagreeing rounds (> 0.5). */
    q1: number
    /** Bound on P(declare "influenced") when the instruction has no specific effect. */
    alpha: number
    /** Confidence for the descriptive Clopper–Pearson intervals and the "unstable" check (which only ever sends an action to a human). */
    conf: number
    /** Baseline reproduction rate needed before any verdict is trusted. */
    tauBase: number
    /** Null boundary for the robust e-process: "robust" is claimed only against treatment rates ≤ this. */
    tauRobust: number
    /** Alternative for the robust e-process: the treatment reproduction rate it bets on (> tauRobust). */
    qRobust: number
    minRounds: number
    maxRounds: number
    /** Stop early when neither "influenced" nor "robust" can still be reached. */
    futility: boolean
}

export interface Interval {
    lower: number
    upper: number
}

export interface ArmSummary {
    arm: Arm
    reproduced: number
    n: number
    rate: number
    interval: Interval
}

/** Per argument: did the instruction drive this specific value? */
export interface ArgAttribution {
    arg: string
    realValue: string
    controlRate: number
    treatmentRate: number
    /** controlRate − treatmentRate: the instruction's specific effect on this argument. */
    attributable: number
    /** The paired e-process on this argument alone. */
    eValue: number
    /** That e-process crossed 1/α and the effect is material. */
    driven: boolean
    /** What the treatment twins chose instead, when they diverged. */
    twinValue: string
    n: number
}

export interface Assumption {
    id: string
    text: string
}

export interface Timing {
    rounds: number
    totalMs: number
    perArmMs: Record<Arm, number>
}

export interface LedgerPoint {
    round: number
    /** 1: control kept the action and treatment dropped it. 0: the reverse. null: the arms agreed. */
    z: 0 | 1 | null
    eValue: number
    baseRate: number
    controlRate: number
    treatmentRate: number
}

export type StopReason = "evidence" | "futility" | "budget"

/** An auditable record: anyone can recompute the verdict from the rounds. */
export interface Certificate {
    version: 4
    opId: string
    config: ExperimentConfig
    keyArgs: string[]
    real: ToolCall
    rounds: Round[]
    arms: Record<Arm, ArmSummary>
    discordant: { up: number; down: number }
    eValue: number
    threshold: number
    attribution: ArgAttribution[]
    ledger: LedgerPoint[]
    verdict: Exclude<Verdict, "error">
    stoppedFor: StopReason
    assumptions: Assumption[]
    timing: Timing
    statement: string
}

export interface CertificateCheck {
    valid: boolean
    problems: string[]
    recomputedEValue: number
    recomputedVerdict: Verdict | "running"
}

export interface ValueFinding {
    arg: string
    value: string
    relayId: string
}

export interface ArgDiff {
    arg: string
    real: string
    counterfactual: string
}

/** What the evidence layer hands the Court. */
export interface Evidence {
    verdict: Verdict
    diffs: ArgDiff[]
    realCall: ToolCall
    counterfactualCall: ToolCall | null
    originRelayId: string
    /** Key values that appear only in outside content: always a human's call. */
    valueProvenance: ValueFinding[]
    rounds: number
    note: string
    certificate: Certificate | null
    /** What the replay cost, when a real replay ran (absent for the simulation). */
    replay?: { modelCalls: number; rewriteCalls: number; promptTokens: number; completionTokens: number; ms: number; model?: string }
}

// ---- the safety layer: the Court -------------------------------------------

export type OpState = "PENDING" | "UNDER_REVIEW" | "APPROVED" | "HELD" | "DENIED" | "EXECUTED"

export interface OpHistoryEntry {
    state: OpState
    at: string
    note: string
}

export interface Op {
    opId: string
    action: ActionName
    args: Args
    requestedBy: string
    triggerRelayId: string
    lineage: LineageSummary
    state: OpState
    /** The epoch the Court stamped at submission: the fence for every later verdict. */
    epochAtSubmit: number
    epochAtApproval: number
    evidence: Evidence | null
    reason: string
    decidedBy: string
    createdAt: string
    history: OpHistoryEntry[]
}

export interface Scope {
    agent: string
    action: ActionName
    service: string
    /** Highest log level allowed for logging.configure; empty for other actions. */
    maxLevel: string
    /**
     * Values the human authorized in advance, per argument, as prefixes (e.g. sink: ["internal://"]).
     * Not a deny list: any in-scope value is allowed. But a value outside this list that reaches the
     * privileged agent through outside content has no human authorization behind it, so the Court
     * holds it for a human at once, deterministically, without waiting for evidence.
     */
    preauthorized?: Record<string, string[]>
}

/** The protected resource. Only the Court writes it. */
export interface ServiceConfig {
    service: string
    logLevel: string
    logSink: string
    prodAccessKeys: string[]
}

export interface CourtState {
    epoch: number
    scopes: Scope[]
    config: ServiceConfig
    ops: Op[]
}

export interface ScopeDecision {
    allowed: boolean
    reason: string
}

export interface SubmitInput {
    opId: string
    action: ActionName
    args: Args
    requestedBy: string
    triggerRelayId: string
    lineage: LineageSummary
}
