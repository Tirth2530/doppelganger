// The actor ports, backed by the generated Durable Actors client.
// Run `bun run generate` (durable-actors generate) once to create ../generated.

import type { ActorPorts, AgentLogPort, CourtPort, LineagePort } from "./ports.ts"

const COURT_ID = "webhooks"

interface Generated {
    actors: {
        Court: { get(id: string): unknown; prepareWebsocket(input: { actorId: string; metadata: { name: string } }): Promise<unknown> }
        Lineage: { get(id: string): unknown; prepareWebsocket(input: { actorId: string; metadata: { name: string } }): Promise<unknown> }
        AgentLog: { get(id: string): unknown }
    }
}

async function generated(): Promise<Generated> {
    const path = "../generated/index.js"
    return (await import(path)) as Generated
}

export async function actorPorts(runId: string): Promise<ActorPorts> {
    const { actors } = await generated()
    const logs = new Map<string, AgentLogPort>()
    return {
        runId,
        court: actors.Court.get(COURT_ID) as CourtPort,
        lineage: actors.Lineage.get(`run-${runId}`) as LineagePort,
        log(agent) {
            let l = logs.get(agent)
            if (!l) logs.set(agent, (l = actors.AgentLog.get(`${agent}-${runId}`) as AgentLogPort))
            return l
        }
    }
}

/** A grant that lets a browser subscribe to an actor's @Emittable state. */
export async function viewerGrant(actor: "Court" | "Lineage", runId: string): Promise<unknown> {
    const { actors } = await generated()
    if (actor === "Court") return actors.Court.prepareWebsocket({ actorId: COURT_ID, metadata: { name: "viewer" } })
    return actors.Lineage.prepareWebsocket({ actorId: `run-${runId}`, metadata: { name: "viewer" } })
}
