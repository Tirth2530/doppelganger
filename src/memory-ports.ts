// In-memory actor ports, running the same Court logic the Court actor runs.
// Used by the tests and by `bun run live --memory` when the actor runtime is not up.

import * as court from "./court-logic.ts"
import type { ActorPorts, AgentLogPort, CourtPort, LineagePort } from "./ports.ts"
import type { CourtState, MessageRecord, StepRecord } from "./types.ts"

const now = () => new Date().toISOString()

export function memoryCourt(): CourtPort & { state: CourtState } {
    const port: CourtPort & { state: CourtState } = {
        state: court.initialState(),
        async getState() {
            return port.state
        },
        async checkScope(agent, action, args) {
            return court.checkScope(port.state, agent, action, args)
        },
        async recordDenied(input, reason) {
            const t = court.recordDenied(port.state, input, reason, now())
            port.state = t.state
            return t.op
        },
        async submit(input) {
            const t = court.submit(port.state, input, now())
            port.state = t.state
            return t.op
        },
        async verdict(opId, evidence, epoch) {
            const t = court.verdict(port.state, opId, evidence, epoch, now())
            port.state = t.state
            return t.op
        },
        async decide(opId, approve, by, corrected) {
            const t = court.decide(port.state, opId, approve, by, corrected, now())
            port.state = t.state
            return t.op
        },
        async commit(opId) {
            const t = court.commit(port.state, opId, now())
            port.state = t.state
            return t.op
        },
        async revoke(agent) {
            port.state = court.revoke(port.state, agent)
            return port.state.epoch
        },
        async restoreScopes() {
            port.state = court.restoreScopes(port.state)
            return port.state.epoch
        },
        async reset() {
            port.state = { ...court.initialState(), epoch: port.state.epoch + 1 }
            return port.state
        }
    }
    return port
}

export function memoryLineage(): LineagePort {
    const messages = new Map<string, MessageRecord>()
    return {
        async record(m) {
            messages.set(m.relayId, m)
            return m
        },
        async get(id) {
            return messages.get(id) ?? null
        },
        async all() {
            return [...messages.values()]
        }
    }
}

export function memoryLog(): AgentLogPort {
    const steps: StepRecord[] = []
    return {
        async append(step) {
            steps.push({ ...step, step: steps.length + 1, sentRelayIds: [] })
            return steps.length
        },
        async attachSent(step, relayId) {
            const s = steps[step - 1]
            if (s) s.sentRelayIds = [...s.sentRelayIds, relayId]
        },
        async steps() {
            return [...steps]
        }
    }
}

export function memoryPorts(runId = "local"): ActorPorts & { court: ReturnType<typeof memoryCourt> } {
    const logs = new Map<string, AgentLogPort>()
    return {
        runId,
        court: memoryCourt(),
        lineage: memoryLineage(),
        log(agent) {
            let l = logs.get(agent)
            if (!l) logs.set(agent, (l = memoryLog()))
            return l
        }
    }
}
