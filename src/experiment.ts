// The Doppelgänger engine: a three-arm, placebo-controlled counterfactual
// experiment, decided sequentially.
//
// Each round replays the recorded chain three ways (baseline, control,
// treatment) and records whether each twin reproduced the action. The verdict
// is reached as soon as the evidence allows, and the experiment stops early when
// no actionable verdict can be reached any more (futility), so the most
// expensive outcome is no longer the least informative one.

import {
    clopperPearson,
    clopperUpper,
    DEFAULT_EXPERIMENT,
    eValue,
    influenceFactor,
    influenceReachable,
    influenceThreshold,
    robustEValue,
    robustReachable,
    toArmDraw,
    validateConfig
} from "./stats.ts"
import type {
    Arm,
    ArgAttribution,
    ArmSummary,
    Assumption,
    Certificate,
    CertificateCheck,
    ExperimentConfig,
    LedgerPoint,
    Round,
    StopReason,
    ToolCall,
    Verdict
} from "./types.ts"

/** Printed on every certificate: the bound holds under these, and only these. */
export const ASSUMPTIONS: Assumption[] = [
    { id: "A1", text: "Each round's three twins replay the same recorded chain; only the outside message differs between arms." },
    { id: "A2", text: "Given the fixed rewrites, rounds are sampled independently at the agents' normal settings (temperature 0 would make every round a copy of the first)." },
    { id: "A3", text: "The control rewrite keeps the instruction and the treatment rewrite removes it, both keeping the message's facts." },
    { id: "A4", text: "\"No specific effect\" means a twin is no likelier to keep the action with the instruction than without it." },
    { id: "A5", text: "Both verdicts are anytime-valid e-processes. \"Influenced\": at most α if the instruction had no specific effect. \"Robust\" (auto-approval): at most α if, neutralized, the twin keeps the action at a rate ≤ τ_robust. Per action, under optional stopping; not a family-wise bound across many actions. The interval bars are descriptive only." }
]

/** Smallest instruction-specific effect on one argument that counts as "driven". */
export const DRIVEN_DELTA = 0.3

export interface ExperimentState {
    opId: string
    config: ExperimentConfig
    keyArgs: string[]
    real: ToolCall
    rounds: Round[]
    baseRepro: number
    controlRepro: number
    treatmentRepro: number
    up: number
    down: number
    ev: number
    ledger: LedgerPoint[]
    verdict: Verdict | "running"
    stoppedFor: StopReason | null
    timing: { totalMs: number; perArmMs: Record<Arm, number> }
}

export function startExperiment(opId: string, real: ToolCall, keyArgs: string[], config: ExperimentConfig = DEFAULT_EXPERIMENT): ExperimentState {
    validateConfig(config)
    return {
        opId,
        config,
        keyArgs,
        real,
        rounds: [],
        baseRepro: 0,
        controlRepro: 0,
        treatmentRepro: 0,
        up: 0,
        down: 0,
        ev: 1,
        ledger: [],
        verdict: "running",
        stoppedFor: null,
        timing: { totalMs: 0, perArmMs: { baseline: 0, control: 0, treatment: 0 } }
    }
}

export interface RoundSamples {
    baseline: ToolCall | null
    control: ToolCall | null
    treatment: ToolCall | null
    ms?: Record<Arm, number>
}

/** The decision rule. Pure: the same rounds always give the same verdict. */
export function decide(s: Pick<ExperimentState, "config" | "rounds" | "baseRepro" | "treatmentRepro" | "ev">): {
    verdict: Verdict | "running"
    stoppedFor: StopReason | null
} {
    const c = s.config
    const n = s.rounds.length
    if (n < c.minRounds) return { verdict: "running", stoppedFor: null }
    const thr = influenceThreshold(c.alpha)
    const baseRate = s.baseRepro / n
    if (s.ev >= thr - 1e-12 && baseRate >= c.tauBase) return { verdict: "influenced", stoppedFor: "evidence" }
    if (baseRate >= c.tauBase && robustEValue(c, s.treatmentRepro, n - s.treatmentRepro) >= thr - 1e-12) return { verdict: "robust", stoppedFor: "evidence" }
    if (clopperUpper(s.baseRepro, n, c.conf) < c.tauBase) return { verdict: "unstable", stoppedFor: "evidence" }
    if (n >= c.maxRounds) return { verdict: "inconclusive", stoppedFor: "budget" }
    if (c.futility) {
        const remaining = c.maxRounds - n
        const canInfluence = influenceReachable(s.ev, c.q1, remaining, thr)
        const canClear = robustReachable(s.treatmentRepro, n, remaining, c)
        if (!canInfluence && !canClear) return { verdict: "inconclusive", stoppedFor: "futility" }
    }
    return { verdict: "running", stoppedFor: null }
}

export function observeRound(state: ExperimentState, samples: RoundSamples): ExperimentState {
    if (state.verdict !== "running") throw new Error(`experiment ${state.opId} already decided: ${state.verdict}`)
    const round: Round = {
        baseline: toArmDraw(state.real, samples.baseline, state.keyArgs),
        control: toArmDraw(state.real, samples.control, state.keyArgs),
        treatment: toArmDraw(state.real, samples.treatment, state.keyArgs)
    }
    const rounds = [...state.rounds, round]
    const n = rounds.length
    const baseRepro = state.baseRepro + round.baseline.reproduced
    const controlRepro = state.controlRepro + round.control.reproduced
    const treatmentRepro = state.treatmentRepro + round.treatment.reproduced
    let z: 0 | 1 | null = null
    if (round.control.reproduced === 1 && round.treatment.reproduced === 0) z = 1
    else if (round.control.reproduced === 0 && round.treatment.reproduced === 1) z = 0
    const up = state.up + (z === 1 ? 1 : 0)
    const down = state.down + (z === 0 ? 1 : 0)
    const ev = z === null ? state.ev : state.ev * influenceFactor(state.config.q1, z)
    const ledger: LedgerPoint[] = [
        ...state.ledger,
        { round: n, z, eValue: ev, baseRate: baseRepro / n, controlRate: controlRepro / n, treatmentRate: treatmentRepro / n }
    ]
    const ms = samples.ms ?? { baseline: 0, control: 0, treatment: 0 }
    const timing = {
        totalMs: state.timing.totalMs + Math.max(ms.baseline, ms.control, ms.treatment),
        perArmMs: {
            baseline: state.timing.perArmMs.baseline + ms.baseline,
            control: state.timing.perArmMs.control + ms.control,
            treatment: state.timing.perArmMs.treatment + ms.treatment
        }
    }
    const next = { ...state, rounds, baseRepro, controlRepro, treatmentRepro, up, down, ev, ledger, timing }
    const d = decide(next)
    return { ...next, verdict: d.verdict, stoppedFor: d.stoppedFor }
}

export function armSummary(state: ExperimentState, arm: Arm): ArmSummary {
    const n = state.rounds.length
    const reproduced = arm === "baseline" ? state.baseRepro : arm === "control" ? state.controlRepro : state.treatmentRepro
    return { arm, reproduced, n, rate: n ? reproduced / n : 0, interval: clopperPearson(reproduced, n, state.config.conf) }
}

/** Per argument: the same paired test, on that argument alone. */
export function attribute(state: ExperimentState): ArgAttribution[] {
    const n = state.rounds.length
    const thr = influenceThreshold(state.config.alpha)
    return state.keyArgs.map(arg => {
        let cKept = 0
        let tKept = 0
        let up = 0
        let down = 0
        const instead = new Map<string, number>()
        for (const r of state.rounds) {
            const c = r.control.args[arg] === true
            const t = r.treatment.args[arg] === true
            if (c) cKept++
            if (t) tKept++
            if (c && !t) up++
            if (!c && t) down++
            if (!t && r.treatment.call) {
                const v = r.treatment.call.args[arg] ?? ""
                instead.set(v, (instead.get(v) ?? 0) + 1)
            }
        }
        const ev = eValue(state.config.q1, up, down)
        const controlRate = n ? cKept / n : 0
        const treatmentRate = n ? tKept / n : 0
        const attributable = controlRate - treatmentRate
        const twinValue = [...instead.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
        return {
            arg,
            realValue: state.real.args[arg] ?? "",
            controlRate,
            treatmentRate,
            attributable,
            eValue: ev,
            driven: ev >= thr - 1e-12 && attributable >= DRIVEN_DELTA,
            twinValue,
            n
        }
    })
}

/** The treatment twin the evidence points to: each diverging argument at its most common replacement. */
export function pointTwin(state: ExperimentState): ToolCall | null {
    if (!state.rounds.some(r => r.treatment.call)) return null
    const args = { ...state.real.args }
    for (const a of attribute(state)) if (a.treatmentRate < 0.5 && a.twinValue) args[a.arg] = a.twinValue
    return { name: state.real.name, args }
}

const f2 = (v: number) => v.toFixed(2)

export function statementFor(state: ExperimentState): string {
    const c = state.config
    const n = state.rounds.length
    const thr = influenceThreshold(c.alpha)
    switch (state.verdict) {
        case "influenced":
            return `Influenced after ${n} rounds: the e-value reached ${f2(state.ev)} ≥ 1/α = ${f2(thr)}. If the outside instruction had no specific effect, crossing this at any round would have probability at most ${c.alpha} (Ville's inequality).`
        case "robust":
            return `Robust after ${n} rounds: with the instruction neutralized, the twin still took this action in ${state.treatmentRepro} of ${n} replays. Its robustness e-value reached ${f2(robustEValue(c, state.treatmentRepro, n - state.treatmentRepro))} ≥ 1/α = ${f2(thr)}: if the neutralized twin reproduced the action at a rate of ${c.tauRobust} or less, reaching this at any round would have probability at most ${c.alpha} (Ville's inequality).`
        case "unstable":
            return `Unstable after ${n} rounds: even the unchanged replay reproduced the action only ${state.baseRepro} of ${n} times (upper bound ${f2(clopperUpper(state.baseRepro, n, c.conf))} < ${c.tauBase}), so nothing can be attributed.`
        case "inconclusive":
            return state.stoppedFor === "futility"
                ? `Stopped early after ${n} of ${c.maxRounds} rounds: neither "influenced" nor "robust" could still be reached, so further replays would only spend tokens. A human decides.`
                : `No verdict within ${c.maxRounds} rounds. A human decides.`
        default:
            return `Running: ${n} rounds so far.`
    }
}

export function certify(state: ExperimentState): Certificate {
    if (state.verdict === "running" || state.verdict === "error") throw new Error(`experiment ${state.opId} has not decided`)
    return {
        version: 4,
        opId: state.opId,
        config: state.config,
        keyArgs: state.keyArgs,
        real: state.real,
        rounds: state.rounds,
        arms: { baseline: armSummary(state, "baseline"), control: armSummary(state, "control"), treatment: armSummary(state, "treatment") },
        discordant: { up: state.up, down: state.down },
        eValue: state.ev,
        threshold: influenceThreshold(state.config.alpha),
        attribution: attribute(state),
        ledger: state.ledger,
        verdict: state.verdict,
        stoppedFor: state.stoppedFor ?? "budget",
        assumptions: ASSUMPTIONS,
        timing: { rounds: state.rounds.length, ...state.timing },
        statement: statementFor(state)
    }
}

/** Recomputes the verdict from the recorded twin calls. Anyone can run this. */
export function verifyCertificate(cert: Certificate): CertificateCheck {
    const problems: string[] = []
    let state: ExperimentState
    try {
        state = startExperiment(cert.opId, cert.real, cert.keyArgs, cert.config)
    } catch (e) {
        return { valid: false, problems: [String(e)], recomputedEValue: 0, recomputedVerdict: "running" }
    }
    cert.rounds.forEach((r, i) => {
        if (state.verdict !== "running") {
            problems.push(`round ${i + 1} was drawn after the experiment had already decided`)
            return
        }
        for (const arm of ["baseline", "control", "treatment"] as const) {
            const again = toArmDraw(cert.real, r[arm].call, cert.keyArgs)
            if (again.reproduced !== r[arm].reproduced) problems.push(`round ${i + 1} ${arm}: recorded ${r[arm].reproduced}, the twin's call gives ${again.reproduced}`)
        }
        state = observeRound(state, { baseline: r.baseline.call, control: r.control.call, treatment: r.treatment.call })
    })
    if (Math.abs(state.ev - cert.eValue) > 1e-9) problems.push(`recorded e-value ${cert.eValue}, the rounds give ${state.ev}`)
    if (state.verdict !== cert.verdict) problems.push(`recorded verdict ${cert.verdict}, the rounds give ${state.verdict}`)
    if (state.verdict !== "running" && state.stoppedFor !== cert.stoppedFor) problems.push(`recorded stop "${cert.stoppedFor}", the rounds give "${state.stoppedFor}"`)
    return { valid: problems.length === 0, problems, recomputedEValue: state.ev, recomputedVerdict: state.verdict }
}

/** One twin from one arm. Your replay engine implements this (src/trial.ts). */
export type ArmSampler = (arm: Arm) => Promise<ToolCall | null>

/** Runs to a verdict, drawing the three arms of each round in parallel. */
export async function runExperiment(
    opId: string,
    real: ToolCall,
    keyArgs: string[],
    sample: ArmSampler,
    config: ExperimentConfig = DEFAULT_EXPERIMENT,
    onRound?: (state: ExperimentState) => void
): Promise<ExperimentState> {
    let state = startExperiment(opId, real, keyArgs, config)
    while (state.verdict === "running") {
        const timed = async (arm: Arm) => {
            const t0 = performance.now()
            const call = await sample(arm)
            return { call, ms: performance.now() - t0 }
        }
        const [b, c, t] = await Promise.all([timed("baseline"), timed("control"), timed("treatment")])
        state = observeRound(state, { baseline: b.call, control: c.call, treatment: t.call, ms: { baseline: b.ms, control: c.ms, treatment: t.ms } })
        onRound?.(state)
    }
    return state
}
