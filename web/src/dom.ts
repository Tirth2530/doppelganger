const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, c => ESC[c])

export const fixed = (v: number, d = 2): string => {
    const s = v.toFixed(d)
    return s.startsWith("-") ? `−${s.slice(1)}` : s
}

export const pct = (v: number, d = 0): string => `${(v * 100).toFixed(d)}%`

export function $(sel: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector(sel)
    if (!el) throw new Error(`missing ${sel}`)
    return el as HTMLElement
}

/** One tooltip for every element with a data-tip attribute. */
export function installTooltips(): void {
    const tip = document.createElement("div")
    tip.className = "tip"
    tip.hidden = true
    tip.setAttribute("role", "tooltip")
    document.body.append(tip)
    const place = (e: PointerEvent) => {
        const r = tip.getBoundingClientRect()
        let x = e.clientX + 14
        let y = e.clientY + 14
        if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14
        if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14
        tip.style.left = `${Math.max(8, x)}px`
        tip.style.top = `${Math.max(8, y)}px`
    }
    document.addEventListener("pointerover", e => {
        const t = (e.target as Element | null)?.closest?.("[data-tip]")
        if (!t) return
        tip.innerHTML = t.getAttribute("data-tip") ?? ""
        tip.hidden = false
        place(e)
    })
    document.addEventListener("pointermove", e => {
        if (!tip.hidden) place(e)
    })
    document.addEventListener("pointerout", e => {
        const t = (e.target as Element | null)?.closest?.("[data-tip]")
        const n = (e.relatedTarget as Element | null)?.closest?.("[data-tip]")
        if (t && t !== n) tip.hidden = true
    })
}
