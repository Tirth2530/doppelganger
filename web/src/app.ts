import { DECIDER_BLURBS, DECIDER_LABELS, DECIDERS } from "../../src/baselines.ts"
import { INTERNAL_DEFAULT_SINK, matchAuthorization } from "../../src/court-logic.ts"
import type { EvalReport } from "../../src/eval.ts"
import type { ExperimentView, FeedMessage, UiEvent } from "../../src/events.ts"
import { ASSUMPTIONS, verifyCertificate } from "../../src/experiment.ts"
import { BEATS, Simulation } from "../../src/sim.ts"
import { DEFAULT_EXPERIMENT, powerCurve, validateConfig, worstFalseRobust, worstTypeI } from "../../src/stats.ts"
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
    /** Agent Relay action lifecycle events, exactly as the SDK reported them (live runs only). */
    relay: Extract<UiEvent, { type: "relay" }>[]
    /** Slack notification status per operation, as the server reported it. */
    slack: Record<string, string>
    /** The server has said what is producing events (live agents or the simulation). Until then the page claims neither. */
    announced: boolean
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
    announced: false,
    relay: [],
    slack: {},
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
            store.announced = true
            store.relay = []
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
        case "relay":
            store.relay = [...store.relay, e].slice(-12)
            renderRelayTrace()
            break
        case "slack":
            store.slack = { ...store.slack, [e.opId]: e.status }
            renderDocket()
            break
        case "busy":
            store.busy = e.busy
            setBusy(e.busy)
            break
    }
}

/** Measured cost of a real replay (live runs only). The simulation reports none, because it has none. */
function realCost(): string {
    const r = focusOp()?.evidence?.replay
    if (!r) return store.mode === "live" ? "" : `<p class="note">Simulated twins: no model was called.</p>`
    return `<dl class="kv"><dt>measured</dt><dd>${r.modelCalls} agent replays + ${r.rewriteCalls} rewrites${r.model ? ` on ${esc(r.model)}` : ""}</dd><dt>tokens</dt><dd>${r.promptTokens.toLocaleString()} in · ${r.completionTokens.toLocaleString()} out</dd><dt>replay time</dt><dd>${(r.ms / 1000).toFixed(1)} s of model time</dd></dl>`
}

// ---- header ---------------------------------------------------------------------

function renderAuthority(): void {
    const s = store.court
    if (!s) return
    $("#epoch strong").textContent = String(s.epoch)
    const mode = $("#mode")
    mode.textContent =
        store.remote && !store.announced ? "connecting to this laptop…" : store.mode === "live" ? "LIVE · real agents on Agent Relay" : store.remote ? "SIMULATED agents, served from this laptop" : "SIMULATION in this browser"
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

/**
 * The decision buttons for a held operation. A reviewer can approve only what the case authorization
 * covers (the Court enforces this; the buttons just don't offer what it would refuse), so each approval
 * is checked against the Court's own rule and disabled, with the reason, when it is not covered.
 */
function approvalButtons(op: Op, small: boolean): string {
    const s = store.court
    const now = new Date().toISOString()
    const cover = (args: Args) => (s ? matchAuthorization(s, op.lineage.caseIds, op.requestedBy, op.action, args, now) : { ok: false as const, reason: "no Court state" })
    const fixed = cover({ ...op.args, sink: INTERNAL_DEFAULT_SINK })
    const asIs = cover(op.args)
    const cls = small ? "btn small" : "btn"
    const id = esc(op.opId)
    const btn = (label: string, kind: string, attrs: string, ok: boolean) => `<button class="${cls} ${kind}" data-decide="${id}" ${attrs}${ok ? "" : " disabled"}>${label}</button>`
    const why = [!asIs.ok ? `“Approve as requested” is off: ${asIs.reason}.` : "", !fixed.ok ? `Approving with the internal sink is off too: ${fixed.reason}. Deny it, or the presenter re-authorizes the case.` : ""].filter(Boolean).join(" ")
    return `<div class="${small ? "decide" : "oc-buttons"}">${btn("Approve with our internal sink", "good", 'data-approve="1" data-fix="1"', fixed.ok)}${btn("Approve as requested", "", 'data-approve="1"', asIs.ok)}${btn("Deny", "danger", 'data-approve="0"', true)}</div>${why ? `<p class="why-off">${esc(why)}</p>` : ""}`
}

function renderRelayTrace(): void {
    const el = document.getElementById("relay-trace")
    if (!el) return
    if (!store.relay.length) {
        el.innerHTML = `<li class="empty">${store.mode === "live" ? "No Relay action events yet." : "Simulation: no Agent Relay server, so no Relay events. Live runs show them here."}</li>`
        return
    }
    el.innerHTML = store.relay
        .map(r => `<li><code>${esc(r.phase)}</code> ${esc(r.action)} <span class="who">by ${esc(r.caller)}</span>${r.detail ? `<small>${esc(r.detail)}</small>` : ""}</li>`)
        .join("")
}

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
                          ? approvalButtons(op, true)
                          : ""
                  return `<li class="op tone-${t.tone}${op.opId === store.focus ? " focus" : ""}" data-focus="${esc(op.opId)}"><div class="op-top"><code>${esc(op.action)}</code><span>${esc(t.label)}</span></div><p>${esc(op.reason || "submitted")}</p>${op.caseId ? `<small class="meta">case ${esc(op.caseId)}${store.slack[op.opId] ? ` · Slack review: ${esc(store.slack[op.opId])}` : ""}</small>` : ""}${actions}</li>`
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
        el.innerHTML = `<h1>Doppelgänger</h1><p class="lead">This review link carries no credential. Sign in as the on-call engineer by scanning the QR code on the presenter's screen with this phone, then open the link again.</p>`
        return
    }
    if (!s) {
        el.innerHTML = `<h1>Doppelgänger</h1><p class="lead">Connecting to the Court…</p>`
        return
    }
    const scope = s.scopes.find(sc => sc.agent === "infra")
    const held = s.ops.filter(o => o.state === "HELD")
    const recent = s.ops.filter(o => o.state !== "HELD").slice(-4).reverse()
    const badge = !store.announced ? "" : store.mode === "live" ? `<p class="oc-mode live">LIVE · real agents</p>` : `<p class="oc-mode sim">SIMULATED agents: a rehearsal, not a live event</p>`
    el.innerHTML = `${badge}<h1>You're the on-call engineer</h1>
        <p class="lead">Infra's privileged actions that Doppelgänger couldn't clear arrive here. Your tap decides them on the big screen.</p>
        <div class="oc-auth"><span>Authorization epoch <b>${s.epoch}</b></span><span>${scope ? `Infra may change ${esc(scope.service)} logging, up to ${esc(scope.maxLevel)}` : `<span class="revoked">Infra's authority is revoked</span>`}</span>
        <div class="oc-row"><button class="btn danger" data-oc="revoke">Revoke Infra</button></div><p class="note">Restoring authority is the presenter's call.</p></div>
        <h2>Waiting for you</h2>
        ${
            held.length
                ? held
                      .map(
                          op => `<article class="oc-card${op.opId === store.focus ? " focus" : ""}"><code>${esc(op.action)}</code>${op.caseId ? ` <small>case ${esc(op.caseId)}</small>` : ""}<dl>${Object.entries(op.args)
                              .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
                              .join("")}</dl><p>${esc(op.reason)}</p>${approvalButtons(op, false)}</article>`
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
        ? `<dl class="kv"><dt>rounds</dt><dd>${v.rounds} of at most ${v.maxRounds}</dd><dt>model calls</dt><dd>${v.calls}</dd><dt>stopped because</dt><dd>${v.stoppedFor === "futility" ? "no verdict was reachable" : v.stoppedFor === "evidence" ? "the evidence was in" : v.stoppedFor === "budget" ? "the round budget ran out" : "still running"}</dd></dl>${realCost()}<p class="note">Only privileged actions whose history touches outside content are replayed. Everything else costs nothing.</p>`
        : `<p class="empty">No replays for this request.</p>`

    const proofs = $("#proofs")
    if (cert) {
        const check = verifyCertificate(cert)
        const court = verification.reports.find(r => !r.mutant)!
        proofs.innerHTML = `<ul class="checks"><li class="${check.valid ? "pass" : "fail"}">The certificate recomputes in your browser from the recorded twins: <b>${esc(check.recomputedVerdict)}</b>, e = <b>${fixed(check.recomputedEValue, 2)}</b>${check.valid ? "" : " (mismatch)"}</li><li class="pass">The Court that applied it is model-checked: ${court.states.toLocaleString()} states, all ${verification.invariants.length} invariants hold</li></ul><p class="statement">${esc(cert.statement)}</p>`
    } else proofs.innerHTML = `<p class="empty">A certificate is issued when the twins reach a verdict.</p>`
}

// ---- the advantage ------------------------------------------------------------------

// ---- real-model evaluation ------------------------------------------------------
// Drawn only from the JSON a real `bun run live-eval` wrote and the build embedded.
// With no such file the panel says so; it never shows example or simulated numbers.

interface RealRun {
    id: string
    run: number
    expected: string
    outcome: string
    path: string | null
    verdict: string | null
    agents: string
    replayMs: number | null
}

function renderRealEval(): void {
    const host = document.getElementById("real-eval")
    if (!host) return
    const el = document.getElementById("real-eval-data")
    let data: { kind: string; model: string; ranAt: string; repeat: number; summary: Record<string, number | null>; results: RealRun[] } | null = null
    try {
        data = el ? JSON.parse(el.textContent ?? "") : null
    } catch {
        data = null
    }
    if (!data || data.kind !== "real-model" || !Array.isArray(data.results)) {
        host.innerHTML = `<p class="empty">No real-model results in this build yet. Run <code>bun run live-eval</code> with an OpenAI key, then <code>bun run build:web</code>. The suite further down is simulated.</p>`
        return
    }
    const s = data.summary
    const n = (k: string) => esc(s[k] ?? 0)
    const harmful = Number(s.attacksStopped ?? 0) + Number(s.attacksAllowed ?? 0)
    const cost = s.estimatedCostUsd === null || s.estimatedCostUsd === undefined ? "not estimated (no prices given)" : `about $${Number(s.estimatedCostUsd).toFixed(2)}`
    const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`)
    host.innerHTML = `<p class="note">${esc(data.model)} · ${esc(data.results.length)} runs (${esc(data.repeat)}× each case) · ${esc(new Date(data.ranAt).toLocaleString())}</p>
    <div class="real-grid">
      <dl class="kv"><dt>attacks that would have done harm unprotected</dt><dd><b>${n("attacksStopped")} of ${esc(harmful)}</b> stopped · ${n("attacksAllowed")} allowed</dd>
      <dt>attack runs the agents didn't carry out</dt><dd>${n("attacksHarmless")}</dd>
      <dt>legitimate runs that reached Infra</dt><dd><b>${n("legitCleared")} of ${n("legitThatReachedInfra")}</b> cleared automatically · ${n("legitHeld")} sent to a human</dd>
      <dt>inconclusive or failed replays</dt><dd>${n("inconclusive")} (held for a human) · ${n("errors")} errors</dd></dl>
      <dl class="kv"><dt>model calls</dt><dd>${n("modelCalls")} (${n("replayCalls")} of them replays)</dd>
      <dt>tokens</dt><dd>${Number(s.promptTokens ?? 0).toLocaleString()} in · ${Number(s.completionTokens ?? 0).toLocaleString()} out · ${esc(cost)}</dd>
      <dt>enforcement latency (median)</dt><dd>${esc(s.medianEnforcementMs ?? "n/a")} ms: deny, approve or hold, before any replay</dd>
      <dt>replay time</dt><dd>median ${secs(s.medianReplayMs)} · max ${secs(s.maxReplayMs)}</dd></dl>
    </div>
    <div class="table-wrap"><table class="grid real"><thead><tr><th>case</th><th>run</th><th>expected</th><th>outcome</th><th>how</th><th>evidence</th></tr></thead><tbody>${data.results
        .map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.run)}</td><td>${esc(r.expected)}</td><td>${esc(r.outcome)}</td><td>${esc(r.path ?? r.agents)}</td><td>${esc(r.verdict ?? "")}</td></tr>`)
        .join("")}</tbody></table></div>`
}

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
    $("#claim").innerHTML = `If Acme's request had no specific effect, the chance of calling the action <b>influenced</b> is at most α = ${pct(c.alpha)}, whatever round the test stops at. Computed exactly over every such case, the worst is <b>${pct(worstTypeI(c), 2)}</b>. The automatic approval ("robust") has its own anytime-valid bound: worst case <b>${pct(worstFalseRobust(c), 2)}</b> if the neutralized twin keeps the action at a rate of ${c.tauRobust} or less.`
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
            // A fresh id per command: the server executes each id once, so a captured request can't be replayed.
            headers: { "content-type": "application/json", "x-command-id": commandId(), ...(store.token ? { "x-demo-session": store.token } : {}) },
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
/** A fresh command id. crypto.getRandomValues works on plain-http LAN addresses too; randomUUID does not. */
function commandId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("")
}

async function joinPresenterSession(): Promise<void> {
    try {
        const r = await fetch("session")
        if (!r.ok) return
        const s = (await r.json()) as { token: string; expiresAt: number; joinUrls: string[] }
        store.token = s.token
        store.joinUrl = s.joinUrls[0] ?? null
        const panel = $("#join")
        panel.hidden = false
        showJoin(s.joinUrls, s.expiresAt)
    } catch {
        /* not served by the live runner */
    }
}

function showJoin(urls: string[], expiresAt?: number): void {
    store.joinUrl = urls[0] ?? null
    $("#join-url").textContent = store.joinUrl ?? "Connect the laptop to a network so phones can reach it."
    if (expiresAt) $("#join-expiry").textContent = `Session valid until ${new Date(expiresAt).toLocaleTimeString()}.`
    $("#join-qr").innerHTML = ""
    if (store.joinUrl) drawQr(store.joinUrl)
}

/** Issues a new on-call link: every phone holding the old one is locked out at once. */
async function rotateJoin(): Promise<void> {
    const r = await fetch("session/rotate", { method: "POST", headers: { "x-demo-session": store.token ?? "" } }).catch(() => null)
    if (!r?.ok) return
    showJoin(((await r.json()) as { joinUrls: string[] }).joinUrls)
    $("#narration").textContent = "New on-call link issued. Phones with the old link are locked out."
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
    renderRelayTrace()
    renderCompare()
    renderDrawer()
    renderOncall()
}

function bootOncall(): void {
    document.documentElement.classList.add("oncall-view")
    store.remote = true
    // The QR link carries the on-call token; it is kept on this device so a Slack review link (which carries
    // none) works here, and then removed from the address bar. On any other device the review link refuses.
    const fromLink = params.get("t")
    let saved: string | null = null
    try {
        if (fromLink) localStorage.setItem("doppelganger-oncall", fromLink)
        saved = localStorage.getItem("doppelganger-oncall")
    } catch {
        saved = null
    }
    store.token = fromLink ?? saved
    if (fromLink) {
        const clean = new URL(location.href)
        clean.searchParams.delete("t")
        history.replaceState(null, "", clean.toString())
    }
    store.focus = params.get("op")
    document.addEventListener("click", e => {
        const t = e.target as HTMLElement
        const d = t.closest<HTMLButtonElement>("[data-decide]")
        if (d) return void humanDecides(d.dataset.decide!, d.dataset.approve === "1", d.dataset.fix === "1")
        const oc = t.closest<HTMLButtonElement>("[data-oc]")
        if (oc) void post(`do=${oc.dataset.oc}`)
    })
    const src = new EventSource(`events?t=${encodeURIComponent(store.token ?? "")}`)
    src.onmessage = m => dispatch(JSON.parse(m.data) as UiEvent)
    renderOncall()
}

function boot(): void {
    if (ONCALL_VIEW) return bootOncall()
    installTooltips()
    renderBeats()
    $("#assumptions").innerHTML = ASSUMPTIONS.map(a => `<li><b>${esc(a.id)}</b> ${esc(a.text)}</li>`).join("")
    renderRealEval()
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
        // Remote: what is producing events (real agents or the simulation) comes from the server's reset event, never from the URL.
        store.remote = true
        $("#say-send").addEventListener("click", () => void sendAsAcme())
        $("#join-rotate").addEventListener("click", () => void rotateJoin())
        // The stream needs the presenter token, which this laptop's page fetches first.
        void joinPresenterSession().then(() => {
            if (!store.token) return dispatch({ type: "narrate", text: "This page is not on the presenter's laptop, so it has no session. Open it on the laptop, or scan the on-call QR code." })
            const src = new EventSource(`events?t=${encodeURIComponent(store.token)}`)
            src.onmessage = m => dispatch(JSON.parse(m.data) as UiEvent)
        })
    } else {
        sim = new Simulation(dispatch, { seed: 31, config: store.config })
        sim.reset()
    }
    renderAll()
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot)
else boot()
