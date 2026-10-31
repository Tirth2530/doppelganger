// The Durable Actors.
//
// Court     holds the protected resource and the authorization epoch. One Court
//           per service. Its methods are short and never interleave (no
//           @Interleave anywhere): the model checker shows that an
//           interleavable verdict lets a revocation slip between "check" and
//           "write". The actor runtime's one-call-at-a-time execution is the
//           safety property, not a convenience.
// Lineage   every Relay message of a run and what it was produced from.
// AgentLog  one per agent per run: the exact context of every model call, in
//           order, in SQLite, so any step can be replayed.
//
// The Court's and Lineage's fields are @Emittable: a browser connected to the
// actor gets every change in real time, which is what the dashboard draws.

import { Actor, type ActorContext, type ActorSocket, Emittable, Persisted } from "durable-actors"

import * as court from "./court-logic.ts"
import type { Authorization, ActionName, Args, CourtState, Evidence, MessageRecord, Op, Scope, ScopeDecision, ServiceConfig, StepRecord, SubmitInput } from "./types.ts"

type Viewer = { name: string }
type Incoming = { type: "ping" }
type Outgoing = { type: "pong" }

const now = () => new Date().toISOString()

// Plain functions, not methods: the actor runtime requires every method on an actor class to be async
// (it exposes them all), so these helpers live outside the class.
function snapshotOf(c: Court): CourtState {
    return { epoch: c.epoch, scopes: c.scopes, config: c.config, ops: c.ops, authorizations: c.authorizations ?? [] }
}

/** Reassigns every field so @Persisted saves it and @Emittable streams it. */
function adoptInto(c: Court, s: CourtState): void {
    c.epoch = s.epoch
    c.scopes = s.scopes
    c.config = s.config
    c.ops = s.ops
    c.authorizations = s.authorizations ?? []
}

export class Court extends Actor<Viewer, Incoming, Outgoing> {
    @Persisted @Emittable epoch = 1
    @Persisted @Emittable scopes: Scope[] = court.DEFAULT_SCOPES.map(s => ({ ...s }))
    @Persisted @Emittable config: ServiceConfig = { ...court.DEFAULT_CONFIG, prodAccessKeys: [] }
    @Persisted @Emittable ops: Op[] = []
    @Persisted @Emittable authorizations: Authorization[] = []

    async authorize(a: Omit<Authorization, "epoch" | "createdAt">): Promise<CourtState> {
        adoptInto(this, court.authorize(snapshotOf(this), a, now()))
        return snapshotOf(this)
    }

    async getState(): Promise<CourtState> {
        return snapshotOf(this)
    }

    async checkScope(agent: string, action: ActionName, args: Args): Promise<ScopeDecision> {
        return court.checkScope(snapshotOf(this), agent, action, args)
    }

    async recordDenied(input: SubmitInput, reason: string): Promise<Op> {
        const t = court.recordDenied(snapshotOf(this), input, reason, now())
        adoptInto(this, t.state)
        return t.op
    }

    async submit(input: SubmitInput): Promise<Op> {
        const t = court.submit(snapshotOf(this), input, now())
        adoptInto(this, t.state)
        return t.op
    }

    async verdict(opId: string, evidence: Evidence, epoch: number): Promise<Op> {
        const t = court.verdict(snapshotOf(this), opId, evidence, epoch, now())
        adoptInto(this, t.state)
        return t.op
    }

    /** Explanatory evidence for an operation no longer under review. Never changes its state. */
    async explain(opId: string, evidence: Evidence): Promise<Op> {
        const t = court.explain(snapshotOf(this), opId, evidence)
        adoptInto(this, t.state)
        return t.op
    }

    async decide(opId: string, approve: boolean, by: string, corrected: Args | null): Promise<Op> {
        const t = court.decide(snapshotOf(this), opId, approve, by, corrected, now())
        adoptInto(this, t.state)
        return t.op
    }

    async commit(opId: string): Promise<Op> {
        const t = court.commit(snapshotOf(this), opId, now())
        adoptInto(this, t.state)
        return t.op
    }

    async revoke(agent: string): Promise<number> {
        adoptInto(this, court.revoke(snapshotOf(this), agent))
        return this.epoch
    }

    async restoreScopes(): Promise<number> {
        adoptInto(this, court.restoreScopes(snapshotOf(this)))
        return this.epoch
    }

    async reset(): Promise<CourtState> {
        adoptInto(this, { ...court.initialState(), epoch: this.epoch + 1 })
        return snapshotOf(this)
    }

    async onConnect(socket: ActorSocket<Viewer, Outgoing>): Promise<void> {
        void socket // state arrives through @Emittable; nothing to send by hand
    }
}

export class Lineage extends Actor<Viewer, Incoming, Outgoing> {
    @Persisted @Emittable messages: MessageRecord[] = []

    async record(message: MessageRecord): Promise<MessageRecord> {
        const existing = this.messages.find(m => m.relayId === message.relayId)
        if (existing) return existing // idempotent: Relay may redeliver
        this.messages = [...this.messages, message]
        return message
    }

    async get(relayId: string): Promise<MessageRecord | null> {
        return this.messages.find(m => m.relayId === relayId) ?? null
    }

    async all(): Promise<MessageRecord[]> {
        return this.messages
    }

    async onConnect(socket: ActorSocket<Viewer, Outgoing>): Promise<void> {
        void socket
    }
}

export class AgentLog extends Actor {
    constructor(context: ActorContext) {
        super(context)
        this.db.exec("CREATE TABLE IF NOT EXISTS steps (step INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)")
    }

    async append(step: Omit<StepRecord, "step" | "sentRelayIds">): Promise<number> {
        this.db.exec("INSERT INTO steps (record) VALUES (?)", JSON.stringify({ ...step, sentRelayIds: [] }))
        const [row] = this.db.exec<{ step: number }>("SELECT max(step) AS step FROM steps")
        return row.step
    }

    async attachSent(step: number, relayId: string): Promise<void> {
        const [row] = this.db.exec<{ record: string }>("SELECT record FROM steps WHERE step = ?", step)
        if (!row) return
        const record = JSON.parse(row.record) as Omit<StepRecord, "step">
        this.db.exec("UPDATE steps SET record = ? WHERE step = ?", JSON.stringify({ ...record, sentRelayIds: [...record.sentRelayIds, relayId] }), step)
    }

    async steps(): Promise<StepRecord[]> {
        return this.db.exec<{ step: number; record: string }>("SELECT step, record FROM steps ORDER BY step").map(r => ({ ...(JSON.parse(r.record) as Omit<StepRecord, "step">), step: r.step }))
    }
}
