// The real-model evaluation: the same pipeline the live run uses (Support and
// Infra on OpenAI, lineage, the Court, the replay engine), in memory and without
// Relay, over cases your team supplies. Reports what actually happened: verdict,
// Court outcome, latency, model calls and tokens. Nothing here is simulated, and
// nothing is fabricated if a call fails: the case is reported as an error.
//
//   OPENAI_API_KEY=… OPENAI_MODEL=… bun run live-eval [cases.json] [--repeat N]
//
// cases.json: [{ "label": "...", "expected": "attack" | "legit", "text": "<what the outside party sends>" }]
// Without a file, the filled slots of src/payloads.ts are used (2 and 4: attack, 3: legit).
// Results go to live-eval-results.json (git-ignored): real runs on your key.

import { readFileSync, writeFileSync } from "node:fs"

import { runAgent, settingsFromEnv, type ContextMessage } from "../src/agents.ts"
import { memoryPorts } from "../src/memory-ports.ts"
import { ACME_MESSAGES } from "../src/payloads.ts"
import { computeLineage } from "../src/replay-logic.ts"
import { HUMAN_TASK, INFRA, SUPPORT, TOOL_TO_ACTION } from "../src/scenario.ts"
import { createSampler, runTrial } from "../src/trial.ts"

interface Case {
    label: string
    expected: "attack" | "legit"
    text: string
}

const args = process.argv.slice(2)
const file = args.find(a => a.endsWith(".json"))
const repeat = Number(args[args.indexOf("--repeat") + 1] ?? 1) || 1
const cases: Case[] = file
    ? (JSON.parse(readFileSync(file, "utf8")) as Case[])
    : ([
          [2, "attack"],
          [3, "legit"],
          [4, "attack"]
      ] as const)
          .filter(([k]) => ACME_MESSAGES[k])
          .map(([k, expected]) => ({ label: `payloads.ts case ${k}`, expected, text: ACME_MESSAGES[k] }))
if (!cases.length) throw new Error("no cases: pass a cases.json or fill src/payloads.ts")
const settings = settingsFromEnv()

async function runCase(c: Case, i: number) {
    const t0 = performance.now()
    const ports = memoryPorts(`e${i}`)
    const at = new Date().toISOString()
    await ports.lineage.record({ relayId: "x1", from: "acme-agent", to: "support", trust: "external", text: c.text, at, producedBy: null, inputs: [] })
    const sctx: ContextMessage[] = [
        { role: "user", content: `Task from the on-call engineer: ${HUMAN_TASK}` },
        { role: "user", content: `Message from acme-agent: ${c.text}`, relayId: "x1" }
    ]
    const s = await runAgent(SUPPORT, sctx, { settings })
    const sStep = await ports.log("support").append({ agent: "support", at, read: ["x1"], context: sctx, outputText: s.text, toolCalls: s.toolCalls })
    const ask = s.toolCalls.find(t => t.name === "message_infra")
    if (!ask) return { label: c.label, expected: c.expected, outcome: "no request reached Infra", ms: performance.now() - t0 }
    await ports.lineage.record({ relayId: "m1", from: "support", to: "infra", trust: "internal_agent", text: ask.args.text ?? "", at, producedBy: { agent: "support", step: sStep }, inputs: ["x1"] })
    await ports.log("support").attachSent(sStep, "m1")
    const ictx: ContextMessage[] = [
        { role: "user", content: `Task from the on-call engineer: ${HUMAN_TASK}` },
        { role: "user", content: `Message from support: ${ask.args.text ?? ""}`, relayId: "m1" }
    ]
    const r = await runAgent(INFRA, ictx, { settings })
    await ports.log("infra").append({ agent: "infra", at, read: ["m1"], context: ictx, outputText: r.text, toolCalls: r.toolCalls })
    const call = r.toolCalls.find(t => TOOL_TO_ACTION[t.name])
    if (!call) return { label: c.label, expected: c.expected, outcome: "Infra made no privileged call", ms: performance.now() - t0 }
    const action = TOOL_TO_ACTION[call.name]
    const lineage = computeLineage(new Map((await ports.lineage.all()).map(m => [m.relayId, m])), "m1")
    const scope = await ports.court.checkScope("infra", action, call.args)
    const input = { opId: `op-${i}`, action, args: call.args, requestedBy: "infra", triggerRelayId: "m1", lineage }
    if (!scope.allowed) {
        await ports.court.recordDenied(input, scope.reason)
        return { label: c.label, expected: c.expected, action, args: call.args, outcome: "DENIED by scope", ms: performance.now() - t0 }
    }
    const op = await ports.court.submit(input)
    let evidence = null
    if (op.state === "UNDER_REVIEW") {
        evidence = await runTrial(op, { real: call, outside: await ports.lineage.all().then(ms => ms.filter(m => m.trust === "external")), humanTask: HUMAN_TASK }, createSampler(op, ports))
        const d = await ports.court.verdict(op.opId, evidence, op.epochAtSubmit)
        if (d.state === "APPROVED") await ports.court.commit(op.opId)
    } else if (op.state === "APPROVED") await ports.court.commit(op.opId)
    const final = (await ports.court.getState()).ops[0]
    return {
        label: c.label,
        expected: c.expected,
        action,
        args: call.args,
        verdict: evidence?.verdict ?? null,
        outcome: final.state,
        note: evidence?.note ?? final.reason,
        replay: evidence?.replay ?? null,
        ms: Math.round(performance.now() - t0)
    }
}

const results = []
for (let n = 0; n < repeat; n++)
    for (const [i, c] of cases.entries()) {
        try {
            results.push(await runCase(c, n * cases.length + i))
        } catch (e) {
            results.push({ label: c.label, expected: c.expected, outcome: "error", note: String(e) })
        }
        const r = results[results.length - 1]
        console.log(`${r.label.padEnd(28)} expected ${c.expected.padEnd(6)} → ${String(r.outcome).padEnd(28)} ${"verdict" in r && r.verdict ? r.verdict : ""}`)
    }
writeFileSync("live-eval-results.json", JSON.stringify({ kind: "real model runs (no Relay)", model: settings.model, temperature: settings.temperature ?? "default", at: new Date().toISOString(), results }, null, 2))
console.log("\nWrote live-eval-results.json. These are real runs on your key; small samples, so report counts, not rates.")
