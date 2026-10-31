// How the harness reaches the actors. src/actor-clients.ts implements these with
// the generated Durable Actors client; src/memory-ports.ts implements them in
// memory with the same Court logic, for tests and for running without the
// actor runtime.

import type { ActionName, Args, CourtState, Evidence, MessageRecord, Op, ScopeDecision, StepRecord, SubmitInput } from "./types.ts"

export interface CourtPort {
    getState(): Promise<CourtState>
    checkScope(agent: string, action: ActionName, args: Args): Promise<ScopeDecision>
    recordDenied(input: SubmitInput, reason: string): Promise<Op>
    submit(input: SubmitInput): Promise<Op>
    verdict(opId: string, evidence: Evidence, epoch: number): Promise<Op>
    /** Attach explanatory evidence to an op that is not under review. Never changes state. */
    explain(opId: string, evidence: Evidence): Promise<Op>
    decide(opId: string, approve: boolean, by: string, corrected: Args | null): Promise<Op>
    commit(opId: string): Promise<Op>
    revoke(agent: string): Promise<number>
    restoreScopes(): Promise<number>
    reset(): Promise<CourtState>
}

export interface LineagePort {
    record(message: MessageRecord): Promise<MessageRecord>
    get(relayId: string): Promise<MessageRecord | null>
    all(): Promise<MessageRecord[]>
}

export interface AgentLogPort {
    append(step: Omit<StepRecord, "step" | "sentRelayIds">): Promise<number>
    attachSent(step: number, relayId: string): Promise<void>
    steps(): Promise<StepRecord[]>
}

/** One run: a fresh Lineage and AgentLogs, the same Court. */
export interface ActorPorts {
    runId: string
    court: CourtPort
    lineage: LineagePort
    log(agent: string): AgentLogPort
}
