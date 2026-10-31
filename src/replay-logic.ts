// Provenance: where a request came from, and what in it came from outside.

import { attribute, certify, pointTwin, type ExperimentState } from "./experiment.ts"
import { INTERNAL_DEFAULT_SINK } from "./court-logic.ts"
import { normalizeValue } from "./stats.ts"
import type { ActionName, ArgDiff, Evidence, LineageSummary, MessageRecord, ToolCall, ValueFinding } from "./types.ts"

/** The arguments that carry each action's authority. */
export const KEY_ARGS: Record<ActionName, string[]> = {
    "logging.configure": ["service", "sink"],
    "access.grant": ["service", "environment", "public_key"]
}

/**
 * Walks from the message that triggered an action back through every message
 * each agent had read. Anything outside the harness, or anything we cannot
 * account for, is a taint origin: unknown provenance is treated as outside.
 */
export function computeLineage(messages: Map<string, MessageRecord>, triggerRelayId: string): LineageSummary {
    const external = new Set<string>()
    const chain: string[] = []
    const seen = new Set<string>()
    let hops = 0
    const walk = (id: string) => {
        if (seen.has(id)) return
        seen.add(id)
        const m = messages.get(id)
        if (!m) {
            external.add(id || "(unattributed)")
            return
        }
        chain.push(id)
        if (m.trust === "external") {
            external.add(id)
            return
        }
        if (m.trust === "internal_agent") hops++
        for (const input of m.inputs) walk(input)
    }
    walk(triggerRelayId)
    return { tainted: external.size > 0, externalRelayIds: [...external], chain, hops }
}

/**
 * Key values that appear in outside content and nowhere in the human's task.
 * Twins can agree on a value precisely because they all read it in the same
 * message, so a laundered VALUE always goes to a human even when the action's
 * shape is robust.
 */
export function traceValues(action: ActionName, args: Record<string, string>, outside: MessageRecord[], humanTask: string): ValueFinding[] {
    const task = normalizeValue(humanTask)
    const findings: ValueFinding[] = []
    for (const arg of KEY_ARGS[action]) {
        const value = args[arg]
        if (!value || arg === "service") continue
        const v = normalizeValue(value)
        if (arg === "sink" && (v.startsWith("internal://") || v === normalizeValue(INTERNAL_DEFAULT_SINK))) continue
        if (task.includes(v)) continue
        const source = outside.find(m => normalizeValue(m.text).includes(v))
        if (source) findings.push({ arg, value, relayId: source.relayId })
    }
    return findings
}

export function evidenceFromExperiment(state: ExperimentState, originRelayId: string, valueProvenance: ValueFinding[]): Evidence {
    if (state.verdict === "running" || state.verdict === "error") throw new Error(`experiment ${state.opId} has not decided`)
    const certificate = certify(state)
    const diffs: ArgDiff[] = attribute(state)
        .filter(a => a.driven || a.treatmentRate < 0.5)
        .map(a => ({ arg: a.arg, real: a.realValue, counterfactual: a.twinValue }))
    return {
        verdict: state.verdict,
        diffs,
        realCall: state.real,
        counterfactualCall: pointTwin(state),
        originRelayId,
        valueProvenance,
        rounds: state.rounds.length,
        note: certificate.statement,
        certificate
    }
}

export function errorEvidence(real: ToolCall, originRelayId: string, note: string): Evidence {
    return { verdict: "error", diffs: [], realCall: real, counterfactualCall: null, originRelayId, valueProvenance: [], rounds: 0, note, certificate: null }
}
