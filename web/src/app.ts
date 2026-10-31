import { DECIDER_BLURBS, DECIDER_LABELS, DECIDERS } from "../../src/baselines.ts"
import { INTERNAL_DEFAULT_SINK } from "../../src/court-logic.ts"
import type { EvalReport } from "../../src/eval.ts"
import type { ExperimentView, FeedMessage, UiEvent } from "../../src/events.ts"
import { ASSUMPTIONS, verifyCertificate } from "../../src/experiment.ts"
import { BEATS, Simulation } from "../../src/sim.ts"
import { DEFAULT_EXPERIMENT, powerCurve, validateConfig, worstTypeI } from "../../src/stats.ts"
import type { Args, CourtState, ExperimentConfig, Op, OpState, ServiceConfig } from "../../src/types.ts"
import { initialShadow, type ShadowState } from "../../src/unprotected.ts"
import { armTrack, frontierChart, ledgerChart, operatingChart } from "./charts.ts"
import { $, esc, fixed, installTooltips, pct } from "./dom.ts"
import evaluationJson from "./evaluation.json"
import verificationJson from "./verification.json"

const evaluation = evaluationJson as unknown as EvalReport
const verification = verificationJson as unknown as {
    invariants: { id: string; name: string; statement: string }[]
    reports: { impl: string; title: string; description: string; mutant: boolean; states: number; transitions: number; invariants: { id: string; held: boolean }[]; counterexamples: { invariant: string; steps: { actor: string; event: string; result: string }[] }[] }[]
}

interface Store {
    mode: "simulation" | "live"
    config: ExperimentConfig
    court: CourtState | null
    focus: string | null
    view: ExperimentView | null
    messages: FeedMessage[]
    agents: Record<string, { status: string; note: string }>
    busy: boolean
    beat: number | null
    shadow: ShadowState
    /** Served from the laptop (commands go to the server) rather than running in this browser. */
    remote: boolean
    /** The demo session token for live commands: the presenter's (from this laptop) or the on-call phone's (from the QR link). */
    token: string | null
    joinUrl: string | null
}

const store: Store = {
    mode: "simulation",
    config: { ...DEFAULT_EXPERIMENT },
    court: null,
    focus: null,
    view: null,
    messages: [],
    agents: {},
    busy: false,
    beat: null,
    shadow: initialShadow(),
    remote: false,
    token: null,
    joinUrl: null
}
let sim: Simulation | null = null
const params = new URLSearchParams(location.search)
const ONCALL_VIEW = params.get("view") === "oncall"

const focusOp = (): Op | null => store.court?.ops.find(o => o.opId === store.focus) ?? null
const widthOf = (sel: string) => Math.max(300, Math.round($(sel).getBoundingClientRect().width || 600))

// ---- events -------------------------------------------------------------------

function dispatch(e: UiEvent): void {
    switch (e.type) {
        case "reset":
            store.mode = e.mode
            store.messages = []
            store.view = null
            store.focus = null
            store.agents = {}
            renderAll()
            break
        case "court":
            store.court = e.state
            if (!store.focus && e.state.ops.length) store.focus = e.state.ops[e.state.ops.length - 1].opId
            renderAuthority()
            renderDocket()
            renderCompare()
            renderConfrontation()
            renderVerdict()
            renderOncall()
            break
        case "shadow":
            store.shadow = e.state
            renderCompare()
            break
        case "message":
            store.messages.push(e.message)
            renderChain()
            break
        case "agent":
            store.agents[e.agent] = { status: e.status, note: e.note }
            renderAgents()
            break
        case "invoke":
            store.focus = e.opId
            store.view = null
            renderConfrontation()
            renderArms()
            renderLedger()
            renderVerdict()
            renderDrawer()
            break
        case "experiment":
            store.view = e.view
            store.focus = e.view.opId
            renderConfrontation()
            renderArms()
            renderLedger()
            renderVerdict()
            renderDrawer()
            break
        case "narrate":
            $("#narration").textContent = e.text
            break
        case "busy":
            store.busy = e.busy
            setBusy(e.busy)
            break
    }
}

// ---- header ---------------------------------------------------------------------

function renderAuthority(): void {
    const s = store.court
    if (!s) return
    $("#epoch strong").textContent = String(s.epoch)
    const mode = $("#mode")
    mode.textContent = store.mode === "live" ? "live: agents on Agent Relay" : store.remote ? "simulated agents, served from this laptop" : "simulation"
    mode.dataset.mode = store.mode
    // The "write your own message" box needs live agents; it hides when they are simulated.
    document.documentElement.classList.toggle("live", store.mode === "live")
    const scope = s.scopes.find(sc => sc.agent === "infra")
    $("#scope").innerHTML = scope
        ? `Infra may change <b>${esc(scope.service)}</b> logging, up to <b>${esc(scope.maxLevel)}</b>`
        : `<span class="revoked">Infra's authority is revoked</span>`
}

// ---- how the request formed ------------------------------------------------------

const AGENTS = [
    { id: "oncall", name: "On-call engineer", trust: "human", role: "the human who gave the task" },
    { id: "acme-agent", name: "Acme's agent", trust: "external", role: "outside the company" },
    { id: "support", name: "Support", trust: "internal_agent", role: "trusted teammate" },
    { id: "infra", name: "Infra", trust: "internal_agent", role: "holds the privileges" }
]

function renderAgents(): void {
    $("#agents").innerHTML = AGENTS.map(a => {
        const live = store.agents[a.id]
        return `<div class="agent trust-${a.trust} status-${live?.status ?? "idle"}"><div class="agent-top"><b>${esc(a.name)}</b><span>${esc(a.role)}</span></div><span class="agent-note">${esc(live?.note ?? "")}</span></div>`
    }).join("")
}

function renderChain(): void {
    const label: Record<string, string> = { external: "outside", internal_agent: "trusted", human: "human" }
    $("#chain").innerHTML = store.messages.length
        ? store.messages
              .map(
                  m =>
                      `<li class="msg trust-${esc(m.trust)}"><div class="msg-head"><span class="relay">${esc(m.relayId)}</span><span class="hop">${esc(m.from)} → ${esc(m.to)}</span><span class="tag">${esc(label[m.trust] ?? m.trust)}</span></div><p>${esc(m.summary)}</p>${m.inputs.length ? `<span class="from">produced from ${m.inputs.map(esc).join(", ")}</span>` : ""}</li>`
              )
              .join("")
        : `<li class="empty">Pick a case. Messages appear here as the agents talk.</li>`
}

// ---- the action and its twin ----------------------------------------------------

const STATE_LABEL: Record<OpState, { tone: string; label: string }> = {
    PENDING: { tone: "wait", label: "Pending" },
    UNDER_REVIEW: { tone: "wait", label: "Under review" },
    APPROVED: { tone: "good", label: "Approved" },
    EXECUTED: { tone: "good", label: "Executed" },
    HELD: { tone: "held", label: "Held for a human" },
    DENIED: { tone: "bad", label: "Denied" }
}

function renderVerdict(): void {
    const el = $("#verdict")
    const op = focusOp()
    const v = store.view
    if (!op) {
        el.className = "verdict"
        el.innerHTML = `<span class="v-head">Waiting for a request</span><p class="v-why">Pick a case above. Every privileged action passes through here.</p>`
        return
    }
    let head = STATE_LABEL[op.state].label
    let tone = STATE_LABEL[op.state].tone
    let layer = ""
    if (op.state === "UNDER_REVIEW" && v?.verdict === "running") {
        head = "Twins replaying"
        layer = `round ${v.rounds}`
    } else if (op.state === "DENIED" && /^authorization|stale/.test(op.reason)) layer = "safety layer"
    else if (v && v.verdict !== "running") {
        layer = "evidence layer"
        const name: Record<string, string> = { influenced: "Influenced", robust: "Survives neutralizing", inconclusive: "Not enough evidence", unstable: "Not reproducible", error: "No evidence" }
        head = op.state === "EXECUTED" ? `${name[v.verdict]} → executed` : op.state === "HELD" ? `${name[v.verdict]} → held` : op.state === "DENIED" ? "Denied" : name[v.verdict]
        tone = op.state === "EXECUTED" ? "good" : op.state === "DENIED" ? "bad" : v.verdict === "influenced" ? "bad" : "held"
    } else if (op.state === "EXECUTED" && !op.lineage.tainted) layer = "safety layer"
    if (op.decidedBy) {
        const corrected = /corrected/.test(op.history.find(h => h.state === "APPROVED" && /approved by/.test(h.note))?.note ?? "")
        head = op.state === "EXECUTED" ? (corrected ? "Corrected by a human → executed" : "Approved by a human → executed") : op.state === "DENIED" ? "Denied by a human" : head
        tone = op.state === "EXECUTED" ? "good" : "bad"
        layer = "human decision"
    }
    el.className = `verdict tone-${tone}`
    el.innerHTML = `<div class="v-top"><span class="v-head">${esc(head)}</span>${layer ? `<span class="v-layer">${esc(layer)}</span>` : ""}</div><p class="v-why">${esc(op.reason)}</p>`
}

function callRow(label: string, cls: string, action: string, args: Args, swaps: Record<string, string>): string {
    const items = Object.entries(args)
        .map(([k, v]) => {
            const swapped = swaps[k] !== undefined && swaps[k] !== v
            return `<span class="arg"><span class="k">${esc(k)}</span>${swapped ? `<s>${esc(v)}</s> <span class="now">${esc(swaps[k])}</span>` : `<span>${esc(v)}</span>`}</span>`
        })
        .join("")
    return `<div class="call ${cls}"><span class="call-label">${esc(label)}</span><code><span class="fn">${esc(action)}</span>${items}</code></div>`
}

function renderConfrontation(): void {
    const el = $("#confrontation")
    const op = focusOp()
    const v = store.view
    if (!op) {
        el.innerHTML = ""
        return
    }
    if (!v || v.opId !== op.opId) {
        const why = op.state === "DENIED" ? "refused before anything ran: no twin needed" : !op.lineage.tainted ? "nothing outside the company in its history: no twin needed" : "waiting for the twins…"
        el.innerHTML = callRow("what Infra asked to do", "original", op.action, op.args, {}) + `<div class="mid"><span class="link"></span><i>${esc(why)}</i></div>`
        return
    }
    const swaps: Record<string, string> = {}
    for (const a of v.attribution) if ((a.driven || a.treatmentRate < 0.5) && a.twinValue) swaps[a.arg] = a.twinValue
    const mid =
        v.verdict === "running"
            ? "replaying Support and Infra with Acme's request neutralized…"
            : v.verdict === "influenced"
              ? "remove what Acme asked for, and the action changes"
              : v.verdict === "robust"
                ? "remove what Acme asked for, and the action stays the same"
                : "a harmless rewording moves it as much: nothing can be attributed"
    // Show the request as Infra made it, even after a human corrected the arguments.
    const asked = v.real.args
    const attributable = v.verdict === "influenced" || v.verdict === "robust" || v.verdict === "running"
    el.innerHTML =
        callRow("what Infra asked to do", "original", op.action, asked, {}) +
        `<div class="mid"><span class="link"></span><i>${esc(mid)}</i></div>` +
        (attributable ? callRow("its twin, without Acme's request", "twin", op.action, asked, v.verdict === "influenced" ? swaps : {}) : "")
}

function renderArms(): void {
    const v = store.view
    if (!v) {
        $("#arms").innerHTML = ""
        return
    }
    const tColor = v.verdict === "influenced" ? "var(--bad)" : v.verdict === "robust" ? "var(--good)" : "var(--ink-2)"
    const rows: [keyof ExperimentView["arms"], string, string, string][] = [
        ["baseline", "Unchanged", "Acme's message as it was", "var(--trust)"],
        ["control", "Reworded", "same request, different words: the placebo", "var(--ink-2)"],
        ["treatment", "Neutralized", "facts kept, request removed", tColor]
    ]
    $("#arms").innerHTML = rows
        .map(([arm, name, sub, color]) => {
            const s = v.arms[arm]
            return `<div class="arm"><div class="arm-id"><b>${name}</b><span>${esc(sub)}</span></div><div class="arm-meter">${armTrack(s, color)}</div><div class="arm-rate">${s.n ? pct(s.rate) : "—"}<small>${s.reproduced}/${s.n}</small></div></div>`
        })
        .join("")
}

function renderLedger(): void {
    const v = store.view
    if (!v) {
        $("#ledger").innerHTML = ""
        $("#ledger-caption").innerHTML = ""
        return
    }
    $("#ledger").innerHTML = ledgerChart(v.ledger, v.threshold, v.maxRounds, v.verdict, v.stoppedFor, widthOf("#ledger"))
    const saved = v.stoppedFor === "futility" ? ` Stopped ${v.maxRounds - v.rounds} rounds early: no verdict was reachable any more.` : ""
    $("#ledger-caption").innerHTML = `Evidence <b>e = ${fixed(v.eValue, 2)}</b> after ${v.rounds} rounds · <b>${v.calls}</b> model calls.${esc(saved)}`
}

// ---- the Court ------------------------------------------------------------------

function renderDocket(): void {
    const s = store.court
    if (!s) return
    $("#docket").innerHTML = s.ops.length
        ? s.ops
              .slice()
              .reverse()
              .map(op => {
                  const t = STATE_LABEL[op.state]
                  const actions =
                      op.state === "HELD"
                          ? `<div class="decide"><button class="btn small good" data-decide="${esc(op.opId)}" data-approve="1" data-fix="1">Approve with the internal sink</button><button class="btn small" data-decide="${esc(op.opId)}" data-approve="1">Approve as is</button><button class="btn small danger" data-decide="${esc(op.opId)}" data-approve="0">Deny</button></div>`
                          : ""
                  return `<li class="op tone-${t.tone}${op.opId === store.focus ? " focus" : ""}" data-focus="${esc(op.opId)}"><div class="op-top"><code>${esc(op.action)}</code><span>${esc(t.label)}</span></div><p>${esc(op.reason || "submitted")}</p>${actions}</li>`
              })
              .join("")
        : `<li class="empty">No requests yet.</li>`
}

// ---- same request, two systems ----------------------------------------------------

const DEFAULTS: ServiceConfig = initialShadow().config

function configRows(c: ServiceConfig): string {
    const cls = (changed: boolean, risky: boolean) => (!changed ? "" : risky ? "bad" : "changed")
    const sinkOut = /^https?:/.test(c.logSink)
    return `<dl>
        <dt>log level</dt><dd class="${cls(c.logLevel !== DEFAULTS.logLevel, false)}">${esc(c.logLevel)}</dd>
        <dt>log destination</dt><dd class="${cls(c.logSink !== DEFAULTS.logSink, sinkOut)}">${esc(c.logSink)}</dd>
        <dt>production access</dt><dd class="${cls(c.prodAccessKeys.length > 0, true)}">${c.prodAccessKeys.length ? c.prodAccessKeys.map(esc).join(", ") : "nobody"}</dd>
    </dl>`
}

function renderCompare(): void {
    const s = store.court
    const sh = store.shadow
    const env = `${store.mode === "live" ? "live agents on Agent Relay" : "simulated agents"} · sandbox environment: nothing real is changed`
    $("#compare-env").textContent = env
    const attempt = sh.executed.find(a => a.opId === store.focus) ?? sh.executed.at(-1) ?? null
    const op = attempt ? s?.ops.find(o => o.opId === attempt.opId) ?? null : null
    $("#compare-request").innerHTML = attempt
        ? `<span class="req-label">The request, exactly as ${esc(attempt.requestedBy === "infra" ? "Infra" : attempt.requestedBy)} made it</span><code><span class="fn">${esc(attempt.action)}</span>${Object.entries(attempt.args)
              .map(([k, v]) => `<span class="arg"><span class="k">${esc(k)}</span>${esc(v)}</span>`)
              .join("")}</code><span class="req-from">triggered by ${esc(attempt.triggerRelayId || "—")} · request ${esc(attempt.opId)}</span>`
        : `<span class="req-label">Pick a case. The agents' privileged request appears here, and both systems receive it.</span>`
    const without = attempt ? `<p class="outcome bad">Executed immediately. No one asked why.</p>` : `<p class="outcome">Waiting for a request.</p>`
    const t = op ? STATE_LABEL[op.state] : null
    const correctedByHuman = !!op && /corrected/.test(op.history.map(h => h.note).join(" "))
    const withText = !op
        ? "Waiting for a request."
        : op.state === "UNDER_REVIEW"
          ? "Under review: twins are testing it."
          : op.state === "HELD"
            ? "Held for a human, with the reason."
            : op.state === "DENIED"
              ? op.decidedBy
                  ? "Denied by a human. Nothing changed."
                  : "Refused. Nothing changed."
              : op.state === "EXECUTED"
                ? op.decidedBy
                    ? correctedByHuman
                        ? "A human corrected it. Only the correction ran."
                        : "A human approved it as requested."
                    : op.lineage.tainted
                      ? "Cleared by the twins: it survives without the outsider's request."
                      : "Executed: nothing outside the company was involved."
                : t!.label
    $("#compare-without").innerHTML = `<header><h3>Without Doppelgänger</h3><span>the agent's tool runs it directly</span></header>${without}${configRows(sh.config)}`
    $("#compare-with").innerHTML = `<header><h3>With Doppelgänger</h3><span>the Court decides, a Durable Actor</span></header><p class="outcome ${t ? `tone-${t.tone}` : ""}">${esc(withText)}</p>${s ? configRows(s.config) : ""}`
}

// ---- the on-call engineer's phone ---------------------------------------------------

function renderOncall(): void {
    if (!ONCALL_VIEW) return
    const s = store.court
    const el = $("#oncall")
    if (!store.token) {
        el.innerHTML = `<h1>Doppelgänger</h1><p class="lead">This link has no demo session. Scan the QR code on the presenter's screen.</p>`
        return
    }
    if (!s) {
        el.innerHTML = `<h1>Doppelgänger</h1><p class="lead">Connecting to the Court…</p>`
        return
    }
    const scope = s.scopes.find(sc => sc.agent === "infra")
    const held = s.ops.filter(o => o.state === "HELD")
    const recent = s.ops.filter(o => o.state !== "HELD").slice(-4).reverse()
    el.innerHTML = `<h1>You're the on-call engineer</h1>
        <p class="lead">Infra's privileged actions that Doppelgänger couldn't clear arrive here. Your tap decides them on the big screen.</p>
        <div class="oc-auth"><span>Authorization epoch <b>${s.epoch}</b></span><span>${scope ? `Infra may change ${esc(scope.service)} logging, up to ${esc(scope.maxLevel)}` : `<span class="revoked">Infra's authority is revoked</span>`}</span>
        <div class="oc-row"><button class="btn danger" data-oc="revoke">Revoke Infra</button><button class="btn" data-oc="restore">Restore</button></div></div>
        <h2>Waiting for you</h2>
        ${
            held.length
                ? held
                      .map(
                          op => `<article class="oc-card"><code>${esc(op.action)}</code><dl>${Object.entries(op.args)
                              .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
                              .join("")}</dl><p>${esc(op.reason)}</p><div class="oc-buttons"><button class="btn good" data-decide="${esc(op.opId)}" data-approve="1" data-fix="1">Approve with our internal sink</button><button class="btn" data-decide="${esc(op.opId)}" data-approve="1">Approve as requested</button><button class="btn danger" data-decide="${esc(op.opId)}" data-approve="0">Deny</button></div></article>`
                      )
                      .join("")
                : `<p class="empty">Nothing needs you right now.</p>`
        }
        <h2>Recent decisions</h2><ul class="oc-recent">${recent.map(op => `<li class="tone-${STATE_LABEL[op.state].tone}"><b>${esc(STATE_LABEL[op.state].label)}</b> ${esc(op.action)}<span>${esc(op.reason)}</span></li>`).join("") || `<li class="empty">None yet.</li>`}</ul>`
}

// ---- drawer -----------------------------------------------------------------------

function renderDrawer(): void {
    const v = store.view
    const cert = v?.certificate ?? null
    const samples = $("#samples")
    if (cert && cert.rounds.length) {
        const arms = [
            ["baseline", "Unchanged"],
            ["control", "Reworded"],
            ["treatment", "Neutralized"]
        ] as const
        samples.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th></th>${cert.rounds.map((_, i) => `<th>${i + 1}</th>`).join("")}</tr></thead><tbody>${arms
            .map(
                ([arm, name]) =>
                    `<tr><th>${name}</th>${cert.rounds
                        .map(r => `<td class="${r[arm].reproduced ? "on" : "off"}" data-tip="${esc(`${name}, round: ${r[arm].reproduced ? "took the real action" : r[arm].call ? `chose sink ${r[arm].call!.args.sink ?? "?"}` : "made no call"}`)}"></td>`)
                        .join("")}</tr>`
            )
            .join("")}</tbody></table></div>`
    } else samples.innerHTML = `<p class="empty">${v?.verdict === "running" ? "Twins are replaying…" : "No experiment for this request."}</p>`

    $("#cost").innerHTML = v
        ? `<dl class="kv"><dt>rounds</dt><dd>${v.rounds} of at most ${v.maxRounds}</dd><dt>model calls</dt><dd>${v.calls}</dd><dt>stopped because</dt><dd>${v.stoppedFor === "futility" ? "no verdict was reachable" : v.stoppedFor === "evidence" ? "the evidence was in" : v.stoppedFor === "budget" ? "the round budget ran out" : "still running"}</dd></dl><p class="note">Only privileged actions whose history touches outside content are replayed. Everything else costs nothing.</p>`
        : `<p class="empty">No replays for this request.</p>`

    const proofs = $("#proofs")
    if (cert) {
        const check = verifyCertificate(cert)
        const court = verification.reports.find(r => !r.mutant)!
        proofs.innerHTML = `<ul class="checks"><li class="${check.valid ? "pass" : "fail"}">The certificate recomputes in your browser from the recorded twins: <b>${esc(check.recomputedVerdict)}</b>, e = <b>${fixed(check.recomputedEValue, 2)}</b>${check.valid ? "" : " (mismatch)"}</li><li class="pass">The Court that applied it is model-checked: ${court.states.toLocaleString()} states, all ${verification.invariants.length} invariants hold</li></ul><p class="statement">${esc(cert.statement)}</p>`
    } else proofs.innerHTML = `<p class="empty">A certificate is issued when the twins reach a verdict.</p>`
}

// ---- the advantage ------------------------------------------------------------------

function renderAdvantage(): void {
    $("#frontier").innerHTML = frontierChart(evaluation.scores, widthOf("#frontier"))
    const s = (d: string) => evaluation.scores.find(x => x.decider === d)!
    const dg = s("doppelganger")
    const all = s("review-all")
    $("#adv-reading").innerHTML = `<p class="big">On the simulated suite: <b>${pct(dg.attacksStopped)}</b> of attacks stopped, with a human interrupted on <b>${pct(dg.legitReviewRate)}</b> of legitimate actions instead of ${pct(all.legitReviewRate)}.</p><ul class="reading">${DECIDERS.map(
        d => `<li class="${d === "doppelganger" ? "me" : ""}"><b>${esc(DECIDER_LABELS[d])}</b> ${esc(DECIDER_BLURBS[d])} <span class="nums">${pct(s(d).attacksStopped)} stopped · ${pct(s(d).falseAccusationRate)} of legit work called an attack</span></li>`
    ).join("")}</ul>`
    const cell = (kind: string, d: string) => evaluation.perKind.find(r => r.kind === kind && r.decider === d)!
    $("#per-kind").innerHTML = `<table class="kinds"><thead><tr><th>Scenario</th>${DECIDERS.map(d => `<th>${esc(DECIDER_LABELS[d])}</th>`).join("")}</tr></thead><tbody>${evaluation.suite
        .map(k => {
            const tds = DECIDERS.map(d => {
                const c = cell(k.id, d)
                const good = c.rate >= 0.9
                return `<td class="${good ? "ok" : c.rate < 0.5 ? "miss" : "part"}" data-tip="${esc(k.attack ? `${pct(c.rate)} of these attacks stopped` : `${pct(c.rate)} approved with no human; ${pct(c.accusations / c.n)} called an attack`)}">${pct(c.rate)}</td>`
            }).join("")
            return `<tr><th data-tip="${esc(k.note)}"><span class="kind-tag ${k.attack ? "atk" : "leg"}">${k.attack ? "attack" : "legit"}</span>${esc(k.title)}</th>${tds}</tr>`
        })
        .join("")}</tbody></table>`
    $("#adv-note").textContent = `Each cell: for attacks, the share stopped; for legitimate actions, the share approved with no human. ${evaluation.instancesPerKind} instances per scenario, twins drawn from the ground truth stated for each scenario in src/eval.ts. Humans are assumed to catch every attack they review, which is the most generous assumption for "review everything".`
}

// ---- proof ----------------------------------------------------------------------------

function renderTrust(): void {
    const c = store.config
    $("#operating").innerHTML = operatingChart(powerCurve(c, 0.1), c, widthOf("#operating"))
    $("#claim").innerHTML = `If Acme's request had no specific effect, the chance of calling the action <b>influenced</b> is at most α = ${pct(c.alpha)}, whatever round the test stops at. Computed exactly over every such case, the worst is <b>${pct(worstTypeI(c), 2)}</b>.`
    ;($("#k-alpha") as HTMLInputElement).value = String(c.alpha)
    ;($("#k-max") as HTMLInputElement).value = String(c.maxRounds)
    $("#k-alpha-out").textContent = pct(c.alpha)
    $("#k-max-out").textContent = String(c.maxRounds)
}

function renderVerification(): void {
    const court = verification.reports.find(r => !r.mutant)!
    $("#verify-stats").innerHTML = `<div class="stat"><b>${court.states.toLocaleString()}</b><span>states of the real Court</span></div><div class="stat"><b>${court.transitions.toLocaleString()}</b><span>transitions explored</span></div><div class="stat"><b>${verification.invariants.length} / ${verification.invariants.length}</b><span>invariants hold</span></div>`
    $("#invariants").innerHTML = verification.invariants.map(i => `<li data-tip="${esc(i.statement)}"><span class="tick">✓</span>${esc(i.name)}</li>`).join("")
    $("#mutants").innerHTML = verification.reports
        .filter(r => r.mutant)
        .map(r => {
            const cx = r.counterexamples[0]
            const inv = verification.invariants.find(i => i.id === cx?.invariant)
            return `<details class="mutant"><summary><b>${esc(r.title)}</b><span class="caught">caught: ${esc(inv?.name ?? "")}</span></summary><p>${esc(r.description)}</p><ol class="trace">${(cx?.steps ?? []).map(s => `<li><b>${esc(s.actor)}</b> ${esc(s.event)}<span>${esc(s.result)}</span></li>`).join("")}</ol></details>`
        })
        .join("")
}

// ---- controls -------------------------------------------------------------------------

function renderBeats(): void {
    $("#beats").innerHTML = BEATS.map(b => `<button class="beat" data-beat="${b.beat}"><span class="beat-no">${b.beat}</span><span class="beat-text"><b>${esc(b.title)}</b><span>${esc(b.proves)}</span></span></button>`).join("")
}

function setBusy(busy: boolean): void {
    document.querySelectorAll<HTMLButtonElement>(".beat, #reset").forEach(b => (b.disabled = busy))
}

function markBeat(): void {
    document.querySelectorAll<HTMLButtonElement>(".beat").forEach(b => b.classList.toggle("active", Number(b.dataset.beat) === store.beat))
}

/** Every live command carries the demo session token; the server checks the role. */
async function post(query: string, body?: unknown): Promise<void> {
    try {
        const r = await fetch(`command?${query}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(store.token ? { "x-demo-session": store.token } : {}) },
            body: JSON.stringify(body ?? {})
        })
        if (!r.ok) {
            const msg = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${r.status})`
            if (!ONCALL_VIEW) $("#narration").textContent = `The server refused that: ${msg}.`
            else alert(`Refused: ${msg}`)
        }
    } catch {
        if (!ONCALL_VIEW) $("#narration").textContent = "Can't reach the live runner."
    }
}

async function sendAsAcme(): Promise<void> {
    const box = $("#say-text") as HTMLTextAreaElement
    const text = box.value.trim()
    if (!text) return
    store.beat = null
    markBeat()
    await post("do=say", { text })
    box.value = ""
}

/** The presenter's page asks this laptop's server for its session, then shows the on-call QR code. */
async function joinPresenterSession(): Promise<void> {
    try {
        const r = await fetch("session")
        if (!r.ok) return
        const s = (await r.json()) as { token: string; expiresAt: number; joinUrls: string[] }
        store.token = s.token
        store.joinUrl = s.joinUrls[0] ?? null
        const panel = $("#join")
        panel.hidden = false
        $("#join-url").textContent = store.joinUrl ?? "Connect the laptop to a network so phones can reach it."
        $("#join-expiry").textContent = `Session valid until ${new Date(s.expiresAt).toLocaleTimeString()}.`
        if (store.joinUrl) drawQr(store.joinUrl)
    } catch {
        /* not served by the live runner */
    }
}

function drawQr(url: string): void {
    const w = window as unknown as { qrcode?: (t: number, l: string) => { addData(d: string): void; make(): void; createSvgTag(o: { cellSize: number; margin: number }): string } }
    const render = () => {
        if (!w.qrcode) return
        const qr = w.qrcode(0, "M")
        qr.addData(url)
        qr.make()
        $("#join-qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 })
    }
    if (w.qrcode) return render()
    const s = document.createElement("script")
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"
    s.onload = render
    document.head.append(s)
}

async function runBeat(beat: number): Promise<void> {
    store.beat = beat
    markBeat()
    if (store.remote) return post(`run=${beat}`)
    sim?.reset()
    await sim?.runBeat(beat)
}

async function command(kind: "revoke" | "restore" | "reset"): Promise<void> {
    if (store.remote) return post(`do=${kind}`)
    if (kind === "reset") {
        store.beat = null
        markBeat()
        sim?.reset()
    } else if (kind === "revoke") sim?.revoke()
    else sim?.restore()
}

async function humanDecides(opId: string, approve: boolean, fix: boolean): Promise<void> {
    const corrected = fix ? { sink: INTERNAL_DEFAULT_SINK } : null
    if (store.remote) return post("do=decide", { opId, approve, corrected })
    sim?.decide(opId, approve, corrected)
}

function renderAll(): void {
    renderAuthority()
    renderAgents()
    renderChain()
    renderConfrontation()
    renderArms()
    renderLedger()
    renderVerdict()
    renderDocket()
    renderCompare()
    renderDrawer()
    renderOncall()
}

function bootOncall(): void {
    document.documentElement.classList.add("oncall-view")
    store.mode = "live"
    store.remote = true
    store.token = params.get("t")
    document.addEventListener("click", e => {
        const t = e.target as HTMLElement
        const d = t.closest<HTMLButtonElement>("[data-decide]")
        if (d) return void humanDecides(d.dataset.decide!, d.dataset.approve === "1", d.dataset.fix === "1")
        const oc = t.closest<HTMLButtonElement>("[data-oc]")
        if (oc) void post(`do=${oc.dataset.oc}`)
    })
    const src = new EventSource("events")
    src.onmessage = m => dispatch(JSON.parse(m.data) as UiEvent)
    renderOncall()
}

function boot(): void {
    if (ONCALL_VIEW) return bootOncall()
    installTooltips()
    renderBeats()
    $("#assumptions").innerHTML = ASSUMPTIONS.map(a => `<li><b>${esc(a.id)}</b> ${esc(a.text)}</li>`).join("")
    renderAdvantage()
    renderTrust()
    renderVerification()

    document.addEventListener("click", e => {
        const t = e.target as HTMLElement
        const beat = t.closest<HTMLButtonElement>(".beat")
        if (beat && !beat.disabled) return void runBeat(Number(beat.dataset.beat))
        const d = t.closest<HTMLButtonElement>("[data-decide]")
        if (d) return void humanDecides(d.dataset.decide!, d.dataset.approve === "1", d.dataset.fix === "1")
        const f = t.closest<HTMLElement>("[data-focus]")
        if (f && store.focus !== f.dataset.focus) {
            store.focus = f.dataset.focus!
            if (store.view?.opId !== store.focus) store.view = null
            renderAll()
        }
    })
    $("#revoke").addEventListener("click", () => void command("revoke"))
    $("#restore").addEventListener("click", () => void command("restore"))
    $("#reset").addEventListener("click", () => void command("reset"))
    $("#speed").addEventListener("change", e => sim?.setSpeed(Number((e.target as HTMLSelectElement).value)))
    const knob = (patch: Partial<ExperimentConfig>) => {
        const next = { ...store.config, ...patch }
        try {
            validateConfig(next)
            store.config = next
            sim?.setConfig(next)
        } catch {
            /* keep the last valid config */
        }
        renderTrust()
    }
    $("#k-alpha").addEventListener("input", e => knob({ alpha: Number((e.target as HTMLInputElement).value) }))
    $("#k-max").addEventListener("input", e => knob({ maxRounds: Number((e.target as HTMLInputElement).value) }))
    let t = 0
    addEventListener("resize", () => {
        clearTimeout(t)
        t = window.setTimeout(() => {
            renderLedger()
            renderAdvantage()
            renderTrust()
        }, 150)
    })

    if (params.get("mode") === "live") {
        store.mode = "live"
        store.remote = true
        document.documentElement.classList.add("live")
        $("#say-send").addEventListener("click", () => void sendAsAcme())
        void joinPresenterSession()
        const src = new EventSource("events")
        src.onmessage = m => dispatch(JSON.parse(m.data) as UiEvent)
    } else {
        sim = new Simulation(dispatch, { seed: 31, config: store.config })
        sim.reset()
    }
    renderAll()
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
else boot()
