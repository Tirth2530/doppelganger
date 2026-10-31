// Slack notifications for held actions: optional, outbound only, never in the
// enforcement path.
//
// Watches the Court's own state (the same events the dashboard gets from the
// Court). The first time an operation is HELD, posts one message to a Slack
// incoming webhook with what was requested, by whom, from where, why it is
// held, the case, and a "Review action" link.
//
// The link carries NO credential. It opens the on-call review page for that
// operation; the engineer must already hold an on-call session on that device
// (from the QR code) or the page refuses. Every decision still goes through the
// authenticated server and the Court, which re-checks authority.
//
// Failure handling: per-attempt timeout, up to three attempts with backoff (and
// Slack's Retry-After on 429), one message per operation (deduplicated before
// sending, so retries of observation never double-post). If Slack is not
// configured or down, nothing else changes: a held action stays held.
//
//   SLACK_WEBHOOK_URL   https://hooks.slack.com/services/…  (unset: notifications off)
//   PUBLIC_URL          base URL for the review link (e.g. your tunnel); default http://localhost:PORT

import type { CourtState, Op } from "./types.ts"

export type SlackStatus = "sending" | "sent" | `failed: ${string}`

export interface SlackOptions {
    webhookUrl?: string
    publicUrl: string
    /** "simulation" prefixes every message so a rehearsal is never mistaken for a live event. */
    mode: "live" | "simulation"
    timeoutMs?: number
    attempts?: number
    fetchImpl?: typeof fetch
    onStatus?: (opId: string, status: SlackStatus) => void
}

const host = (v: string) => {
    try {
        return new URL(v).host || v
    } catch {
        return v
    }
}

/** Arguments with anything credential-like shortened: SSH keys, long tokens. */
export function redactArgs(args: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, /key|token|secret|password/i.test(k) || v.length > 80 ? `${v.slice(0, 18)}… (${v.length} chars)` : v])
    )
}

export function slackMessage(op: Op, opts: Pick<SlackOptions, "publicUrl" | "mode">): Record<string, unknown> {
    const args = redactArgs(op.args)
    const origin = op.lineage.externalRelayIds.length ? `External party → Support → ${op.requestedBy}` : `On-call engineer → ${op.requestedBy}`
    const reason = op.reason.replace(/^authorization:\s*/, "").replace(/ Held for the on-call engineer\.?$/, "")
    const link = `${opts.publicUrl.replace(/\/+$/, "")}/?mode=live&view=oncall&op=${encodeURIComponent(op.opId)}`
    const title = `${opts.mode === "simulation" ? "[SIMULATION] " : ""}Doppelgänger Security Review`
    const fields: [string, string][] = [
        ["Status", "Approval required"],
        ["Action", `\`${op.action}\``],
        ["Requesting agent", op.requestedBy],
        ...(args.sink ? ([["Requested destination", `\`${host(args.sink)}\``]] as [string, string][]) : []),
        ["Arguments", Object.entries(args).map(([k, v]) => `${k}=${v}`).join(", ")],
        ["Origin", origin],
        ["Reason", reason],
        ["Case ID", op.caseId ?? "none"],
        ["Decision", "Awaiting authorized human review"]
    ]
    const text = `${title}: ${op.action} by ${op.requestedBy} is held (${reason}). Review: ${link}`
    return {
        text,
        blocks: [
            { type: "header", text: { type: "plain_text", text: title } },
            { type: "section", fields: fields.map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v.slice(0, 900)}` })).slice(0, 10) },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Review action" }, url: link }] },
            { type: "context", elements: [{ type: "mrkdwn", text: "The link carries no credential: sign in with the on-call QR code on your phone first. The Court re-checks every decision." }] }
        ]
    }
}

export function slackNotifier(opts: SlackOptions) {
    const status = new Map<string, SlackStatus>()
    const pending: Promise<void>[] = []
    const enabled = !!opts.webhookUrl
    const doFetch = opts.fetchImpl ?? fetch
    const set = (opId: string, s: SlackStatus) => {
        status.set(opId, s)
        opts.onStatus?.(opId, s)
    }

    const send = async (op: Op) => {
        const body = JSON.stringify(slackMessage(op, opts))
        const attempts = opts.attempts ?? 3
        let last = ""
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await doFetch(opts.webhookUrl as string, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) })
                if (res.ok) return set(op.opId, "sent")
                last = `HTTP ${res.status}`
                if (res.status >= 400 && res.status < 500 && res.status !== 429) break // a bad request will not get better
                const retryAfter = Number(res.headers.get("retry-after") ?? 0)
                await new Promise(r => setTimeout(r, Math.min(5000, retryAfter ? retryAfter * 1000 : 400 * 2 ** i)))
            } catch (e) {
                last = (e as Error)?.name === "TimeoutError" ? "timeout" : "network error"
                await new Promise(r => setTimeout(r, 400 * 2 ** i))
            }
        }
        set(op.opId, `failed: ${last}`)
    }

    return {
        enabled,
        status,
        /** Feed it every Court state; it posts once per newly HELD operation. Never throws, never blocks. */
        observe(state: CourtState): void {
            if (!enabled) return
            for (const op of state.ops) {
                if (op.state !== "HELD" || status.has(op.opId)) continue
                set(op.opId, "sending") // mark first: concurrent observations never double-post
                pending.push(send(op).catch(() => set(op.opId, "failed: unexpected")))
            }
        },
        /** For tests and the integration check: wait for in-flight posts. */
        async flush(): Promise<void> {
            await Promise.all(pending.splice(0))
        }
    }
}
