# Integrating with the team's live setup

Notes for wiring this repo into the separate environment on Tirth's laptop
(`~/doppelganger`, `~/doppelganger-actors`). Nothing here has been run against
that environment from this repo; each step says what to check.

## The two Courts are different actors

The Court in `~/doppelganger-actors` has a different interface from ours:

| | theirs | this repo (`src/actors.ts`) |
|---|---|---|
| submit | `submit(opId, agent, action, target)` | `submit(input: SubmitInput)` with args, trigger relay id and lineage |
| verdict | `verdict(opId, epoch, recommendation)` | `verdict(opId, evidence, epoch)`; evidence never denies |
| states | UNDER_REVIEW / HELD / APPROVED / DENIED / EXECUTED | PENDING / UNDER_REVIEW / APPROVED / HELD / DENIED / EXECUTED |
| epoch | starts at 0 | starts at 1; fenced at verdict *and* at commit |
| human decision, commit, scope | — | `decide`, `commit`, `checkScope`, `revoke`, `restoreScopes`, `recordDenied` |

The runner here calls our interface (`src/ports.ts`), and the model checker
verifies our Court logic (`src/court-logic.ts`). So deploy **our** actors:

1. Copy `src/actors.ts`, `src/court-logic.ts`, `src/types.ts` into the actors project (or point it at this repo), then `bun run check` there.
2. `bunx durable-actors dev` (local control plane at `http://127.0.0.1:7100`), then `bunx durable-actors generate` so `generated/` exists here (`bun run generate`).
3. Use a fresh Court id: `COURT_ID=webhooks-<anything>`. The id `doppelganger-demo` is already revoked in that database; do not reuse it, and do not delete persisted state.
4. Or skip actors entirely for the demo: `bun run live --memory` runs the same Court logic in memory.

Check: the dashboard's Court docket shows epoch 1 and the infra scope after start.

## Relay

Local Relaycast: `npx -y agent-relay@next init` (server at `http://127.0.0.1:8787`), then set `RELAY_WORKSPACE_KEY` and `RELAY_BASE_URL`.

### The caller-identity issue

In that setup the action caller surfaced as `node` or `undefined`, and the workaround was `availableTo: [{name:"infra"},{name:"node"}]` with "infra" hardcoded. This repo does **not** do that:

- `callerRole()` (`src/relay-wiring.ts`) gives a role only to a name in this run's roster (`infra-<runId>`, `support-<runId>`). `node`, `undefined`, a bare `infra`, outsiders and humans get none, and the policy refuses them.
- `availableTo` is `[support-<runId>, infra-<runId>]`.

So if the local Relay server still reports `node` as the caller, **live privileged actions will be refused** (fail closed): every request shows as DENIED with `caller "node" is not a registered agent`. That is the correct behaviour for a security product. To fix it at the source:

1. Check what the server sends: `relay.addListener(handle.invoked(), e => console.log(e.agent))` on the Court agent, then invoke as Infra. The SDK passes `event.callerName` from the server's `action.invoked` event (`facade.ts`, `handleActionInvoked`); if that is `node`, the Relay server is attributing the call to the SDK process rather than the agent.
2. Make sure each agent invokes with its **own** agent client (`agent.infra.capabilities.invoke(...)`, as `src/live-run.ts` does), not the workspace client.
3. If the server can't attribute agent callers in this version, the one safe alternative is an identity the server proves (e.g. `RelayActionInvocation.callerId` fetched via `commands.getInvocation`) mapped to the agent ids returned by `workspace.register`. Do not map `node` to Infra.

Check: `bun test test/relay-wiring.test.ts` covers the refusal cases; a live run with the Infra agent should show `requestedBy: infra` in the docket.

### `action.completed` is not "executed"

Relay's `action.completed` means the Court's handler returned. The handler returns `{ opId, state }`; a held action completes with `state: "UNDER_REVIEW"`. Only the Court's EXECUTED state (and the config it applied) means the change happened. The dashboard reports the Court's state, never the Relay event.

## OpenAI

`OPENAI_API_KEY`, `OPENAI_MODEL` (the team used `gpt-5.4`; use any chat model with tool calling your key can reach). The agents and their replays use the same settings (`OPENAI_TEMPERATURE`, `OPENAI_REASONING_EFFORT`, `OPENAI_TIMEOUT_MS`). The replay records which model it ran on in the evidence.

## Before the demo

- `bun install && bun test && bun run build:web`
- `bun run live-eval` with the team's payloads, to see real verdicts and replay cost on your key before going on stage.
- If live fails for any reason: `bun run demo`. The page then says SIMULATED, and the phone flow is the same.
