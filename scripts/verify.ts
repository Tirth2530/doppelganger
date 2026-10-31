// Model-checks the Court and five broken variants, and writes the report the
// dashboard shows.   bun run verify

import { mkdirSync, writeFileSync } from "node:fs"

import { checkAll, INVARIANTS, SCENARIOS } from "../src/model-check.ts"

const reports = checkAll()
mkdirSync("web/src", { recursive: true })
writeFileSync("web/src/verification.json", JSON.stringify({ generatedAt: new Date().toISOString(), invariants: INVARIANTS, scenarios: SCENARIOS, reports }, null, 2))

let failed = false
for (const r of reports) {
    const broken = r.invariants.filter(i => !i.held).map(i => i.id)
    const status = r.mutant ? (broken.length ? `caught: ${broken.join(", ")}` : "NOT CAUGHT") : broken.length ? `BROKEN: ${broken.join(", ")}` : "all invariants hold"
    if ((r.mutant && !broken.length) || (!r.mutant && broken.length)) failed = true
    console.log(`${r.title.padEnd(38)} ${String(r.states).padStart(8)} states ${String(r.transitions).padStart(10)} transitions ${String(r.ms).padStart(7)} ms   ${status}`)
}
console.log("\nWrote web/src/verification.json")
if (failed) process.exit(1)
