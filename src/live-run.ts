// The live run: real OpenAI agents talking over Agent Relay, the Court as a
// Durable Actor owning the privileged actions, the dashboard streaming it all.
//
//   relay init                       local Relaycast server + workspace (no account)
//   durable-actors dev               the actor runtime (or pass --memory)
//   bun run generate                 the typed actor client
//   OPENAI_API_KEY=… OPENAI_MODEL=… RELAY_WORKSPACE_KEY=… bun run live
//   open http://localhost:3000/?mode=live

import { AgentRelay, type AgentRelayAgent, type RelayAgentClient, type RelayMessageEvent } from "@agent-relay/sdk"

import { runAgent, type ContextMessage } from "./agents.ts"
import { actorPorts } from "./actor-clients.ts"
import { viewOf } from "./events.ts"
import { hub } from "./live.ts"
import { memoryPorts } from "./memory-ports.ts"
import { ACME_MESSAGES } from "./payloads.ts"
import type { ActorPorts } from "./ports.ts"
import { actionInput, sendTracked, wireCourt } from "./relay-wiring.ts"
import { HUMAN_TASK, INFRA, SUPPORT, TOOL_TO_ACTION, type AgentSpec } from "./scenario.ts"
import { startServer } from "./server.ts"
import { createSampler, runTrial } from "./trial.ts"
import type { Op } from "./types.ts"

type Agent = RelayAgentClient & AgentRelayAgent

const runId = Math.random().toString(16).slice(2, 6)
const name = (role: string) => `${role}-${runId}`
const ROLES = ["court", "oncall", "acme-agent", "support", "infra"] as const

async function main() {
    const workspaceKey = process.env.RELAY_WORKSPACE_KEY
    if (!workspaceKey) throw new Error("RELAY_WORKSPACE_KEY is not set (run `relay init`, then export the key it prints)")
    const ports: ActorPorts = process.argv.includes("--memory") ? memoryPorts(runId) : await actorPorts(runId)

    const relay = new AgentRelay({ workspaceKey, baseUrl: process.env.RELAY_BASE_URL })
    // Agent clients carry registerAction / capabilities at runtime (agentRelayAgent in the SDK).
    const clients = (await relay.workspace.register(ROLES.map(name))) as unknown as Agent[]
    const agent = Object.fromEntries(ROLES.map((r, i) => [r, clients[i]])) as Record<(typeof ROLES)[number], Agent>
    const roster = {
        external: [name("acme-agent")],
        humans: [name("oncall")],
        roles: Object.fromEntries(ROLES.map(r => [name(r), r]))
    }

    const review = async (op: Op) => {
        const outside = (await ports.lineage.all()).filter(m => op.lineage.externalRelayIds.includes(m.relayId))
        const origin = op.lineage.externalRelayIds[0] ?? ""
        const evidence = await runTrial(
            op,
            { real: { name: op.action.replace(".", "_"), args: op.args }, outside, humanTask: HUMAN_TASK, onRound: s => hub.emit({ type: "experiment", view: viewOf(s, op.lineage.hops, origin) }) },
            createSampler(op, ports)
        )
        const decided = await ports.court.verdict(op.opId, evidence, op.epochAtSubmit)
        if (decided.state === "APPROVED") await ports.court.commit(op.opId)
        hub.emit({ type: "court", state: await ports.court.getState() })
    }

    wireCourt({ host: agent.court, stream: relay, ports, roster, emit: hub.emit, onReview: op => void review(op) })

    // Each agent answers the messages addressed to it, through the model, and logs the exact context.
    const think = async (spec: AgentSpec, me: Agent, message: RelayMessageEvent<"message.created">["message"]) => {
        hub.emit({ type: "agent", agent: spec.role, status: "thinking", note: `reading ${message.id}` })
        const context: ContextMessage[] = [
            { role: "user", content: `Task from the on-call engineer: ${HUMAN_TASK}` },
            { role: "user", content: `Message from ${roster.roles[message.from.name ?? ""] ?? message.from.name}: ${message.text}`, relayId: message.id }
        ]
        const result = await runAgent(spec, context)
        const step = await ports.log(spec.role).append({ agent: spec.role, at: new Date().toISOString(), read: [message.id], context, outputText: result.text, toolCalls: result.toolCalls })
        for (const call of result.toolCalls) {
            if (call.name === "message_infra") {
                const sent = await sendTracked(me, name("infra"), call.args.text ?? "", [message.id], step)
                await ports.log(spec.role).attachSent(step, sent.id)
            } else if (TOOL_TO_ACTION[call.name]) {
                hub.emit({ type: "agent", agent: spec.role, status: "acting", note: `invoking ${TOOL_TO_ACTION[call.name]}` })
                await me.capabilities.invoke(TOOL_TO_ACTION[call.name], actionInput(call.args, message.id))
            }
        }
        hub.emit({ type: "agent", agent: spec.role, status: "idle", note: "" })
    }

    relay.addListener("message.created", ({ message }: RelayMessageEvent<"message.created">) => {
        const to = message.target?.kind === "agent" ? message.target.agentName : ""
        if (to === name("support") && message.from.name !== name("support")) void think(SUPPORT, agent.support, message)
        if (to === name("infra") && message.from.name !== name("infra")) void think(INFRA, agent.infra, message)
    })

    hub.onCommand(async c => {
        const court = ports.court
        switch (c.kind) {
            case "run":
                if (c.beat === 0) {
                    await agent.oncall.sendMessage({ to: name("infra"), text: "Please raise webhooks logging to debug on our internal sink (internal://logs/webhooks)." })
                } else {
                    const text = ACME_MESSAGES[c.beat as 1 | 2 | 3 | 4]
                    if (!text) return hub.emit({ type: "narrate", text: `Case ${c.beat} has no message yet (src/payloads.ts).` })
                    await agent.oncall.sendMessage({ to: name("support"), text: HUMAN_TASK })
                    await agent["acme-agent"].sendMessage({ to: name("support"), text })
                }
                break
            case "revoke":
                await court.revoke("infra")
                break
            case "restore":
                await court.restoreScopes()
                break
            case "reset":
                await court.reset()
                hub.emit({ type: "reset", mode: "live" })
                break
            case "decide": {
                const op = await court.decide(c.opId, c.approve, "on-call engineer", c.corrected)
                if (op.state === "APPROVED") await court.commit(op.opId)
                break
            }
        }
        hub.emit({ type: "court", state: await court.getState() })
    })

    const server = startServer()
    hub.emit({ type: "reset", mode: "live" })
    hub.emit({ type: "court", state: await ports.court.getState() })
    console.log(`Live run ${runId}: http://localhost:${server.port}/?mode=live`)
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
