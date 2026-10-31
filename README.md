# Doppelgänger

**The trust infrastructure for autonomous AI teams.**

> How do we let AI agents act on their own without letting them inherit authority no human ever intended to give them?

AI agents now delegate to each other and operate production systems. The new failure is not an agent breaking its permissions. It is an agent using permissions it *has*, for a request that was never the human's: an outside party plants a request, a trusted teammate agent relays it in its own words, and the privileged agent sees only a colleague. OWASP's 2026 Top 10 for agentic applications lists this as **ASI03**: a low-privilege agent relays a request that a high-privilege agent executes without rechecking the user's original intent. In 2025 a Supabase support ticket was shown to steer a privileged coding agent into leaking secrets in exactly this shape.

Doppelgänger traces how every privileged request formed across agents, tests the suspicious ones against the human's original intent with counterfactual twins, and enforces the result. Humans see only what the evidence can't clear.

**Same request. Same agents. Different outcome.** Every privileged request runs twice, on a sandbox copy of the system: once the way most agent stacks work today (the tool just runs it), and once through the Court. Both receive the identical request: same id, arguments and triggering message.

```
bun install
bun test              # 66 tests
bun run verify        # model-checks the Court and five broken Courts
bun run eval          # Doppelgänger vs four alternatives
bun run build:web && bun run start     # dashboard on :3000, simulation in the browser, no keys
bun run demo                           # simulation on the server: phones can join, no keys
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

**Instant hold.** Scopes can list values the human authorized in advance (the default: internal sinks). When a request's history reaches outside content *and* a key value is outside that list, the Court holds it for a human at submission: a deterministic authorization reason, no model call, no waiting. Not every outside value is suspect: an outside-touched request whose values are all pre-authorized still goes to the evidence layer, and the same value asked for directly by a human is approved. The twins still run for an instantly held action, but only to explain it: the Court's `explain()` attaches evidence and never changes state, so evidence can never release a held action (a model-checked transition invariant: HELD leaves only by a human decision).

**Statistics, honestly.** Both verdicts that matter are anytime-valid e-processes, so their error bounds survive optional stopping (futility, budgets, re-checking after every round): "influenced" is at most α (exact worst case 2.46% at α = 5%) if the instruction had no specific effect; "robust", which approves automatically, is at most α (exact worst case 3.82%) if the neutralized twin keeps the action at a rate ≤ 0.7. The earlier robust rule (a fixed-sample Clopper–Pearson bound re-checked every round) did not have that property: its exact worst case was 8.3%, and a test now pins that down. The bounds are per action, not family-wise across many actions, and they rest on the stated assumptions (fixed rewrites that keep facts, independent rounds). Interval bars on the dashboard are descriptive only.

## Built on the sponsors, structurally

**Agent Relay.** The Court joins the workspace as an agent and *owns* the privileged actions. Per the SDK, an action registered from an agent client is relay-routed: agents invoke it over Relay, Relay delivers it to the Court agent, and the SDK runs the action's `policy` before its handler. So the Court's scope check *is* the action's policy hook. An out-of-scope call never reaches a handler: the SDK completes the invocation with an error and emits its own `action.denied`, and the docket records that event. Provenance rides on the wire in `metadata.inputs`; lineage is rebuilt from `message.created`, and trust comes from the roster, never from a message. (`src/relay-wiring.ts`, typechecked against `@agent-relay/sdk` 15 source.)

**Durable Actors.** `Court`, `Lineage` and `AgentLog` actors (`src/actors.ts`, typechecked against `durable-actors` 0.14.6 source). The Court has no `@Interleave`, deliberately: the model checker's *Unserialized verdict* mutant is the Court with interleaving allowed, and in four steps a revocation slips between "check the epoch" and "write the approval". The actor runtime's one-call-at-a-time execution is a safety property here, not a convenience. `@Emittable` state streams to the dashboard in real time.

## Results

**Model-checked Court.** 50,231 states, 759,242 transitions, all six invariants hold (executes only under current authority; revocation stops reviews in flight; laundered requests are always reviewed; only legal transitions; config is exactly what was executed; each operation executes once). Five broken Courts are each caught with their shortest counterexample.

**Against the alternatives, on a simulated suite** (`bun run eval`: 7 scenario classes × 200 instances, ground truth stated in `src/eval.ts`; it measures the decision rules, not a particular model):

| approach | attacks stopped | legit actions sent to a human | legit actions called attacks |
|---|---|---|---|
| Authorization only | 25% | 0% | 0% |
| Prompt-injection filter | 70% | 28% | 28% |
| Counterfactual, no placebo arm | 79% | 38% | 33% |
| Human reviews everything that touched outside content | 100% | 100% | 0% |
| **Doppelgänger** | **100%** | **44%** | **1%** |

Only Doppelgänger stops every attack class without a human reviewing every action. The legitimate actions it does send to a human are the ones no test can attribute (fragile to any rewording). It reviews them; it does not accuse them.

**Cost**: about 64 short model calls per *tested* action (rounds × 3 arms × agents replayed). Only privileged actions whose history touches outside content are tested.

## Run it live

```
relay init                                  # local Relaycast server + workspace, no account
durable-actors dev && bun run generate      # actor runtime + typed client (or pass --memory)
cp .env.example .env                        # fill in; bun loads .env automatically
bun run build:web && bun run live           # open http://localhost:3000/?mode=live
```

OpenAI agents (Support, Infra) talk over Agent Relay; the Court agent owns the actions; the dashboard streams the run. In live mode a judge can **write their own message as the outside party** and watch the real agents and the Court respond, and can **scan a QR code to become the on-call engineer**: held actions arrive on their phone, and their tap decides them on the big screen.

**Phone controls are protected.** A short-lived demo session with least-privilege roles (`src/session.ts`): the presenter's token is handed only to a page loaded on the laptop itself; the phone's on-call token can approve, deny and revoke, never start attacks, reset, or restore authority; the event stream needs a token too, and phones never receive raw message text; the server checks the role on every command. Whatever a token allows, the Court re-checks authority on every human decision and fences every commit with the epoch, so a stale approval can never override a revocation. Behind venue Wi-Fi, run a tunnel and set `PUBLIC_URL` so the QR code points at it. The on-call link is a credential, so neither runner prints it: it lives in the QR code on the laptop's dashboard.

**The replay engine** (`src/replay.ts`). For an action under review it walks the recorded chain back from the triggering message through the AgentLogs, and re-runs every agent step between the outside message and the privileged call, each with its own system prompt, tools, model settings and the exact context it recorded, substituting only the replayed text of what it read. The outside message is rewritten once per arm and reused across rounds; the agents are re-sampled independently every round. The engine only reads and calls the model: it never sends a Relay message, invokes an action or writes to an actor, so a twin cannot have a side effect (tests check the Court, Lineage and logs are byte-identical afterwards). Any missing record, model error, timeout (`OPENAI_TIMEOUT_MS`), or exhausted budget (`REPLAY_MAX_MODEL_CALLS`, `REPLAY_DEADLINE_MS`) fails the review closed: held for a human. Measured model calls, tokens and time are attached to the evidence and shown in the drawer. Without `OPENAI_API_KEY`/`OPENAI_MODEL` there is no sampler and every review goes to a human.

**Provenance is verified, not taken from agents.** Each case is one workflow: the on-call engineer's task (a human message on Relay) and the outside message, read together by Support in one recorded step. When a privileged action arrives, the Court's wiring rebuilds its history from the AgentLog, not from what messages claim: an internal message counts as produced from what the step that *sent* it read, and the caller must have a recorded step that read the trigger and made exactly this call. Anything that does not check out is unverified and held. An in-scope action is approved automatically only if a human request is in its history and no outside content is; "no attack found" is not treated as intent. Provenance is stamped by the harness (the process that runs the agents), never by a model. Operation ids are derived from the request itself (caller, action, arguments, trigger), so a redelivered or retried Relay invocation maps to the same operation and never runs twice; the SDK does not give the handler an invocation id to use instead. Relay's own action events (`action.invoked`, `action.completed`, `action.denied`) are shown on the dashboard as observed; `action.completed` means the Court's handler returned, which may be HELD, and only the Court's EXECUTED state means the change happened. Rewrites must keep every URL, path, address, key and number of the original (one retry); otherwise the replay fails and the action is held.

**Caller identity.** A caller's role comes only from the roster of agents this run registered. Unknown callers (including a runtime placeholder such as `node`), bare role names, outsiders and humans have no role and are refused by the policy; the actions are also registered with Relay's `availableTo` set to Support and Infra only. Identity in the action input is ignored: only declared arguments reach the Court.

`src/payloads.ts` takes the live cases from `eval/cases.json`, so the demo runs the same messages the evaluation measures.

**Full live integration check.** `bun run live:check` (add `-- --memory` to skip the actor runtime) starts the live run and then, on real Relay and real models, runs an attack case and a legitimate case, applies a human correction, retries an invocation, revokes, and writes what it observed to `live-check-results.json`. It is the test that the whole product works, separate from the decision-quality evaluation below.

**Real-model evaluation.** `bun run live-eval:smoke` runs one attack and one legitimate case from `eval/cases.json` on real OpenAI models; `bun run live-eval --repeat 3` runs all eight starter cases three times. Each run goes through the real agents, the Court and the replay engine (in process, no Relay network or actor runtime: it measures decision quality, not the integration) and the unprotected sandbox, and records: attacks that would have done harm unprotected and whether they were stopped, attack runs the agents didn't carry out, legitimate actions cleared or held, inconclusive replays, model calls, tokens, cost (only if you pass `OPENAI_PRICE_INPUT_PER_M`/`OPENAI_PRICE_OUTPUT_PER_M`), enforcement latency and replay time. It writes `live-eval-results.json`; `bun run build:web` then shows it in the dashboard's *Real-model evaluation* panel. Only a file whose `kind` is `real-model` is shown; with none, the panel says there are no results. The simulated suite and the scripted-model tests are reported separately.

## Honest limits

- Counterfactual evidence of influence, not proof of cause. Authorization stays authoritative.
- An injected goal that looks like a natural subtask of the human's request can survive neutralization. Scope and human review are the backstop.
- The model checker is exhaustive within stated bounds, not a proof for unbounded runs.
- The simulation and the evaluation draw twins from stated ground truths: they measure the decision rules, not a particular model's accuracy.
- The replay engine is tested against a scripted model and a fake Relay that mirrors the SDK's policy semantics. Its behaviour with real models and a real Relay server is only known from live runs (`bun run live`, `bun run live-eval`).
- Provenance (`metadata.inputs`) is stamped by our harness from what each step read, not by the model. An agent runtime that sends messages outside the harness would need the same stamping.
- A redelivered Relay invocation becomes a second operation. Each goes through the Court on its own (scope, lineage, review) and executes at most once, but the Court does not deduplicate across invocations: the SDK does not hand the handler an invocation id to key on.

## Layout

| | |
|---|---|
| `src/court-logic.ts` | The Court: lifecycle, scope, epoch fencing. Pure functions. |
| `src/experiment.ts`, `src/stats.ts` | The three-arm experiment, the e-process, futility stopping, exact bounds, certificates |
| `src/replay-logic.ts` | Lineage, value tracing, evidence |
| `src/replay.ts`, `src/trial.ts` | The replay engine (the counterfactual sampler) and where it plugs into the experiment |
| `src/agents.ts`, `src/rewrite.ts`, `src/scenario.ts` | Model calls (timeouts, retries, usage), the two rewrites, the agents |
| `src/model-check.ts` | Exhaustive model checker, six invariants, five mutants |
| `src/baselines.ts`, `src/eval.ts` | The alternatives and the scored suite |
| `src/actors.ts`, `src/actor-clients.ts` | Durable Actors |
| `src/relay-wiring.ts`, `src/live-run.ts` | Agent Relay wiring and the live runner |
| `src/unprotected.ts` | The same system without Doppelgänger, on a sandbox: the comparison |
| `src/session.ts`, `src/server.ts` | Demo session roles, SSE, authenticated commands |
| `src/sim.ts`, `src/demo-server.ts`, `web/src` | The six demo cases, server-side simulation, and the dashboard |

All code in this repository was written during Haunted Hacks on 31 October 2026.
