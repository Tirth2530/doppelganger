// The one place agents call the model. The live run and the replay engine both
// go through runAgent, so a twin sees exactly the system prompt, tools and
// settings the agent saw. Plain fetch against OpenAI's Chat Completions API.

import type { AgentSpec } from "./scenario.ts"
import type { Args, StepRecord, ToolCall } from "./types.ts"

export type ContextMessage = StepRecord["context"][number]

export interface AgentResult {
    text: string
    toolCalls: ToolCall[]
}

export async function runAgent(spec: AgentSpec, context: ContextMessage[], options: { apiKey?: string; model?: string } = {}): Promise<AgentResult> {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    const model = options.model ?? process.env.OPENAI_MODEL
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set")
    if (!model) throw new Error("OPENAI_MODEL is not set (pick a chat model your OpenAI key can use)")
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [{ role: "system", content: spec.system }, ...context.map(m => ({ role: m.role, content: m.content }))],
            tools: spec.tools,
            tool_choice: "auto"
        })
    })
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[] }
    const msg = data.choices[0]?.message
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map(t => {
        let args: Args = {}
        try {
            const parsed = JSON.parse(t.function.arguments) as Record<string, unknown>
            args = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
        } catch {
            args = {}
        }
        return { name: t.function.name, args }
    })
    return { text: msg?.content ?? "", toolCalls }
}
