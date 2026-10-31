// Bundles the dashboard into self-contained HTML.   bun run build:web
//   web/dist/index.html     the full page, served by src/server.ts
//   web/dist/artifact.html  the page body, for publishing as a shareable page

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const result = await Bun.build({ entrypoints: ["web/src/app.ts"], target: "browser", minify: true })
if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
}
const js = (await result.outputs[0].text()).replace(/<\/script/gi, "<\\/script")
const css = readFileSync("web/src/styles.css", "utf8")
const body = readFileSync("web/src/body.html", "utf8")
const fonts = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Spectral:ital,wght@0,400;0,500;1,400;1,500&display=swap"

const head = `<title>Doppelgänger</title>
<meta name="description" content="The trust infrastructure for autonomous AI teams: catches authority laundered through trusted agents, with counterfactual twins and a model-checked Court.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>`

// Real-model results, only if a real run produced them (bun run live-eval). Nothing else is ever shown in that panel.
let realEval = ""
if (existsSync("live-eval-results.json")) {
    const data = JSON.parse(readFileSync("live-eval-results.json", "utf8")) as { kind?: string; results?: unknown[] }
    if (data.kind === "real-model" && Array.isArray(data.results) && data.results.length) {
        realEval = `<script type="application/json" id="real-eval-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
        console.log(`Embedding real-model results: ${data.results.length} runs`)
    } else console.log(`live-eval-results.json is "${data.kind}", not a real-model run: not embedded`)
}

mkdirSync("web/dist", { recursive: true })
writeFileSync("web/dist/artifact.html", `${head}\n${body}\n${realEval}\n<script type="module">${js}</script>`)
writeFileSync(
    "web/dist/index.html",
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${head}\n</head>\n<body>\n${body}\n${realEval}\n<script type="module">${js}</script>\n</body>\n</html>`
)
console.log(`Built web/dist/index.html and web/dist/artifact.html (${Math.round(js.length / 1024)} KB of script)`)
