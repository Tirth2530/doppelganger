// SVG charts. Marks carry color, text uses ink tokens, hover rides on data-tip.

import { DECIDER_LABELS, type Decider } from "../../src/baselines.ts"
import type { DeciderScore } from "../../src/eval.ts"
import type { InfluenceOperating } from "../../src/stats.ts"
import type { ArmSummary, ExperimentConfig, LedgerPoint } from "../../src/types.ts"
import { esc, fixed, pct } from "./dom.ts"

const svg = (w: number, h: number, label: string, body: string) => `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" font-family="var(--font-ui)">${body}</svg>`

/** The influence e-process, log scale, against the 1/α line it must cross. */
export function ledgerChart(ledger: LedgerPoint[], threshold: number, maxRounds: number, verdict: string, stoppedFor: string | null, width: number): string {
    const W = Math.max(300, Math.round(width))
    const H = 220
    const m = { l: 40, r: 16, t: 16, b: 34 }
    const R = W - m.r
    const top = Math.max(threshold * 1.8, ...ledger.map(p => p.eValue), 1)
    const lo = Math.log10(0.2)
    const hi = Math.log10(top)
    const x = (n: number) => m.l + (n / maxRounds) * (R - m.l)
    const y = (v: number) => m.t + ((hi - Math.log10(Math.max(0.2, v))) / (hi - lo)) * (H - m.t - m.b)
    const p: string[] = []
    p.push(`<rect x="${m.l}" y="${m.t}" width="${R - m.l}" height="${y(threshold) - m.t}" fill="var(--wash-bad)"/>`)
    p.push(`<line x1="${m.l}" x2="${R}" y1="${y(threshold)}" y2="${y(threshold)}" stroke="var(--bad)" stroke-dasharray="4 3"/>`)
    p.push(`<text x="${m.l + 6}" y="${y(threshold) - 6}" fill="var(--bad)" font-size="11" font-weight="600">influenced if it crosses 1/α = ${fixed(threshold, 0)}</text>`)
    for (const v of [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].filter(v => v <= top)) {
        p.push(`<line x1="${m.l}" x2="${R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`)
        p.push(`<text x="${m.l - 6}" y="${y(v) + 4}" fill="var(--ink-3)" font-size="10" text-anchor="end">${v < 1 ? v : v.toFixed(0)}</text>`)
    }
    p.push(`<line x1="${m.l}" x2="${R}" y1="${y(1)}" y2="${y(1)}" stroke="var(--axis)"/>`)
    const step = maxRounds > 16 ? 4 : 2
    for (let n = 0; n <= maxRounds; n += step) p.push(`<text x="${x(n)}" y="${H - 16}" fill="var(--ink-3)" font-size="10" text-anchor="middle">${n}</text>`)
    p.push(`<text x="${(m.l + R) / 2}" y="${H - 2}" fill="var(--ink-2)" font-size="10.5" text-anchor="middle">rounds (three twins each)</text>`)
    if (stoppedFor === "futility" && ledger.length) {
        const last = ledger[ledger.length - 1].round
        p.push(`<rect x="${x(last)}" y="${m.t}" width="${R - x(last)}" height="${H - m.t - m.b}" fill="var(--wash-saved)"/>`)
        p.push(`<text x="${(x(last) + R) / 2}" y="${H - m.b - 8}" fill="var(--ink-2)" font-size="10.5" text-anchor="middle">rounds saved</text>`)
    }
    const stroke = verdict === "influenced" ? "var(--bad)" : verdict === "robust" ? "var(--good)" : "var(--ink-2)"
    if (ledger.length) {
        p.push(`<path d="M${m.l},${y(1)}${ledger.map(q => `L${x(q.round).toFixed(1)},${y(q.eValue).toFixed(1)}`).join("")}" fill="none" stroke="${stroke}" stroke-width="2.25" stroke-linejoin="round"/>`)
        for (const q of ledger) {
            const what = q.z === 1 ? "reworded twin kept the action, neutralized twin dropped it" : q.z === 0 ? "neutralized twin kept it, reworded twin dropped it" : "the two agreed: no evidence either way"
            const tip = `<b>Round ${q.round}</b><br>${what}<br>e = ${fixed(q.eValue, 2)}`
            p.push(`<g class="hit" data-tip="${esc(tip)}"><circle cx="${x(q.round)}" cy="${y(q.eValue)}" r="10" fill="transparent"/><circle cx="${x(q.round)}" cy="${y(q.eValue)}" r="4" fill="${q.z === 1 ? stroke : "var(--panel-2)"}" stroke="${stroke}" stroke-width="2"/></g>`)
        }
    } else p.push(`<text x="${(m.l + R) / 2}" y="${y(1) - 10}" fill="var(--ink-3)" font-size="11.5" text-anchor="middle">no rounds yet</text>`)
    return svg(W, H, `Influence evidence over ${ledger.length} rounds`, p.join(""))
}

/** One arm's reproduction rate with its exact Clopper–Pearson interval. */
export function armTrack(s: ArmSummary, color: string, width = 140): string {
    const W = width
    const x = (v: number) => 2 + v * (W - 4)
    const whisk = s.n
        ? `<line x1="${x(s.interval.lower)}" x2="${x(s.interval.upper)}" y1="8" y2="8" stroke="var(--ink-2)"/><line x1="${x(s.interval.lower)}" x2="${x(s.interval.lower)}" y1="4" y2="12" stroke="var(--ink-2)"/><line x1="${x(s.interval.upper)}" x2="${x(s.interval.upper)}" y1="4" y2="12" stroke="var(--ink-2)"/>`
        : ""
    return svg(W, 16, `${s.arm} ${pct(s.rate)}`, `<rect x="2" y="6" width="${W - 4}" height="4" rx="2" fill="var(--grid)"/><rect x="2" y="6" width="${Math.max(0, x(s.n ? s.rate : 0) - 2)}" height="4" rx="2" fill="${color}"/>${whisk}`)
}

/** Exact operating characteristic: P(influenced) as the reworded arm's rate rises, treatment pinned. */
export function operatingChart(curve: InfluenceOperating[], config: ExperimentConfig, width: number): string {
    const W = Math.max(300, Math.round(width))
    const H = 220
    const m = { l: 42, r: 16, t: 18, b: 42 }
    const R = W - m.r
    const pt = curve[0]?.pTreatment ?? 0.1
    const x = (v: number) => m.l + v * (R - m.l)
    const y = (v: number) => m.t + (1 - v) * (H - m.t - m.b)
    const p: string[] = []
    p.push(`<rect x="${x(0)}" y="${m.t}" width="${x(pt) - x(0)}" height="${y(0) - m.t}" fill="var(--wash-null)"/>`)
    p.push(`<text x="${x(pt) + 8}" y="${m.t + 12}" fill="var(--ink-3)" font-size="10">◀ no instruction effect: must stay under α</text>`)
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        p.push(`<line x1="${x(0)}" x2="${R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`)
        p.push(`<text x="${x(0) - 6}" y="${y(v) + 4}" fill="var(--ink-3)" font-size="10" text-anchor="end">${pct(v)}</text>`)
        p.push(`<text x="${x(v)}" y="${H - 24}" fill="var(--ink-3)" font-size="10" text-anchor="middle">${pct(v)}</text>`)
    }
    p.push(`<text x="${(x(0) + R) / 2}" y="${H - 6}" fill="var(--ink-2)" font-size="10.5" text-anchor="middle">how often the reworded twin keeps the action</text>`)
    p.push(`<line x1="${x(0)}" x2="${x(pt)}" y1="${y(config.alpha)}" y2="${y(config.alpha)}" stroke="var(--bad)" stroke-width="1.5"/>`)
    p.push(`<path d="${curve.map((o, i) => `${i ? "L" : "M"}${x(o.pControl).toFixed(1)},${y(o.influenced).toFixed(1)}`).join("")}" fill="none" stroke="var(--trust)" stroke-width="2.25"/>`)
    const step = (R - x(0)) / (curve.length - 1)
    for (const o of curve) p.push(`<rect class="hit" data-tip="${esc(`<b>reworded twin keeps it ${pct(o.pControl)}</b>, neutralized ${pct(o.pTreatment)}<br>declares influenced ${pct(o.influenced, 1)}`)}" x="${x(o.pControl) - step / 2}" y="${m.t}" width="${step}" height="${y(0) - m.t}" fill="transparent"/>`)
    return svg(W, H, "Probability of declaring influenced", p.join(""))
}

/**
 * The trade every alternative makes: attacks stopped against legitimate actions
 * that interrupt a human. Top-left is the only good place to be.
 */
export function frontierChart(scores: DeciderScore[], width: number): string {
    const W = Math.max(300, Math.round(width))
    const H = 300
    const m = { l: 46, r: 20, t: 22, b: 46 }
    const R = W - m.r
    const x = (v: number) => m.l + v * (R - m.l)
    const y = (v: number) => m.t + (1 - v) * (H - m.t - m.b)
    const p: string[] = []
    p.push(`<rect x="${x(0)}" y="${y(1)}" width="${x(0.5) - x(0)}" height="${y(0.95) - y(1) + 8}" fill="var(--wash-good)" rx="4"/>`)
    p.push(`<text x="${x(0) + 6}" y="${y(1) + 14}" fill="var(--good)" font-size="10.5" font-weight="600">where you want to be</text>`)
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        p.push(`<line x1="${x(0)}" x2="${R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`)
        p.push(`<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${y(0)}" stroke="var(--grid)"/>`)
        p.push(`<text x="${x(0) - 6}" y="${y(v) + 4}" fill="var(--ink-3)" font-size="10" text-anchor="end">${pct(v)}</text>`)
        p.push(`<text x="${x(v)}" y="${H - 26}" fill="var(--ink-3)" font-size="10" text-anchor="middle">${pct(v)}</text>`)
    }
    p.push(`<text x="${(x(0) + R) / 2}" y="${H - 6}" fill="var(--ink-2)" font-size="10.5" text-anchor="middle">legitimate actions that interrupt a human →</text>`)
    p.push(`<text transform="translate(12 ${(m.t + y(0)) / 2}) rotate(-90)" fill="var(--ink-2)" font-size="10.5" text-anchor="middle">attacks stopped →</text>`)
    const anchors: Record<Decider, { dx: number; dy: number; a: string }> = {
        authorization: { dx: 10, dy: -8, a: "start" },
        filter: { dx: 10, dy: 14, a: "start" },
        "single-arm": { dx: 10, dy: 14, a: "start" },
        "review-all": { dx: -10, dy: 18, a: "end" },
        doppelganger: { dx: 12, dy: -10, a: "start" }
    }
    for (const s of scores) {
        const me = s.decider === "doppelganger"
        const cx = x(s.legitReviewRate)
        const cy = y(s.attacksStopped)
        const tip = `<b>${esc(DECIDER_LABELS[s.decider])}</b><br>attacks stopped ${pct(s.attacksStopped)}<br>legit actions sent to a human ${pct(s.legitReviewRate)}<br>legit actions called attacks ${pct(s.falseAccusationRate)}`
        p.push(
            `<g class="hit" data-tip="${esc(tip)}"><circle cx="${cx}" cy="${cy}" r="14" fill="transparent"/><circle cx="${cx}" cy="${cy}" r="${me ? 7 : 5.5}" fill="${me ? "var(--seal)" : "var(--ink-2)"}" stroke="var(--panel)" stroke-width="2"/></g>`
        )
        const a = anchors[s.decider]
        p.push(`<text x="${cx + a.dx}" y="${cy + a.dy}" fill="${me ? "var(--seal)" : "var(--ink)"}" font-size="${me ? 12.5 : 11}" font-weight="${me ? 700 : 500}" text-anchor="${a.a}">${esc(DECIDER_LABELS[s.decider])}</text>`)
    }
    return svg(W, H, "Attacks stopped against legitimate actions that interrupt a human, per approach", p.join(""))
}
