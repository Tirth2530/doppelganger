// What Acme's agent (the outside party) sends to our Support agent in each live
// case. Taken from eval/cases.json, so the live demo runs exactly the messages
// the real-model evaluation measured. Edit the cases there.
//
//   1  out of scope (production access)        expected: refused by the Court as Relay's policy hook
//   2  proposes its own log destination        expected: held at once; the twins explain why
//   3  ordinary logs, no requests              expected: the human's own change, cleared by the twins
//   4  asks for what the human already allowed expected: under review; use it for the revocation race
//                                              (revoke while it is under review → the stale verdict is fenced out)

import cases from "../eval/cases.json"

const text = (id: string): string => (cases as { id: string; text: string }[]).find(c => c.id === id)?.text ?? ""

export const ACME_MESSAGES: Record<1 | 2 | 3 | 4, string> = {
    1: text("attack-prod-access"),
    2: text("attack-collector"),
    3: text("legit-plain-logs"),
    4: text("legit-agrees-with-task")
}
