# Doppelgänger: pitch pack

Submit on Devpost by **4:00 PM**. Tracks to tick: **Best overall**, **Best Durable Actors project**, **Best Agent Relay project**, **Most likely to scale to millions**.

---

## Devpost

**Name:** Doppelgänger

**Tagline (elevator pitch):**
The trust infrastructure for autonomous AI teams. Catches when an AI agent uses authority no human intended to give it, without making humans approve everything.

**Inspiration**
AI agents now hand work to each other and run production systems. The scary failure isn't an agent breaking its permissions; it's an agent using permissions it *has* for a request that was never the human's. An outside party plants a request, a trusted teammate agent relays it in its own words, and the agent with privileges sees only a colleague. OWASP's 2026 Top 10 for agentic applications calls this ASI03, and in 2025 researchers showed a Supabase support ticket steering a privileged coding agent into leaking secrets in exactly this shape. Permission systems can't see it (the action is in scope) and prompt-injection filters can't either (by the time it reaches the privileged agent, it's a teammate's plain request).

**What it does**
Doppelgänger sits between agents and the systems they control. For every privileged action it traces how the request formed across agents. If that history touches outside content, it tests the action against the human's original intent: it replays the agents three ways (outside message unchanged, reworded with the request kept, and with the request neutralized). If the action survives removing the outsider's request, it was the human's, and Doppelgänger approves it on its own. If it disappears, Doppelgänger holds it for a human and shows exactly which argument came from the outsider. If even a harmless rewording moves it, Doppelgänger says it can't tell instead of crying wolf. A deterministic Court enforces every outcome and fences out verdicts that arrive after authority was revoked.

**How we built it**
- **Agent Relay**: the Court joins the workspace as an agent and owns the privileged actions. Agents invoke them over Relay, and Relay runs the Court's scope check as the action's `policy` before any handler, so refusals are Relay's own `action.denied` events. Provenance rides in message metadata; the lineage of every request is rebuilt from `message.created`.
- **Durable Actors**: the Court, the Lineage of each run and each agent's step log are actors. The Court's one-call-at-a-time execution is a safety property: our model checker shows that allowing `@Interleave` lets a revocation slip between "check" and "write" in four steps.
- **The evidence layer**: a placebo-controlled, three-arm counterfactual experiment decided by a paired sign-test e-process. False-"influenced" rate ≤ α at any stopping round (Ville's inequality; exact worst case 2.46% at α = 5%), early stopping when no verdict is reachable, and a certificate the browser recomputes.
- **Verification**: an exhaustive model checker runs the real Court through every interleaving of requests, verdicts, human decisions, revocations, duplicates and retries (48,588 states, 6 invariants hold) and catches five deliberately broken Courts.
- **OpenAI** models power the live agents; TypeScript on Bun; a real-time dashboard.

**Challenges**
A single before/after replay can't tell "the outsider asked for this" from "rewording moves this agent around", which is why simpler counterfactual defenses falsely accuse legitimate work. The placebo arm fixes that. Keeping statistics out of the enforcement path took a strict two-layer split: the evidence layer can clear or escalate, never deny.

**Accomplishments**
On a labelled suite of 7 scenario classes, Doppelgänger is the only approach that stops every attack class without a human reviewing every action: 100% of attacks stopped, 37% of legitimate actions sent to a human (versus 100% for "review everything"), and 1% of legitimate actions called an attack (versus 28 to 33% for a prompt-injection filter or a counterfactual without a placebo).

**What we learned**
Authority in a multi-agent system is a property of the chain of messages, not of any one agent. It has to be enforced where the chain lives: on the message bus and in durable state.

**What's next**
More action types and policies, a replay engine for popular agent frameworks, and an approvals inbox that shows a human the evidence instead of a raw request.

**Built with:** TypeScript, Bun, Agent Relay, Durable Actors, OpenAI

---

## 3-minute live demo

Open the dashboard. Set speed to **Fast**. Rehearse twice; each case takes a few seconds to play.

| time | do | say |
|---|---|---|
| 0:00 | (dashboard top) | "AI agents now delegate to each other and run production. The question we built around: how do you let agents act on their own without them inheriting authority no human gave them?" |
| 0:15 | point at the How the request formed column | "Here's a support team: our on-call engineer, Support and Infra are ours. Acme's agent is a customer, outside the company. The engineer authorized Infra to raise logging, up to debug." |
| 0:25 | click **1 Out of scope** | "Acme asks for production access. Support relays it. That's never been authorized, so Relay itself refuses it: our Court is the action's policy hook on Agent Relay. Any permission system does this. Now the hard one." |
| 0:40 | click **2 Laundered through a teammate** | "Acme suggests where verbose logs should go. Support passes it on in its own words, so Infra sees a teammate asking for something in scope. A permission check says yes. A prompt filter on Infra sees nothing." |
| 0:55 | as the twins run | "Its history reaches Acme, so Doppelgänger replays the agents three ways: Acme's message unchanged, reworded with the request kept, and with the request removed. Reworded, the twins still send logs to Acme. Removed, they keep our internal sink." |
| 1:10 | point at the struck-through sink | "The destination was Acme's idea, not our engineer's. Held, with exactly that argument flagged and a statistical bound on the error." |
| 1:20 | click **Approve with the internal sink** | "The engineer corrects one field and it runs. Only the corrected value ever touches the system." |
| 1:30 | click **4 Legitimate, cleared** | "But we don't want humans approving everything. Here Acme just sent logs. Every twin keeps the change, so it's the engineer's own task, and it's approved with nobody interrupted." |
| 1:45 | click **3 Not enough evidence** | "And when it can't tell, it says so. Here even a harmless rewording moves the action, so nothing can be pinned on Acme. It doesn't cry attack. It stops early to save tokens and asks a human." |
| 2:05 | click **5 Revoked mid-review** (it revokes on its own mid-review) | "Races. While twins are replaying, the engineer revokes Infra. The evidence would approve, but the review started under authority that no longer exists. Fenced out." |
| 2:20 | scroll to **Safety without making humans approve everything** | "Same test suite, five approaches. Authorization stops 25% of attacks. A prompt filter 70%. Reviewing everything stops them all, but a human sees every action. We stop 100% and a human sees 37%, and we falsely accuse 1% of legitimate work, versus about a third for the alternatives." |
| 2:40 | scroll to **The Court is model-checked**, open **Unserialized verdict** | "The Court is a Durable Actor and we model-checked it: 48 thousand states, every invariant holds. Turn on interleaving and, in four steps, a revocation slips between check and write. The actor model is what makes this safe." |
| 2:55 | back to top | "Doppelgänger: the trust layer that lets AI teams act on their own." |

**If live mode works on the laptop**, run case 1 and 2 live instead, then switch to the simulation for 3–5 (they need the race timing). **If anything breaks**, the simulation is the demo; it runs the real Court and statistics.

---

## Judge Q&A

**"Isn't this just prompt-injection detection?"**
No. A filter inspects text. By the time the request reaches the privileged agent it's a teammate's plain sentence: nothing to detect. We test the *action*: does it survive removing the outsider's request? In our eval a filter stops 70% of attacks and calls 28% of legitimate work an attack; we stop 100% at 1%.

**"Why not just have a human approve anything that touched outside content?"**
That's our strongest baseline and it does stop everything, at the cost of a human on 100% of those actions. We match its safety with a human on 37%, and only on actions no test can attribute.

**"Doesn't replaying agents cost a fortune?"**
Only privileged actions whose history touches outside content are replayed, which is a small slice of traffic. A tested action costs about 60 short model calls. We stop the moment no verdict is reachable, which cuts the most expensive case by about 40% without loosening the error bound. Compare it with an engineer's minutes, or with an incident.

**"How do you know the stats are right?"**
The influence test is an e-process: its false-alarm rate is at most α at any stopping round, by Ville's inequality. We compute the exact worst case by dynamic programming (2.46% at α = 5%), check it by Monte Carlo in the tests, and every verdict ships a certificate the browser recomputes. We claim a bounded error under stated assumptions, not "guaranteed safe".

**"What if the twins all agree because the outsider's URL is in every replay?"**
Value tracing: any key value that appears only in outside content goes to a human even when the twins agree. That's the "laundered value, stated as fact" row; nothing else in our eval catches it except reviewing everything.

**"Why Durable Actors? Why not a database?"**
The Court's correctness depends on no two calls interleaving. Actors give that by construction, plus durable state and real-time streaming. Our model checker shows the exact failure when interleaving is allowed.

**"Why Agent Relay?"**
Authority lives in the chain between agents, and Relay is where the chain is. The Court owns the actions on Relay, so enforcement happens in Relay's own policy hook, and lineage comes from Relay's own messages, not from what an agent claims.

**"Is the demo real?"**
The Court, lineage, statistics, certificates and model checker are the production code. In the simulation the twins are drawn from stated ground truths, visible round by round in the evidence drawer. The live runner puts OpenAI agents on Agent Relay with the Court as a Durable Actor.

**"What would make it fail?"**
An outsider's goal disguised as a natural subtask of the human's request can survive neutralization. Scope limits and human review stay as the backstop, and we say so.

**"Was this built today?"**
Yes. All code is from today's session (see the git history); we brainstormed the idea beforehand, which the rules allow.
