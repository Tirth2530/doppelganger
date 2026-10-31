// A fake Agent Relay that keeps the real SDK's semantics: the policy runs before
// the handler (after `availableTo`, as the SDK facade does), a refusal emits `action.denied` and never reaches the handler,
// facade handlers take one `{ input, agent, ctx }` object, typed predicates
// subscribe through `subscribe(context, handler)`, and message events carry
// the SDK's `RelayMessage` shape (discriminated `target`).

type Caller = { name: string; id?: string; type?: "agent" | "human" | "system" }
type Ctx = { caller: Caller }
type Decision = { allowed: boolean; reason?: string }

interface Def {
    name: string
    availableTo?: string[]
    policy?: (input: unknown, ctx: Ctx) => Decision | Promise<Decision>
    handler: (args: { input: unknown; agent: Caller; ctx: Ctx }) => unknown
}

interface ActionEvent {
    type: "action.invoked" | "action.completed" | "action.failed" | "action.denied"
    action: string
    caller: Caller
    input?: unknown
    output?: unknown
    reason?: string
    at: string
}

type Predicate = { subscribe(context: { onActionEvent(h: (e: ActionEvent) => void): () => void }, handler: (e: unknown) => void): () => void }

export class FakeRelay {
    private defs = new Map<string, Def>()
    private actionListeners = new Set<(e: ActionEvent) => void>()
    private messageListeners = new Set<(e: unknown) => Promise<void> | void>()
    private counter = 0

    registerAction(def: Def) {
        this.defs.set(def.name, def)
        const name = def.name
        const phase = (type: ActionEvent["type"]): Predicate => ({
            subscribe: (context, handler) =>
                context.onActionEvent(e => {
                    if (e.action === name && e.type === type) handler({ type: e.type, action: e.action, agent: e.caller, input: e.input, output: e.output, reason: e.reason, at: e.at })
                })
        })
        return { name, unregister: () => this.defs.delete(name), invoked: () => phase("action.invoked"), completed: () => phase("action.completed"), failed: () => phase("action.failed"), denied: () => phase("action.denied") }
    }

    addListener(selector: string | Predicate, handler: (e: never) => unknown): () => void {
        const h = handler as (e: unknown) => Promise<void> | void
        if (typeof selector === "string") {
            this.messageListeners.add(h)
            return () => this.messageListeners.delete(h)
        }
        return selector.subscribe({ onActionEvent: l => (this.actionListeners.add(l), () => this.actionListeners.delete(l)) }, h)
    }

    /** What another agent's `capabilities.invoke` amounts to once Relay routes it to the Court agent. */
    async invoke(name: string, input: unknown, caller: Caller): Promise<{ ok: boolean; output?: unknown; error?: { code: string; message: string } }> {
        const def = this.defs.get(name)
        if (!def) return { ok: false, error: { code: "not_found", message: name } }
        const at = new Date(Date.now() + this.counter++).toISOString()
        const fire = (e: ActionEvent) => this.actionListeners.forEach(l => l(e))
        // As facade.ts registerFacadeAction: availableTo is checked first, then the policy.
        const policy = async (): Promise<Decision> => {
            if (def.availableTo && !def.availableTo.includes(caller.name)) return { allowed: false, reason: `${caller.name} is not permitted to call ${name}.` }
            return def.policy ? def.policy(input, { caller }) : { allowed: true }
        }
        if (def.policy || def.availableTo) {
            const d = await policy()
            if (!d.allowed) {
                fire({ type: "action.denied", action: name, caller, input, reason: d.reason, at })
                await new Promise(r => setTimeout(r, 0))
                return { ok: false, error: { code: "denied", message: d.reason ?? "denied" } }
            }
        }
        fire({ type: "action.invoked", action: name, caller, input, at })
        const output = await def.handler({ input, agent: caller, ctx: { caller } })
        fire({ type: "action.completed", action: name, caller, input, output, at })
        return { ok: true, output }
    }

    /** What the workspace does when an agent sends a message. */
    async deliver(from: string, to: string, text: string, metadata: Record<string, unknown> = {}): Promise<string> {
        const id = `m-${++this.counter}`
        const message = { id, messageId: id, text, from: { name: from }, target: { kind: "agent", agentName: to }, createdAt: new Date().toISOString(), metadata }
        for (const l of this.messageListeners) await l({ type: "message.created", message, envelope: {} })
        return id
    }
}
