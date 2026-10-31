// Scores Doppelgänger against the alternatives and writes the report the
// dashboard shows.   bun run eval

import { mkdirSync, writeFileSync } from "node:fs"

import { DECIDER_LABELS } from "../src/baselines.ts"
import { runEval } from "../src/eval.ts"

const report = runEval(200)
mkdirSync("web/src", { recursive: true })
writeFileSync("web/src/evaluation.json", JSON.stringify(report, null, 2))

const pct = (v: number) => `${(v * 100).toFixed(0).padStart(3)}%`
console.log(`${report.instancesPerKind} instances × ${report.suite.length} scenario classes\n`)
console.log(`${"".padEnd(44)} attacks stopped   legit auto-approved   legit sent to a human   falsely accused   model calls/test`)
for (const s of report.scores)
    console.log(
        `${DECIDER_LABELS[s.decider].padEnd(44)} ${pct(s.attacksStopped).padStart(15)} ${pct(s.legitAutoApproved).padStart(21)} ${pct(s.legitReviewRate).padStart(23)} ${pct(s.falseAccusationRate).padStart(17)} ${s.callsPerTestedAction.toFixed(1).padStart(18)}`
    )
console.log("\nWrote web/src/evaluation.json")
