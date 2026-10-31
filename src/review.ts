// The human-review path, shared by the live runner and its tests: an
// authenticated command (already admitted by src/session.ts) becomes a Court
// call. The Court decides; nothing here can approve on its own.
//
// Exactly-once: decide() acts only on a HELD operation and commit() only on an
// APPROVED one, both inside the Court's serialized call, so a repeated,
// retried, or concurrent decision is a no-op, and a commit after a revocation
// is refused by the epoch fence.

import type { LiveCommand } from "./live.ts"
import type { CourtPort } from "./ports.ts"
import type { Op } from "./types.ts"

export async function applyHumanDecision(court: CourtPort, c: Extract<LiveCommand, { kind: "decide" }>, by = "on-call engineer"): Promise<Op> {
    const op = await court.decide(c.opId, c.approve, by, c.corrected)
    return op.state === "APPROVED" ? court.commit(op.opId) : op
}
