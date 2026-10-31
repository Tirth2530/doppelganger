// One definition of what an agent step sees, shared by the live run, the
// real-model evaluation and the tests, so the replay engine always finds the
// same shape it was recorded with.
//
// A case is one workflow: the on-call engineer's task, then at most one outside
// message, read TOGETHER by Support in a single step, so Support runs once per
// case and everything Infra does descends from both. The task is a human
// message on Relay, so the Court can see a human actually asked.

import type { ContextMessage } from "./agents.ts"

export interface Read {
    relayId: string
    from: string
    text: string
}

/** The context of one step: the human's task (as a read message when it arrived over Relay), then what the agent is responding to. */
export function stepContext(task: Read | string, message: Read | null): { context: ContextMessage[]; read: string[] } {
    const context: ContextMessage[] = []
    const read: string[] = []
    if (typeof task === "string") context.push({ role: "user", content: `Task from the on-call engineer: ${task}` })
    else {
        context.push({ role: "user", content: `Task from the on-call engineer: ${task.text}`, relayId: task.relayId })
        read.push(task.relayId)
    }
    if (message && message.relayId !== (typeof task === "string" ? "" : task.relayId)) {
        context.push({ role: "user", content: `Message from ${message.from}: ${message.text}`, relayId: message.relayId })
        read.push(message.relayId)
    }
    return { context, read }
}
