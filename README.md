# Doppelgänger

**The trust infrastructure for autonomous AI teams.**

> How do we let AI agents act on their own without letting them inherit authority no human ever intended to give them?

AI agents now delegate to each other and operate production systems. The new failure is not an agent breaking its permissions. It is an agent using permissions it *has*, for a request that was never the human's: an outside party plants a request, a trusted teammate agent relays it in its own words, and the privileged agent sees only a colleague. OWASP's 2026 Top 10 for agentic applications lists this as **ASI03**: a low-privilege agent relays a request that a high-privilege agent executes without rechecking the user's original intent. In 2025 a Supabase support ticket was shown to steer a privileged coding agent into leaking secrets in exactly this shape.

Doppelgänger traces how every privileged request formed across agents, tests the suspicious ones against the human's original intent with counterfactual twins, and enforces the result. Humans see only what the evidence can't clear.

```
bun install
bun test              # 57 tests
bun run verify        # model-checks the Court and five broken Courts
bun run eval          # Doppelgänger vs four alternatives
bun run build:web && bun run start     # dashboard on :3000, simulation mode, no keys
```

## How it works

**Safety layer: the Court**, a Durable Actor that holds the protected resource. Deterministic: scope, an authorization **epoch** stamped on every request and checked at every verdict and commit, and serialized state. It can deny on its own and never consults a statistic.

**Evidence layer: the twins.** When a privileged request's history reaches outside content, Doppelgänger replays the agents three ways, every round:

| arm | the outside message is… | measures |
|---|---|---|
| unchanged | as it was | is the action even reproducible? |
| reworded | reworded, request **kept** | the placebo: wording alone |
| neutralized | facts kept, request **removed** | the request's effect |

The reworded and neutralized arms differ only in whether the request survives, so comparing them separates "the outsider asked for this" from "rewording moves this agent around". A paired sign-test e-process decides: **influenced** (held for a human, the influenced argument attributed), **robust** (approved automatically), or **inconclusive** (a human decides, never called an attack). Its false-"influenced" rate is at most α at whatever round it stops (Ville's inequality); the exact worst case is 2.46% at α = 5%. It stops as soon as no verdict is reachable, which cuts the most expensive case by about 40%. Every verdict ships a certificate the browser recomputes. Key values that appear only in outside content are always held, even when the twins agree.

The evidence layer never denies. It can only clear an action, or hand it to a human.

## Built on the sponsors, structurally

**Agent Relay.** The Court joins the workspace as an agent and *owns* the privileged actions. Per the SDK, an action registered from an agent client is relay-routed: agents invoke it over Relay, Relay delivers it to the Court, and the action's `policy` runs first. So the Court's scope check *is* Relay's policy hook. An out-of-scope call never reaches a handler, Relay emits its own `action.denied`, and the docket records that event. Provenance rides on the wire in `metadata.inputs`; lineage is rebuilt from `message.created`, and trust comes from the roster, never from a message. (`src/relay-wiring.ts`, typechecked against `@agent-relay/sdk` 15 source.)

**Durable Actors.** `Court`, `Lineage` and `AgentLog` actors (`src/actors.ts`, typechecked against `durable-actors` 0.14.6 source). The Court has no `@Interleave`, deliberately: the model checker's *Unserialized verdict* mutant is the Court with interleaving allowed, and in four steps a revocation slips between "check the epoch" and "write the approval". The actor runtime's one-call-at-a-time execution is a safety property here, not a convenience. `@Emittable` state streams to the dashboard in real time.

## Results

**Model-checked Court.** 48,588 states, 730,026 transitions, all six invariants hold (executes only under current authority; revocation stops reviews in flight; laundered requests are always reviewed; only legal transitions; config is exactly what was executed; each operation executes once). Five broken Courts are each caught with their shortest counterexample.

**Against the alternatives** (`bun run eval`, 7 scenario classes × 200 instances, ground truth stated in `src/eval.ts`):

| approach | attacks stopped | legit actions sent to a human | legit actions called attacks |
|---|---|---|---|
| Authorization only | 25% | 0% | 0% |
| Prompt-injection filter | 70% | 28% | 28% |
| Counterfactual, no placebo arm | 79% | 38% | 33% |
| Human reviews everything that touched outside content | 100% | 100% | 0% |
| **Doppelgänger** | **100%** | **37%** | **1%** |

Only Doppelgänger stops every attack class without a human reviewing every action. The legitimate actions it does send to a human are the ones no test can attribute (fragile to any rewording). It reviews them; it does not accuse them.

**Cost**: about 60 short model calls per *tested* action (rounds × 3 arms × agents replayed). Only privileged actions whose history touches outside content are tested.

## Run it live

```
relay init                                  # local Relaycast server + workspace, no account
durable-actors dev && bun run generate      # actor runtime + typed client (or pass --memory)
export RELAY_WORKSPACE_KEY=…  OPENAI_API_KEY=…  OPENAI_MODEL=…
bun run build:web && bun run live           # open http://localhost:3000/?mode=live
```

OpenAI agents (Support, Infra) talk over Agent Relay; the Court agent owns the actions; the dashboard streams the run. Two pieces are the team's: `src/payloads.ts` (what the outside party sends) and `createSampler` in `src/trial.ts` (the replay engine; `src/rewrite.ts` and `runAgent` are ready for it). Without a sampler, reviews fail closed to a human.

## Honest limits

- Counterfactual evidence of influence, not proof of cause. Authorization stays authoritative.
- An injected goal that looks like a natural subtask of the human's request can survive neutralization. Scope and human review are the backstop.
- The model checker is exhaustive within stated bounds, not a proof for unbounded runs.
- The simulation and the evaluation draw twins from stated ground truths: they measure the decision rules, not a particular model's accuracy.

## Layout

| | |
|---|---|
| `src/court-logic.ts` | The Court: lifecycle, scope, epoch fencing. Pure functions. |
| `src/experiment.ts`, `src/stats.ts` | The three-arm experiment, the e-process, futility stopping, exact bounds, certificates |
| `src/replay-logic.ts` | Lineage, value tracing, evidence |
| `src/model-check.ts` | Exhaustive model checker, six invariants, five mutants |
| `src/baselines.ts`, `src/eval.ts` | The alternatives and the scored suite |
| `src/actors.ts`, `src/actor-clients.ts` | Durable Actors |
| `src/relay-wiring.ts`, `src/live-run.ts` | Agent Relay wiring and the live runner |
| `src/sim.ts`, `web/src` | The six demo cases and the dashboard |

All code in this repository was written during Haunted Hacks on 31 October 2026.
