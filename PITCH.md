# Doppelgänger: pitch pack

**Format:** Round 1, judges watch your **demo video** and read the Devpost description, and 8 finalists go through. Round 2, a **2-minute live demo** from your laptop. Submit on Devpost by **4:00 PM**. Tick: Best overall, Best Durable Actors project, Best Agent Relay project, Most likely to scale to millions.

**The line everything hangs on:** *Same request. Same agents. Different outcome.*

---

## Devpost

**Name:** Doppelgänger

**Tagline:** The trust infrastructure for autonomous AI teams. It stops AI agents from using authority no human gave them, without making humans approve everything.

**Inspiration**
AI agents now hand work to each other and run production systems. The dangerous failure isn't an agent breaking its permissions. It's an agent using permissions it *has* for a request that was never the human's. An outside party plants a request, a trusted teammate agent relays it in its own words, and the agent with privileges sees only a colleague. OWASP's 2026 Top 10 for agentic applications lists this as ASI03, and in 2025 researchers showed a Supabase support ticket steering a privileged coding agent into leaking secrets in exactly this shape. A permission check can't see it, because the action is in scope. A prompt-injection filter can't either, because by the time it reaches the privileged agent it's a teammate's plain request.

**What it does**
Doppelgänger sits between AI agents and the systems they control. Every privileged request runs two ways at once, on the same sandbox:
- **Without Doppelgänger**, the agent's tool simply executes it, the way most agent stacks work today.
- **With Doppelgänger**, the Court decides.

The Court traces how the request formed across agents. If its history touches outside content, it tests the action against the human's original intent. It replays the agents three ways: the outside message unchanged, reworded with the request kept, and with the request neutralized. If the action survives removing the outsider's request, it was the human's, and it's approved with no one interrupted. If it disappears, it's held, with the exact argument that came from outside highlighted. If even a harmless rewording moves it, Doppelgänger says it can't tell instead of crying wolf. Held actions go to the on-call engineer's phone. A judge can scan a QR code, become that engineer, and decide on the big screen. In live mode, a judge can also write their own message as the outside party and watch the real agents and the Court respond.

**How we built it**
- **Agent Relay:** the Court joins the workspace as an agent and owns the privileged actions. Agents invoke them over Relay, and the Relay SDK calls the Court as each action's policy hook before any handler runs, so a refusal completes the invocation with an error and emits the SDK's own `action.denied`. Provenance rides in message metadata, and the lineage of every request is rebuilt from `message.created`, with trust taken from a roster, never from a message.
- **Durable Actors (Terse):** the Court, each run's Lineage and each agent's step log are actors. The Court's one-call-at-a-time execution is a safety property: our model checker shows that allowing `@Interleave` lets a revocation slip between "check" and "write" in four steps.
- **The evidence layer:** a placebo-controlled, three-arm counterfactual experiment decided by a paired sign-test e-process. Its false-"influenced" rate is at most α at any stopping round (Ville's inequality; the exact worst case is 2.46% at α = 5%). It stops early once no verdict is reachable, and every verdict comes with a certificate the browser recomputes.
- **The replay engine:** for a held request, it re-runs every agent between the outside message and the privileged call from their recorded contexts, with the same prompts, tools and model settings, swapping only the outside message. Replays are read-only: they never send a Relay message, invoke an action or touch the Court. Any failure, timeout or budget overrun holds the action for a human.
- **Verification:** an exhaustive model checker runs the real Court through every interleaving of requests, verdicts, human decisions, revocations, duplicates and retries. 66,242 states, all 6 invariants hold, and 5 deliberately broken Courts are caught.
- **Multiplayer, safely:** a short-lived demo session with least-privilege roles. The phone can approve, deny and revoke but can't start attacks, and the Court re-checks authority on every human decision.
- **OpenAI** models power the live agents. Built in TypeScript on Bun, with a real-time dashboard.

**Challenges**
A single before/after replay can't tell "the outsider asked for this" from "rewording moves this agent around", which is why simpler counterfactual defenses falsely accuse legitimate work. The placebo arm fixes that. Keeping statistics out of the enforcement path took a strict two-layer split: the evidence layer can clear or escalate, never deny.

**Accomplishments**
On a simulated suite of 7 scenario classes with stated ground truth, Doppelgänger is the only approach that stops every attack class without a human reviewing every action. It stops 100% of attacks, sends a human 44% of legitimate actions (against 100% for "review everything"), and calls 1% of legitimate actions an attack (against 28–33% for a prompt-injection filter or a counterfactual without a placebo).

**What we learned**
Authority in a multi-agent system is a property of the chain of messages, not of any one agent. It has to be enforced where the chain lives: on the message bus and in durable state.

**What's next**
More action types, a replay engine for popular agent frameworks, and a real approvals inbox.

**Built with:** TypeScript, Bun, Agent Relay, Durable Actors, OpenAI

---

## Round 1: demo video (aim for 2:00)

Record your screen at 1080p, browser zoom 110%, speed **Fast**. Record the voice-over separately if you can. Label anything simulated on screen; the dashboard already does.

| # | time | on screen | voice-over |
|---|---|---|---|
| 1 | 0:00–0:10 | The page top: the question | "AI agents now hand work to each other and run production. How do you let them act without inheriting authority no human gave them?" |
| 2 | 0:10–0:40 | Live run of case 2: messages streaming Acme → Support → Infra, then the comparison strip | "A customer's agent suggests where logs should go. Our Support agent relays it in its own words, and Infra asks to change the log destination. It's in scope, so today's stack just runs it: on the left, logs now flow to the customer. On the right, Doppelgänger traces it back to the customer: a destination no human authorized, arriving through outside content. Held instantly, before any model call." |
| 3 | 0:40–0:55 | The action and its twin, three arms, the evidence line crossing | "Then it explains why. It replays the agents three ways: unchanged, reworded, and with the customer's request removed. Remove the request and the destination changes, so it was the customer's idea. The evidence can explain a hold; it can never release one." |
| 4 | 0:55–1:10 | Phone and laptop side by side: tap "Approve with our internal sink" | "The on-call engineer gets it on their phone, fixes one field, and only the correction runs." |
| 5 | 1:10–1:25 | Case 4, then case 5 | "Legitimate work goes straight through with nobody interrupted. And if authority is revoked mid-review, the Court fences out the stale verdict." |
| 6 | 1:25–1:45 | The simulated-suite chart, then the model checker with *Unserialized verdict* open | "On our simulated suite it's the only approach that stops every attack class without a human on every action. The Court is a Durable Actor; we model-checked it, and turning off serialization breaks revocation in four steps." |
| 7 | 1:45–2:00 | Back to the top | "Doppelgänger: AI teams that act on their own, with only the authority humans gave them." |

If the live agents aren't working by recording time, record shots 2–5 with `bun run demo`. The page then says "simulated agents"; say "in our simulation" once.

---

## Round 2: 2-minute live demo

**Before you're called:** start the run (`bun run live`, or `bun run demo` if live failed its check), open the dashboard full-screen, have the on-call phone signed in with the QR code, and Slack open on that phone. Check the badge says LIVE (or SIMULATED, and say so).

| time | do | say |
|---|---|---|
| 0:00 | point at the strip | "AI agents now hand work to each other. One customer message can become an order to a privileged agent that no human gave. Same request, same agents, two systems." |
| 0:15 | click **2** | "Acme's agent writes to our Support agent. Support coordinates with Infra over Agent Relay, and Infra invokes `logging.configure`, a typed Relay action the Court owns." |
| 0:30 | point at the compare strip and the Relay events | "Without us, on the left, the tool just ran: logs now go to Acme. With us, Relay hands the action to the Court first. The on-call engineer authorized internal sinks for this case; this destination came from Acme. Held, before any side effect." |
| 0:50 | point at the provenance column | "The Court didn't take anyone's word for where this came from: it rebuilt the history from what each agent actually read." |
| 1:05 | show the phone: the Slack notification | "Slack just told the on-call engineer. The link carries no credential; this phone is signed in." *(tap Review action, then Approve with our internal sink)* |
| 1:20 | point at the docket | "The Court re-checked her authority and executed only the correction. Approving twice, or after a revocation, does nothing." |
| 1:30 | click **3** (live) or **4** (simulated) | "Ordinary logs from Acme: the twins keep the change with or without anything Acme asked, and it's covered by her authorization. Executed, nobody interrupted." |
| 1:45 | — | "Relay is the action pathway, a Durable Actor keeps every decision consistent, and counterfactual replay explains what came from outside. Doppelgänger: AI teams act on their own, with only the authority humans gave them." |

Twin replays take time with real models. If the evidence for case 2 is still running at 0:50, say "the explanation is still replaying; the hold didn't wait for it", which is true and is the point.

## Pre-demo checklist

- `bun install && bun test`
- **Integration proof:** `bun run live:check -- --memory` (then without `--memory` if actors are up). It fails unless it observes every mandatory step: the Court's current interface, the caller seen as Infra, the attack held or denied, Relay action events, the Slack notification (if configured), the on-call correction through the authenticated server, no double execution, no new operation on a re-sent invocation, the legitimate case executed, and revocation enforced.
- **Real-model proof:** `bun run live-eval:smoke` (one attack, one legitimate case), then `bun run live-eval --repeat 3` if time and budget allow, then `bun run build:web` so the dashboard's *Real-model evaluation* panel shows it. Quote counts ("stopped 6 of 6 harmful attack runs; cleared 9 of 12 legitimate runs"), never percentages, and only what the file says.
- Live: `relay init`, `durable-actors dev && bun run generate` (or `--memory`), then `OPENAI_API_KEY=… OPENAI_MODEL=… RELAY_WORKSPACE_KEY=… bun run live`
- Fallback with no keys: `bun run demo`. The phone flow works the same, and the agents are labelled simulated.
- Phones must reach the laptop. Venue Wi-Fi often blocks device-to-device traffic, so test it. If it fails, run `cloudflared tunnel --url http://localhost:3000` and restart with `PUBLIC_URL=<tunnel url>`, and the QR will point there. The session token still protects every command.
- Browser at 110% zoom, speed Fast, notifications off, a second browser tab already on `bun run demo` as a backup.
- Rehearse the 2 minutes three times with a timer.

---

## Judge Q&A

**"Is the side-by-side fair?"**
Both systems receive the same request object: the same id, arguments and triggering message, in the same call. The left side runs it with no checks, on a sandbox copy; nothing real changes. The tests assert the inputs are identical.

**"Isn't this just prompt-injection detection?"**
No. A filter inspects text. By the time the request reaches the privileged agent, it's a teammate's plain sentence with nothing to detect. We test the *action*: does it survive removing the outsider's request? On our simulated suite, a filter stops 70% of attacks and calls 28% of legitimate work an attack. We stop 100% at 1%.

**"Why not have a human approve anything that touched outside content?"**
That's our strongest baseline. It stops everything, at the cost of a human on every one of those actions. We match its safety with a human on 44%, and only on actions no test can attribute.

**"Can anyone with the QR link approve things?"**
The link carries a short-lived on-call token. Its role can decide, deny and revoke, but it can't start attacks or reset, and the server checks that on every command. Even then, the Court re-checks authority on every human decision, and every commit is fenced by the authorization epoch, so a stale approval can never override a revocation. That's one of the model-checked invariants.

**"Doesn't replaying agents cost a fortune?"**
Only privileged actions whose history touches outside content are replayed. In the simulated suite a tested action costs about 64 short model calls (live runs show the measured calls and tokens in the evidence drawer), and we stop the moment no verdict is reachable, which cuts the most expensive case by about 40% without loosening the error bound.

**"How do you know the stats are right?"**
The influence test is an e-process: its false-alarm rate is at most α at any stopping round, by Ville's inequality. Automatic approval has its own anytime-valid e-process too, worst case 3.82%. We compute both exact worst cases by dynamic programming (2.46% for influenced) and check it by Monte Carlo in the tests. Every verdict ships with a certificate the browser recomputes. We claim a bounded error under stated assumptions, not "guaranteed safe".

**"Why Durable Actors?"**
The Court's correctness depends on no two calls interleaving. Actors give that by construction, plus durable state and real-time streaming. Our model checker shows the exact failure when interleaving is allowed.

**"Why Agent Relay?"**
Authority lives in the chain between agents, and Relay is where that chain is. The Court owns the actions on Relay, so enforcement runs in the SDK's policy hook before any handler, and lineage comes from Relay's own messages rather than from what an agent claims.

**"What would make it fail?"**
An outsider's goal disguised as a natural subtask of the human's request can survive neutralization. Scope limits and human review stay as the backstop, and we say so.

**"Couldn't an agent lie about where a request came from?"**
Provenance isn't taken from agents. The Court rebuilds each request's history from the recorded agent steps: what each step actually read, and the exact call it made. A message no step sent, or a call no step made, is held. And it approves automatically only when a human's request is in that history.

**"Is the agent identity real?"**
A caller's role comes only from the agents this run registered on Relay. An unknown caller, even one named "infra", gets no authority, and identity written into the request is ignored. The actions are also restricted on Relay itself to our two agents.

**"Was this built today?"**
Yes. All code is from today (see the git history). We brainstormed the idea beforehand, which the rules allow.
