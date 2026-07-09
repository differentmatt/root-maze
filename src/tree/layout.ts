// A tiny deterministic force-directed layout (Fruchterman–Reingold). Family
// graphs are small, so an O(n² · iterations) pass on the client is plenty and
// avoids pulling in a graph library. Seeding positions from the node index
// (no randomness) keeps the layout stable across re-renders and testable.

export interface Point {
  x: number
  y: number
}

export interface LayoutLink {
  from: string
  to: string
}

export function computeLayout(
  nodeIds: string[],
  links: LayoutLink[],
  width: number,
  height: number,
  iterations = 300,
): Record<string, Point> {
  const n = nodeIds.length
  const cx = width / 2
  const cy = height / 2
  if (n === 0) return {}
  if (n === 1) return { [nodeIds[0]]: { x: cx, y: cy } }

  const k = Math.sqrt((width * height) / n) * 0.6
  const pos: Record<string, Point> = {}

  // Seed on a circle, deterministic in node order.
  const radius = Math.min(width, height) * 0.35
  nodeIds.forEach((id, i) => {
    const a = (2 * Math.PI * i) / n
    pos[id] = { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }
  })

  // Only links whose endpoints are both present affect the layout.
  const present = new Set(nodeIds)
  const edges = links.filter((l) => present.has(l.from) && present.has(l.to))

  let temp = width / 8

  for (let iter = 0; iter < iterations; iter++) {
    const disp: Record<string, Point> = {}
    for (const id of nodeIds) disp[id] = { x: 0, y: 0 }

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos[nodeIds[i]]
        const b = pos[nodeIds[j]]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) {
          // Coincident nodes: nudge apart deterministically.
          dx = (i - j) * 0.01
          dy = 0.01
          dist = Math.hypot(dx, dy)
        }
        const force = (k * k) / dist
        const ux = (dx / dist) * force
        const uy = (dy / dist) * force
        disp[nodeIds[i]].x += ux
        disp[nodeIds[i]].y += uy
        disp[nodeIds[j]].x -= ux
        disp[nodeIds[j]].y -= uy
      }
    }

    // Attraction along edges.
    for (const e of edges) {
      const a = pos[e.from]
      const b = pos[e.to]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.hypot(dx, dy)
      if (dist < 0.01) continue
      const force = (dist * dist) / k
      const ux = (dx / dist) * force
      const uy = (dy / dist) * force
      disp[e.from].x -= ux
      disp[e.from].y -= uy
      disp[e.to].x += ux
      disp[e.to].y += uy
    }

    // Weak gravity toward the center so disconnected pieces don't drift off.
    for (const id of nodeIds) {
      disp[id].x += (cx - pos[id].x) * 0.03
      disp[id].y += (cy - pos[id].y) * 0.03
    }

    // Apply, capped by the cooling temperature and clamped to the viewport.
    for (const id of nodeIds) {
      const d = disp[id]
      const len = Math.hypot(d.x, d.y)
      if (len > 0) {
        const step = Math.min(len, temp)
        pos[id].x += (d.x / len) * step
        pos[id].y += (d.y / len) * step
      }
      pos[id].x = Math.max(24, Math.min(width - 24, pos[id].x))
      pos[id].y = Math.max(24, Math.min(height - 24, pos[id].y))
    }

    temp *= 0.97
  }

  return pos
}
