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
- **Verification:** an exhaustive model checker runs the real Court through every interleaving of requests, verdicts, human decisions, revocations, duplicates and retries. 48,588 states, all 6 invariants hold, and 5 deliberately broken Courts are caught.
- **Multiplayer, safely:** a short-lived demo session with least-privilege roles. The phone can approve, deny and revoke but can't start attacks, and the Court re-checks authority on every human decision.
- **OpenAI** models power the live agents. Built in TypeScript on Bun, with a real-time dashboard.

**Challenges**
A single before/after replay can't tell "the outsider asked for this" from "rewording moves this agent around", which is why simpler counterfactual defenses falsely accuse legitimate work. The placebo arm fixes that. Keeping statistics out of the enforcement path took a strict two-layer split: the evidence layer can clear or escalate, never deny.

**Accomplishments**
On a simulated suite of 7 scenario classes with stated ground truth, Doppelgänger is the only approach that stops every attack class without a human reviewing every action. It stops 100% of attacks, sends a human 37% of legitimate actions (against 100% for "review everything"), and calls 1% of legitimate actions an attack (against 28–33% for a prompt-injection filter or a counterfactual without a placebo).

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
| 2 | 0:10–0:40 | Live run of case 2: messages streaming Acme → Support → Infra, then the comparison strip | "A customer's agent suggests where logs should go. Our Support agent relays it in its own words, and Infra asks to change the log destination. It's in scope, so today's stack just runs it: on the left, logs now flow to the customer. On the right, Doppelgänger traces the request back to the customer and holds it." |
| 3 | 0:40–0:55 | The action and its twin, three arms, the evidence line crossing | "It replays the agents three ways: unchanged, reworded, and with the customer's request removed. Remove the request and the destination changes, so the destination was the customer's idea." |
| 4 | 0:55–1:10 | Phone and laptop side by side: tap "Approve with our internal sink" | "The on-call engineer gets it on their phone, fixes one field, and only the correction runs." |
| 5 | 1:10–1:25 | Case 4, then case 5 | "Legitimate work goes straight through with nobody interrupted. And if authority is revoked mid-review, the Court fences out the stale verdict." |
| 6 | 1:25–1:45 | The simulated-suite chart, then the model checker with *Unserialized verdict* open | "On our simulated suite it's the only approach that stops every attack class without a human on every action. The Court is a Durable Actor; we model-checked it, and turning off serialization breaks revocation in four steps." |
| 7 | 1:45–2:00 | Back to the top | "Doppelgänger: AI teams that act on their own, with only the authority humans gave them." |

If the live agents aren't working by recording time, record shots 2–5 with `bun run demo`. The page then says "simulated agents"; say "in our simulation" once.

---

## Round 2: 2-minute live demo

**Before you're called:** start the run, open the dashboard full-screen, and **ask one judge to scan the QR code now**. They're your on-call engineer.

| time | do | say |
|---|---|---|
| 0:00 | point at the strip | "One customer message can become an order to a privileged AI agent. Same request, same agents, two systems. Watch." |
| 0:08 | click **2** | "Acme suggests where logs should go. Support relays it in its own words, and Infra asks to change the destination. Without us, on the left, it just ran: logs now go to Acme. With us, on the right, it's under review." |
| 0:30 | point at the twin and arms | "We replay the agents with Acme's request reworded, and with it removed. Removed, the destination changes. It was Acme's idea. Held." |
| 0:45 | to the judge: "Your phone just got it." | "Approve with our internal sink…" *(the judge taps)* "…and only the correction ran. That was your phone, live, through the same Court." |
| 1:00 | click **4** | "We don't make humans approve everything. Acme just sent logs here, every twin keeps the change, and it's approved with no one interrupted." |
| 1:15 | click **5** | "Authority revoked mid-review: the evidence says yes, but the Court's epoch fence says no. Stale verdicts never execute." |
| 1:30 | scroll to the chart | "On our simulated suite, we're the only approach that stops every attack class without a human on every action." |
| 1:42 | open *Unserialized verdict* | "The Court is a Durable Actor. We model-checked it, and turning off serialization breaks revocation in four steps." |
| 1:55 | — | "Doppelgänger. And if you'd like, write your own message as Acme and we'll run it." |

The last line invites the strongest question a judge can ask. If live agents work, type their message into **"Send as Acme's agent"**.

---

## Pre-demo checklist

- `bun install && bun test && bun run build:web`
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
That's our strongest baseline. It stops everything, at the cost of a human on every one of those actions. We match its safety with a human on 37%, and only on actions no test can attribute.

**"Can anyone with the QR link approve things?"**
The link carries a short-lived on-call token. Its role can decide, deny and revoke, but it can't start attacks or reset, and the server checks that on every command. Even then, the Court re-checks authority on every human decision, and every commit is fenced by the authorization epoch, so a stale approval can never override a revocation. That's one of the model-checked invariants.

**"Doesn't replaying agents cost a fortune?"**
Only privileged actions whose history touches outside content are replayed. In the simulated suite a tested action costs about 60 short model calls (live runs show the measured calls and tokens in the evidence drawer), and we stop the moment no verdict is reachable, which cuts the most expensive case by about 40% without loosening the error bound.

**"How do you know the stats are right?"**
The influence test is an e-process: its false-alarm rate is at most α at any stopping round, by Ville's inequality. We compute the exact worst case by dynamic programming (2.46% at α = 5%) and check it by Monte Carlo in the tests. Every verdict ships with a certificate the browser recomputes. We claim a bounded error under stated assumptions, not "guaranteed safe".

**"Why Durable Actors?"**
The Court's correctness depends on no two calls interleaving. Actors give that by construction, plus durable state and real-time streaming. Our model checker shows the exact failure when interleaving is allowed.

**"Why Agent Relay?"**
Authority lives in the chain between agents, and Relay is where that chain is. The Court owns the actions on Relay, so enforcement runs in the SDK's policy hook before any handler, and lineage comes from Relay's own messages rather than from what an agent claims.

**"What would make it fail?"**
An outsider's goal disguised as a natural subtask of the human's request can survive neutralization. Scope limits and human review stay as the backstop, and we say so.

**"Is the agent identity real?"**
A caller's role comes only from the agents this run registered on Relay. An unknown caller, even one named "infra", gets no authority, and identity written into the request is ignored. The actions are also restricted on Relay itself to our two agents.

**"Was this built today?"**
Yes. All code is from today (see the git history). We brainstormed the idea beforehand, which the rules allow.
