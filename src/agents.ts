// The one place agents call the model. The live run and the replay both go
// through runAgent, so a twin sees exactly the system prompt, tools and
// settings the agent saw. Plain fetch against OpenAI's Chat Completions API.
//
// Settings come from the environment and are reported with every result, so a
// replay can prove it used the same model and settings as the original run:
//   OPENAI_API_KEY           required
//   OPENAI_MODEL             required (no default: pick a model your key can use)
//   OPENAI_TEMPERATURE       optional; omitted when unset (some models only allow the default)
//   OPENAI_REASONING_EFFORT  optional (low | medium | high) for reasoning models
//   OPENAI_TIMEOUT_MS        optional, default 30000 per call

import type { AgentSpec } from "./scenario.ts"
import type { Args, StepRecord, ToolCall } from "./types.ts"

export type ContextMessage = StepRecord["context"][number]

export interface ModelSettings {
    model: string
    temperature?: number
    reasoningEffort?: string
    timeoutMs: number
}

export interface Usage {
    promptTokens: number
    completionTokens: number
}

export interface AgentResult {
    text: string
    toolCalls: ToolCall[]
    usage?: Usage
    ms?: number
}

export function settingsFromEnv(env: Record<string, string | undefined> = process.env): ModelSettings {
    const model = env.OPENAI_MODEL
    if (!model) throw new Error("OPENAI_MODEL is not set (pick a chat model your OpenAI key can use)")
    const temperature = env.OPENAI_TEMPERATURE !== undefined && env.OPENAI_TEMPERATURE !== "" ? Number(env.OPENAI_TEMPERATURE) : undefined
    return { model, temperature, reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined, timeoutMs: Number(env.OPENAI_TIMEOUT_MS ?? 30_000) }
}

export class ModelError extends Error {}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

export async function runAgent(spec: AgentSpec, context: ContextMessage[], options: { apiKey?: string; settings?: ModelSettings } = {}): Promise<AgentResult> {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new ModelError("OPENAI_API_KEY is not set")
    const s = options.settings ?? settingsFromEnv()
    const body: Record<string, unknown> = {
        model: s.model,
        messages: [{ role: "system", content: spec.system }, ...context.map(m => ({ role: m.role, content: m.content }))]
    }
    if (spec.tools.length) {
        body.tools = spec.tools
        body.tool_choice = "auto"
    }
    if (s.temperature !== undefined) body.temperature = s.temperature
    if (s.reasoningEffort) body.reasoning_effort = s.reasoningEffort

    const t0 = performance.now()
    let lastError = ""
    for (let attempt = 0; attempt < 2; attempt++) {
        let res: Response
        try {
            res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(s.timeoutMs)
            })
        } catch (e) {
            lastError = (e as Error)?.name === "TimeoutError" ? `timed out after ${s.timeoutMs} ms` : String(e)
            continue
        }
        if (!res.ok) {
            lastError = `OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`
            if (RETRYABLE.has(res.status) && attempt === 0) {
                await new Promise(r => setTimeout(r, 800))
                continue
            }
            throw new ModelError(lastError)
        }
        const data = (await res.json()) as {
            choices: { message: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
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
        return {
            text: msg?.content ?? "",
            toolCalls,
            usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
            ms: performance.now() - t0
        }
    }
    throw new ModelError(lastError || "model call failed")
}
