// A deterministic, whole-graph family layout via constraint-based force
// (stress) layout.
//
// The layered layout (`layout.ts`) reads well for a small, tidy family but
// smears into a diagonal hairball once a family is large and structurally
// diverse, and its one-long-row packing is far too wide for a portrait phone.
// The radial layout (`radial.ts`) fixes the portrait problem but is
// ego-centric — it shows one person's relatives, not the whole graph at once.
//
// This layout shows *everyone* at once and expands the whole family organically
// into open 2D space — filling a roughly-square viewport, fanning branches out in
// every direction, and untangling edges — rather than stacking people into rigid
// generational rows (which forced a large family into one very wide line). It
// uses cola.js (webcola) stress majorization: on-screen distance is matched to
// graph-theoretic distance, which is naturally space-filling and crossing-averse.
//
// Deliberately *no* flow constraint. An earlier version pinned each generation to
// its own horizontal band ("parents above children"); that reads tidily for a
// couple of generations but smears a real family sideways and fights the
// space-filling we want. We keep only a mild top-down *seed* (positions are
// seeded by a cheap generation estimate) so the result still leans roughly
// ancestors-up / descendants-down, but stress is free to reshape it — generations
// are not a priority.
//
// Non-overlap is a hard guarantee applied after stress settles: cola's
// `removeOverlaps` (Dwyer's 2D VPSC) finds the minimal-displacement position for
// every node so no two boxes overlap. Because the spread is 2D (overlaps aren't
// confined to a row), separation must work in both axes — a single-axis push
// won't do.
//
// Structure — the same trick the radial view uses: instead of a parent→child
// edge per pair, each union (a couple / co-parent-set and their shared children)
// gets a virtual "family node", and edges route parent→family→child. That keeps
// full siblings clustered under one junction and the edge set sparse. A short
// partner link keeps each couple adjacent; with people free to spread in 2D
// (rather than crammed onto one row) couples no longer interleave.
//
// Determinism — cola seeds its descent from a fixed PRNG, we seed each node's
// initial position from that generation estimate, run a fixed number of
// iterations synchronously (no async convergence), and the overlap removal is
// exact. So the same input yields the same layout on every render — jitter-free
// and testable.

import { Layout, Rectangle, removeOverlaps } from 'webcola'

export type ForceEdgeKind = 'parent_child' | 'partner'

export interface ForceInputEdge {
  from: string
  to: string
  kind: ForceEdgeKind
  subtype?: string
  // Partner edges that have ended (divorce/"ex") render dashed.
  ended?: boolean
}

export interface Point {
  x: number
  y: number
}

// A virtual junction linking a couple / co-parent-set to their shared children.
// It has no person of its own; it's the hub that parent→family→child edges
// route through. `parents`/`children` let the renderer draw the curved edges
// and the caller reason about the union.
export interface FamilyNode {
  id: string
  x: number
  y: number
  parents: string[]
  children: string[]
}

export interface ForceLayout {
  pos: Record<string, Point>
  familyNodes: FamilyNode[]
  // Content bounding box (including node extents), so the canvas can fit the
  // whole graph in view with the same math as the other layouts.
  minX: number
  minY: number
  width: number
  height: number
}

// Node box sizes fed to the non-overlap separation. A person's box is wide and
// short to reserve room for the label drawn beneath the circle, so separation
// keeps text from colliding, not just the circles. The family junction is a
// small dot.
export const NODE_W = 120
export const NODE_H = 60
export const FAMILY_SIZE = 14

// Vertical gap between successive generations in the initial *seed* only (a
// parent is seeded ~2× this above its children). It gives the stress descent a
// deterministic top-down start; it is not a constraint, so the settled layout may
// depart from it.
const GEN_GAP = 76
// Ideal link lengths for the stress term: parent↔family↔child, and the shorter
// partner link that keeps a couple adjacent.
const STRUCT_LEN = 70
const PARTNER_LEN = NODE_W * 0.75
// Extra clearance kept around each *person* box during overlap removal (each is
// inflated by half of this), beyond the bare no-overlap gap. It gives
// neighbouring people — and the edges that thread between them — real breathing
// room, so unrelated branches don't crowd into one another.
const NODE_SEP_PAD = 28

// Fixed iteration budget — enough for a low-hundreds-person family to settle
// while staying fully deterministic. Phases mirror cola's start() signature
// (unconstrained stress, then user constraints, then all); non-overlap is handled
// by the removeOverlaps pass afterward, not by cola.
const UNCONSTRAINED_ITERS = 30
const USER_ITERS = 40
const ALL_ITERS = 150

const EMPTY: ForceLayout = {
  pos: {},
  familyNodes: [],
  minX: 0,
  minY: 0,
  width: 0,
  height: 0,
}

interface ColaNode {
  id: string
  isFamily: boolean
  x: number
  y: number
  width: number
  height: number
}

interface ColaLink {
  source: number
  target: number
  partner: boolean
}

export function computeForceLayout(
  nodeIds: string[],
  edges: ForceInputEdge[],
): ForceLayout {
  if (nodeIds.length === 0) return EMPTY

  const index = new Map(nodeIds.map((id, i) => [id, i]))
  const byInput = (a: string, b: string) =>
    (index.get(a) ?? 0) - (index.get(b) ?? 0)

  // Keep only edges whose endpoints both exist and aren't self-loops.
  const valid = edges.filter(
    (e) => index.has(e.from) && index.has(e.to) && e.from !== e.to,
  )
  const parentEdges = valid.filter((e) => e.kind === 'parent_child')
  const partnerEdges = valid.filter((e) => e.kind === 'partner')

  // Child → parents adjacency, used to group siblings into family unions.
  const parents = new Map<string, string[]>()
  for (const id of nodeIds) parents.set(id, [])
  for (const e of parentEdges) parents.get(e.to)!.push(e.from)

  // --- Unions → family nodes ----------------------------------------------
  // Group every child by its *set* of parents, so full siblings (same parent
  // set) share one family junction and each distinct co-parent set (a
  // remarriage, an adoption alongside a birth parent) becomes its own union.
  // Deterministic: children keep input order, and a union's slot is fixed by
  // where its first child first appears.
  const unions = deriveUnions(nodeIds, parents, byInput)

  // --- Generation estimate, for a deterministic initial seed ---------------
  // Relax gen[child] >= gen[parent] + 1 and keep partners level, to a fixed
  // point (capped so a data cycle can't loop). Only used to seed positions —
  // cola's constraints, not this, are what finally order the graph.
  const gen = estimateGenerations(nodeIds, parentEdges, partnerEdges)

  // --- Build the cola model ------------------------------------------------
  const colaNodes: ColaNode[] = []
  const nodeIndex = new Map<string, number>()
  // Spread persons horizontally within their generation for a deterministic,
  // symmetry-broken seed (cola then relaxes from here).
  const genOrder = new Map<number, number>()
  for (const id of nodeIds) {
    const g = gen.get(id)!
    const col = genOrder.get(g) ?? 0
    genOrder.set(g, col + 1)
    nodeIndex.set(id, colaNodes.length)
    colaNodes.push({
      id,
      isFamily: false,
      x: col * NODE_W,
      y: g * GEN_GAP * 2,
      width: NODE_W,
      height: NODE_H,
    })
  }
  for (const u of unions) {
    // Seed a family node between its parents and children.
    const px = avg(u.parents.map((p) => colaNodes[nodeIndex.get(p)!].x))
    const py = avg(u.parents.map((p) => colaNodes[nodeIndex.get(p)!].y))
    nodeIndex.set(u.id, colaNodes.length)
    colaNodes.push({
      id: u.id,
      isFamily: true,
      x: px,
      y: py + GEN_GAP,
      width: FAMILY_SIZE,
      height: FAMILY_SIZE,
    })
  }

  const links: ColaLink[] = []
  for (const u of unions) {
    const fi = nodeIndex.get(u.id)!
    for (const p of u.parents) {
      links.push({ source: nodeIndex.get(p)!, target: fi, partner: false })
    }
    for (const c of u.children) {
      links.push({ source: fi, target: nodeIndex.get(c)!, partner: false })
    }
  }
  // Partner links (deduped, unordered) keep spouses adjacent via a short ideal
  // length. The `partner` flag selects that shorter length in linkDistance.
  const seenPair = new Set<string>()
  for (const e of partnerEdges) {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
    if (seenPair.has(key)) continue
    seenPair.add(key)
    links.push({
      source: nodeIndex.get(e.from)!,
      target: nodeIndex.get(e.to)!,
      partner: true,
    })
  }

  // --- Run cola to a fixed, deterministic result ---------------------------
  // Pure stress, no flow: match on-screen distance to graph-theoretic distance
  // so the whole family spreads organically into open 2D space — filling the
  // viewport and untangling edges — instead of stacking into rigid generational
  // rows (which forced a big family into one very wide line). Overlaps are then
  // removed deterministically in both axes below.
  const layout = new Layout()
    .nodes(colaNodes)
    .links(links)
    .linkDistance((l) =>
      (l as unknown as ColaLink).partner ? PARTNER_LEN : STRUCT_LEN,
    )
    .avoidOverlaps(false)
  layout.start(UNCONSTRAINED_ITERS, USER_ITERS, ALL_ITERS, 0, false)

  const settled = layout.nodes() as unknown as ColaNode[]
  separateOverlaps(settled)

  // --- Collect results -----------------------------------------------------
  const pos: Record<string, Point> = {}
  const familyNodes: FamilyNode[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (x: number, y: number, halfW: number, halfH: number) => {
    minX = Math.min(minX, x - halfW)
    minY = Math.min(minY, y - halfH)
    maxX = Math.max(maxX, x + halfW)
    maxY = Math.max(maxY, y + halfH)
  }
  for (let i = 0; i < settled.length; i++) {
    const cn = settled[i]
    const src = colaNodes[i]
    if (src.isFamily) {
      const u = unions.find((uu) => uu.id === src.id)!
      familyNodes.push({
        id: src.id,
        x: cn.x,
        y: cn.y,
        parents: u.parents,
        children: u.children,
      })
      consider(cn.x, cn.y, FAMILY_SIZE / 2, FAMILY_SIZE / 2)
    } else {
      pos[src.id] = { x: cn.x, y: cn.y }
      consider(cn.x, cn.y, NODE_W / 2, NODE_H / 2)
    }
  }
  if (!Number.isFinite(minX)) return EMPTY

  return {
    pos,
    familyNodes,
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

// Remove every node overlap in place, in both axes. cola's `removeOverlaps`
// (Dwyer's 2D VPSC) finds the minimal-displacement position for every node so no
// two boxes overlap — exact and deterministic, and, unlike a single-axis push,
// it works for the organic 2D spread where overlaps aren't confined to a row.
// Person boxes are inflated by half of NODE_SEP_PAD each so neighbours keep real
// breathing room (and their labels don't collide); the small family junctions
// get the bare gap.
function separateOverlaps(nodes: ColaNode[]): void {
  const rects = nodes.map((n) => {
    const pad = n.isFamily ? 0 : NODE_SEP_PAD / 2
    const halfW = n.width / 2 + pad
    const halfH = n.height / 2 + pad
    return new Rectangle(n.x - halfW, n.x + halfW, n.y - halfH, n.y + halfH)
  })
  removeOverlaps(rects)
  nodes.forEach((n, i) => {
    n.x = rects[i].cx()
    n.y = rects[i].cy()
  })
}

interface Union {
  id: string
  parents: string[]
  children: string[]
}

// Group every child by its set of parents. Each distinct parent set with at
// least one child becomes a union (family node). Order is fixed by first
// appearance so the result is deterministic.
function deriveUnions(
  nodeIds: string[],
  parents: Map<string, string[]>,
  byInput: (a: string, b: string) => number,
): Union[] {
  const groups = new Map<string, Union>()
  const order: string[] = []
  for (const id of nodeIds) {
    const ps = parents.get(id)!
    if (ps.length === 0) continue
    const sorted = [...ps].sort(byInput)
    const key = sorted.join(' ')
    if (!groups.has(key)) {
      groups.set(key, {
        id: `FAM#${sorted.join('-')}`,
        parents: sorted,
        children: [],
      })
      order.push(key)
    }
    groups.get(key)!.children.push(id)
  }
  return order.map((k) => groups.get(k)!)
}

// A generation number per person: relax gen[child] >= gen[parent] + 1 with
// partners kept level, to a fixed point. Mirrors layout.ts; used only to seed
// initial positions here.
function estimateGenerations(
  nodeIds: string[],
  parentEdges: ForceInputEdge[],
  partnerEdges: ForceInputEdge[],
): Map<string, number> {
  const gen = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const cap = nodeIds.length + 5
  for (let pass = 0; pass < cap; pass++) {
    let changed = false
    for (const e of parentEdges) {
      if (gen.get(e.to)! < gen.get(e.from)! + 1) {
        gen.set(e.to, gen.get(e.from)! + 1)
        changed = true
      }
    }
    for (const e of partnerEdges) {
      const m = Math.max(gen.get(e.from)!, gen.get(e.to)!)
      if (gen.get(e.from)! !== m) {
        gen.set(e.from, m)
        changed = true
      }
      if (gen.get(e.to)! !== m) {
        gen.set(e.to, m)
        changed = true
      }
    }
    if (!changed) break
  }
  return gen
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, v) => s + v, 0) / xs.length
}
