// A deterministic, whole-graph family layout via constraint-based force
// (stress) layout.
//
// The layered layout (`layout.ts`) reads well for a small, tidy family but
// smears into a diagonal hairball once a family is large and structurally
// diverse, and its one-long-row packing is far too wide for a portrait phone.
// The radial layout (`radial.ts`) fixes the portrait problem but is
// ego-centric — it shows one person's relatives, not the whole graph at once.
//
// This layout shows *everyone* at once and fills a roughly-square viewport with
// no overlap. It uses cola.js (webcola): stress majorization matches on-screen
// distance to graph-theoretic distance (no hairball, space-filling), and a
// downward flow constraint keeps a top-down genealogical feel (parents above
// children) without a rigid grid.
//
// Non-overlap is a hard guarantee, but not straight from cola: webcola's
// avoidOverlaps conflicts with the flow constraints and leaves residual
// overlaps on larger graphs, so instead we let cola position freely (flow only)
// and then run one deterministic VPSC separation pass over the settled result.
// Because the flow spaces successive generations more than a node is tall, the
// only overlaps that ever occur are between same-level people, so separating in
// x among vertically-overlapping pairs removes *every* overlap (a collision
// needs both axes) while leaving the generational y untouched.
//
// Structure — the same trick the radial view uses: instead of a parent→child
// edge per pair, each union (a couple / co-parent-set and their shared children)
// gets a virtual "family node", and edges route parent→family→child. That keeps
// full siblings clustered under one junction and the edge set sparse. A short
// partner link between spouses keeps couples adjacent.
//
// Determinism — cola seeds its descent from a fixed PRNG, we seed each node's
// initial position from a cheap generation estimate, run a fixed number of
// iterations synchronously (no async convergence), and the VPSC pass is exact.
// So the same input yields the same layout on every render — jitter-free and
// testable.

import { Layout, Variable, Constraint, Solver } from 'webcola'

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

// Center-to-center flow gap between successive generations (applied to each of
// the parent→family and family→child links, so a parent sits ~2× this above its
// children — comfortably more than a node is tall, which is what confines every
// overlap to a single level). Ideal link lengths for the stress term; partners
// sit closer.
const GEN_GAP = 76
const STRUCT_LEN = 70
const PARTNER_LEN = NODE_W * 0.75
// Extra horizontal clearance forced between two *person* boxes beyond the bare
// no-overlap gap. The overlap-separation pass only stops boxes from touching;
// this padding gives neighbouring people (and the edges that thread between
// them) real breathing room, so unrelated families don't crowd into one another.
const NODE_SEP_PAD = 28

// Fixed iteration budget — enough for a low-hundreds-person family to settle
// while staying fully deterministic. Phases: unconstrained stress (spread),
// then user (flow) constraints, then all constraints. Non-overlap is handled by
// the VPSC pass afterward, not by cola.
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

  // Directed parent/child adjacency plus undirected partners.
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const partners = new Map<string, string[]>()
  for (const id of nodeIds) {
    parents.set(id, [])
    children.set(id, [])
    partners.set(id, [])
  }
  for (const e of parentEdges) {
    children.get(e.from)!.push(e.to)
    parents.get(e.to)!.push(e.from)
  }
  for (const e of partnerEdges) {
    partners.get(e.from)!.push(e.to)
    partners.get(e.to)!.push(e.from)
  }

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
  // length. They're flagged so the flow constraint doesn't stack spouses
  // vertically (they get a zero downward gap — same level is fine).
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
  // Flow only, no avoidOverlaps: the two conflict in webcola and leave
  // overlaps; we remove overlaps deterministically below instead.
  const layout = new Layout()
    .nodes(colaNodes)
    .links(links)
    // Downward flow: parent above family above child. Partner links get a zero
    // gap so a couple can share a level.
    .flowLayout('y', (l: ColaLink) => (l.partner ? 0 : GEN_GAP))
    .linkDistance((l) =>
      (l as unknown as ColaLink).partner ? PARTNER_LEN : STRUCT_LEN,
    )
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

// Remove every node overlap by separating horizontally, in place. For each pair
// whose boxes overlap vertically we add a VPSC constraint keeping them at least
// half their combined widths apart in x (ordered by their current x, so the
// solver preserves left/right order). VPSC then finds the minimal-displacement
// x for every node satisfying all of them at once — exact and deterministic.
//
// This is a *complete* guarantee: an overlap needs both axes, so once no
// vertically-overlapping pair overlaps in x, nothing overlaps. It leaves y
// untouched, so the generational flow cola settled on is preserved exactly.
function separateOverlaps(nodes: ColaNode[]): void {
  const vars = nodes.map((n) => new Variable(n.x))
  const cs: Constraint[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const yOverlap = (a.height + b.height) / 2 - Math.abs(a.y - b.y)
      if (yOverlap <= 1e-6) continue
      // Beyond bare non-overlap, give two people extra room so families read as
      // distinct clusters; a person↔family-junction pair keeps the tight gap.
      const pad = !a.isFamily && !b.isFamily ? NODE_SEP_PAD : 0
      const gap = (a.width + b.width) / 2 + pad
      if (a.x <= b.x) cs.push(new Constraint(vars[i], vars[j], gap))
      else cs.push(new Constraint(vars[j], vars[i], gap))
    }
  }
  if (cs.length === 0) return
  new Solver(vars, cs).solve()
  vars.forEach((v, i) => (nodes[i].x = v.position()))
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
