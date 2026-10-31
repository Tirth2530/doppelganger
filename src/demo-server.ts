// The multiplayer demo with no keys: the simulation runs here on the laptop, and
// the dashboard and judges' phones connect to it exactly as they would to the
// live runner, through the same authenticated session.
//   bun run build:web && bun run demo      then open http://localhost:3000/?mode=live

import { hub } from "./live.ts"
import { startServer } from "./server.ts"
import { Simulation } from "./sim.ts"

const sim = new Simulation(hub.emit, { seed: 31 })

hub.onCommand(async c => {
    switch (c.kind) {
        case "run":
            if (sim.busy) return
            sim.reset()
            void sim.runBeat(c.beat)
            break
        case "say":
            hub.emit({ type: "narrate", text: "Writing your own message needs live agents: run `bun run live` with an OpenAI key. The simulation plays the six prepared cases." })
            break
        case "revoke":
            sim.revoke()
            break
        case "restore":
            sim.restore()
            break
        case "reset":
            sim.reset()
            break
        case "decide":
            sim.decide(c.opId, c.approve, c.corrected)
            break
    }
})

const { server, session } = startServer()
sim.reset()
// The on-call link carries a credential, so it is never printed: the QR code on the dashboard holds it.
console.log(`Doppelgänger (SIMULATED agents): open http://localhost:${server.port}/?mode=live on this laptop.`)
console.log(`The on-call QR code is on the dashboard (session valid until ${new Date(session.expiresAt).toLocaleTimeString()}).`)
