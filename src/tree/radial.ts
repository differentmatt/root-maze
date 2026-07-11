// A deterministic, ego-centric radial family layout.
//
// The layered whole-tree layout (`layout.ts`) reads well for a small, tidy
// family but smears into a diagonal hairball once a family is large and
// structurally diverse (multiple marriages, step/adopted kids, deep
// generations) — and a top-down row layout wastes a mobile *portrait* viewport,
// which is roughly square. This layout instead centers on one person and fans
// their relatives outward in a circle, which fills a square screen and — because
// each subtree gets a contiguous angular wedge — keeps a crossing-free backbone
// that the layered layout can't guarantee.
//
// Shape:
//   - the focus person sits at the center (ring 0),
//   - ancestors fan outward through the UPPER hemisphere (parents, grandparents…),
//   - descendants fan outward through the LOWER hemisphere (children, grandkids…),
//   - the focus's siblings cluster just above center, spouses just below,
//   - a couple's shared children collapse onto a single "union" junction so the
//     chart draws one stem per family instead of one edge per parent×child.
//
// Everything is seeded from the input order (no randomness) so the layout is
// stable across re-renders and testable.

export type RadialEdgeKind = 'parent_child' | 'partner'

export interface RadialInputEdge {
  from: string
  to: string
  kind: RadialEdgeKind
  subtype?: string
  // Partner edges that have ended (divorce/"ex") render dashed.
  ended?: boolean
}

export interface Point {
  x: number
  y: number
}

export type NodeRole =
  | 'focus'
  | 'ancestor'
  | 'descendant'
  | 'sibling'
  | 'spouse'

export interface RadialNode {
  id: string
  x: number
  y: number
  // Generation distance from the focus: negative = ancestor (up), positive =
  // descendant (down), 0 = the center cluster (focus, siblings, spouses).
  ring: number
  angle: number
  role: NodeRole
  // Half-sibling flag, set only for sibling nodes.
  half?: boolean
}

// A small derived node standing in for a family: a couple (or single parent)
// and their shared children hang off it, so the chart collapses N parent→child
// edges into one stem per family.
export interface UnionJunction {
  id: string
  x: number
  y: number
}

// How an edge should be drawn:
//   - 'radial'    a straight spoke between adjacent rings,
//   - 'unionStem' a stem to/from a union junction (collapsed shared-parent edge),
//   - 'chord'     a curved cross-wedge link (a marriage, or a person reached a
//                 second way) that would otherwise cut across the tree.
export type RadialEdgeStyle = 'radial' | 'unionStem' | 'chord'

export interface RadialEdge {
  id: string
  ax: number
  ay: number
  bx: number
  by: number
  // Present for curved edges (chords, union stems); the renderer draws a
  // quadratic Bézier through it, else a straight line.
  cx?: number
  cy?: number
  style: RadialEdgeStyle
  relation: RadialEdgeKind
  subtype?: string
  ended?: boolean
}

export interface RadialLayout {
  nodes: RadialNode[]
  edges: RadialEdge[]
  junctions: UnionJunction[]
  // Content bounding box, so the canvas can fit the whole chart in view.
  minX: number
  minY: number
  width: number
  height: number
}

// Radial distance between generations.
const RING_GAP = 110
// Fraction of a hemisphere the ancestor / descendant fans span (a sliver is
// left at the horizontal so the two fans read as clearly separate).
const HEMI_SPAN = Math.PI * 0.92
// Where a family's union junction sits between a parent ring and the child ring.
const JUNCTION_FRAC = 0.72
// Where a married-in co-parent sits between their partner and the union — far
// enough out that the focus's spouses don't pile onto the center.
const SPOUSE_FRAC = 0.55
// How far above the focus its siblings sit, and how wide they spread — a
// fraction of a ring so they clear the focus and its label.
const SIBLING_RING = RING_GAP * 0.42
const SIBLING_SPREAD = RING_GAP * 0.62
// Depth cap so a data cycle can't recurse forever (mirrors layout.ts's cap).
const MAX_DEPTH = 40

const EMPTY: RadialLayout = {
  nodes: [],
  edges: [],
  junctions: [],
  minX: 0,
  minY: 0,
  width: 0,
  height: 0,
}

// Screen position for a polar coordinate, centered on the focus at the origin.
// Angle is math-convention (0 = right, π/2 = up); y is flipped for SVG so that
// π/2 points up on screen and 3π/2 points down.
function polar(radius: number, angle: number): Point {
  return { x: radius * Math.cos(angle), y: -radius * Math.sin(angle) }
}

export function computeRadialLayout(
  nodeIds: string[],
  edges: RadialInputEdge[],
  focusId: string,
): RadialLayout {
  if (nodeIds.length === 0 || !nodeIds.includes(focusId)) return EMPTY

  const index = new Map(nodeIds.map((id, i) => [id, i]))
  const byInput = (a: string, b: string) =>
    (index.get(a) ?? 0) - (index.get(b) ?? 0)

  // Keep only edges whose endpoints both exist and aren't self-loops.
  const valid = edges.filter(
    (e) => index.has(e.from) && index.has(e.to) && e.from !== e.to,
  )

  // Directed parent/child adjacency plus undirected partners, each remembering
  // the originating edge so we can style by subtype / ended.
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const partners = new Map<string, string[]>()
  // Edge metadata keyed by "from>to" (parent_child) or unordered pair (partner).
  const pcMeta = new Map<string, RadialInputEdge>()
  const partnerMeta = new Map<string, RadialInputEdge>()
  for (const id of nodeIds) {
    parents.set(id, [])
    children.set(id, [])
    partners.set(id, [])
  }
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  for (const e of valid) {
    if (e.kind === 'parent_child') {
      children.get(e.from)!.push(e.to)
      parents.get(e.to)!.push(e.from)
      pcMeta.set(`${e.from}>${e.to}`, e)
    } else {
      partners.get(e.from)!.push(e.to)
      partners.get(e.to)!.push(e.from)
      partnerMeta.set(pairKey(e.from, e.to), e)
    }
  }
  const sortedParents = (id: string) => [...parents.get(id)!].sort(byInput)
  const sortedChildren = (id: string) => [...children.get(id)!].sort(byInput)
  const sortedPartners = (id: string) => [...partners.get(id)!].sort(byInput)
  const pcSubtype = (from: string, to: string) =>
    pcMeta.get(`${from}>${to}`)?.subtype
  // A parent→child edge is "plain" biological when it has no subtype or the
  // default one; anything else (step/adoptive/foster) is drawn distinctly.
  const isBiological = (from: string, to: string) => {
    const s = pcSubtype(from, to)
    return !s || s === 'biological'
  }

  // Leaf counts drive wedge sizing so a bushy subtree gets a wider arc. Computed
  // on the static graph (independent of placement order) with a path guard so a
  // cycle can't loop; memoized per node for speed.
  const leafMemo = (
    memo: Map<string, number>,
    nextOf: (id: string) => string[],
  ) => {
    const stack = new Set<string>()
    const dfs = (id: string): number => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      const next = nextOf(id).filter((n) => !stack.has(n))
      if (next.length === 0) {
        memo.set(id, 1)
        return 1
      }
      stack.add(id)
      let sum = 0
      for (const n of next) sum += dfs(n)
      stack.delete(id)
      const v = Math.max(1, sum)
      memo.set(id, v)
      return v
    }
    return dfs
  }
  const ancLeaves = leafMemo(new Map(), sortedParents)
  const descLeaves = leafMemo(new Map(), sortedChildren)

  const nodes: RadialNode[] = []
  const edgeList: RadialEdge[] = []
  const junctions: UnionJunction[] = []
  const posOf = new Map<string, Point>()
  const placed = new Set<string>()
  let seq = 0

  const place = (id: string, ring: number, angle: number, role: NodeRole, half?: boolean) => {
    const radius = Math.abs(ring) * RING_GAP
    const p = polar(radius, angle)
    posOf.set(id, p)
    placed.add(id)
    nodes.push({ id, x: p.x, y: p.y, ring, angle, role, half })
    return p
  }
  const placeAt = (id: string, p: Point, ring: number, angle: number, role: NodeRole, half?: boolean) => {
    posOf.set(id, p)
    placed.add(id)
    nodes.push({ id, x: p.x, y: p.y, ring, angle, role, half })
    return p
  }
  const addJunction = (p: Point): UnionJunction => {
    const j: UnionJunction = { id: `union-${seq++}`, x: p.x, y: p.y }
    junctions.push(j)
    return j
  }
  const addEdge = (
    a: Point,
    b: Point,
    style: RadialEdgeStyle,
    relation: RadialEdgeKind,
    opts: { subtype?: string; ended?: boolean; curve?: boolean } = {},
  ) => {
    const e: RadialEdge = {
      id: `re-${seq++}`,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      style,
      relation,
      subtype: opts.subtype,
      ended: opts.ended,
    }
    if (opts.curve || style === 'chord') {
      // Bow the control point out from the segment midpoint so parallel curves
      // (e.g. two edges into a junction) don't overlap and cross-wedge chords
      // read as arcs rather than straight cuts.
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const bow = style === 'chord' ? 0.22 : 0.12
      e.cx = mx + (-dy / len) * len * bow
      e.cy = my + (dx / len) * len * bow
    }
    edgeList.push(e)
  }

  const focusPoint = place(focusId, 0, Math.PI / 2, 'focus')

  // --- Ancestors (upper hemisphere), plus the focus's siblings --------------
  placeAncestors(
    focusId,
    focusPoint,
    0,
    Math.PI / 2 - HEMI_SPAN / 2,
    Math.PI / 2 + HEMI_SPAN / 2,
    true,
  )

  // --- Descendants (lower hemisphere), plus the focus's spouses -------------
  placeDescendants(
    focusId,
    focusPoint,
    0,
    (3 * Math.PI) / 2 - HEMI_SPAN / 2,
    (3 * Math.PI) / 2 + HEMI_SPAN / 2,
  )

  // --- Focus's partners who share no children (pure spouses) ----------------
  // Descendants placed co-parents already; anyone left is a childless partner,
  // flanked just below the focus on the horizontal.
  const loosePartners = sortedPartners(focusId).filter((p) => !placed.has(p))
  loosePartners.forEach((pid, i) => {
    const side = i % 2 === 0 ? 1 : -1
    const step = Math.floor(i / 2) + 1
    // Flank the focus horizontally, nudged just below so it reads as a spouse
    // beside the focus rather than a sibling above it.
    const p = { x: side * step * SIBLING_SPREAD, y: RING_GAP * 0.28 }
    placeAt(pid, p, 0, side > 0 ? 0 : Math.PI, 'spouse')
    const meta = partnerMeta.get(pairKey(focusId, pid))
    addEdge(focusPoint, p, 'chord', 'partner', { ended: meta?.ended })
  })

  return finalize()

  // ------------------------------------------------------------------------

  // Place `childId`'s parents outward into [aStart, aEnd]. When `withSiblings`
  // (the focus only), the focus's siblings hang off the same parent-union so
  // shared-parent edges collapse and siblings sit beside the focus.
  function placeAncestors(
    childId: string,
    childPoint: Point,
    childRing: number,
    aStart: number,
    aEnd: number,
    withSiblings: boolean,
  ) {
    if (childRing <= -MAX_DEPTH) return
    const ps = sortedParents(childId).filter((p) => !placed.has(p))
    const siblings = withSiblings ? focusSiblings() : []
    if (ps.length === 0) {
      // No parents to branch to, but the focus may still have siblings via a
      // parent that's already placed — skip; siblings need a parent-union.
      return
    }

    const parentRing = childRing - 1
    // Collapse to a junction when it saves edges: ≥2 parents, or siblings share
    // it. A lone parent with no siblings is just a straight spoke.
    const useJunction = ps.length >= 2 || siblings.length > 0
    let hub: Point = childPoint
    if (useJunction) {
      const jr = (Math.abs(childRing) + JUNCTION_FRAC) * RING_GAP
      const j = addJunction(polar(jr, (aStart + aEnd) / 2))
      hub = { x: j.x, y: j.y }
      addEdge(hub, childPoint, 'unionStem', 'parent_child')
      // Siblings flank the focus, hanging off the shared parent-union.
      siblings.forEach((s, i) => {
        const side = i % 2 === 0 ? -1 : 1
        const step = Math.floor(i / 2) + 1
        const sp = placeAt(
          s.id,
          { x: side * step * SIBLING_SPREAD, y: -SIBLING_RING },
          0,
          Math.PI / 2,
          'sibling',
          s.half,
        )
        addEdge(hub, sp, 'unionStem', 'parent_child')
      })
    }

    const weights = ps.map((p) => ancLeaves(p))
    const total = weights.reduce((a, b) => a + b, 0) || ps.length
    let cursor = aStart
    ps.forEach((pid, i) => {
      const span = ((aEnd - aStart) * weights[i]) / total
      const mid = cursor + span / 2
      const pp = place(pid, parentRing, mid, 'ancestor')
      const bio = isBiological(pid, childId)
      addEdge(pp, hub, useJunction ? 'unionStem' : 'radial', 'parent_child', {
        subtype: pcSubtype(pid, childId),
        curve: !bio && !useJunction,
      })
      placeAncestors(pid, pp, parentRing, cursor, cursor + span, false)
      cursor += span
    })
  }

  // Place `parentId`'s descendants outward into [aStart, aEnd], grouping
  // children by their other parent so each marriage becomes its own family
  // wedge (remarriage) hanging off one union junction.
  function placeDescendants(
    parentId: string,
    parentPoint: Point,
    parentRing: number,
    aStart: number,
    aEnd: number,
  ) {
    if (parentRing >= MAX_DEPTH) return
    const unions = groupChildren(parentId)
    if (unions.length === 0) return

    const childRing = parentRing + 1
    const weights = unions.map((u) =>
      u.children.reduce((s, c) => s + descLeaves(c), 0),
    )
    const total = weights.reduce((a, b) => a + b, 0) || unions.length
    let cursor = aStart
    unions.forEach((u, ui) => {
      const span = ((aEnd - aStart) * weights[ui]) / total
      const mid = cursor + span / 2

      // Union junction sits between the parent ring and the child ring.
      const jr = (Math.abs(parentRing) + JUNCTION_FRAC) * RING_GAP
      const j = addJunction(polar(jr, mid))
      const hub = { x: j.x, y: j.y }
      addEdge(parentPoint, hub, 'unionStem', 'parent_child')

      // Married-in co-parent(s): between the parent and the union.
      for (const co of u.coParents) {
        if (placed.has(co)) {
          // Already on the chart — link with a chord instead of re-placing.
          const cp = posOf.get(co)!
          addEdge(hub, cp, 'unionStem', 'parent_child')
          continue
        }
        const sr = (Math.abs(parentRing) + SPOUSE_FRAC) * RING_GAP
        const cp = place(co, parentRing, mid, 'spouse')
        // Override radius so the spouse sits inside the junction, not on the
        // parent's ring (which for the focus would collapse to the center).
        const sp = polar(sr, mid)
        cp.x = sp.x
        cp.y = sp.y
        const node = nodes.find((n) => n.id === co)!
        node.x = sp.x
        node.y = sp.y
        posOf.set(co, cp)
        const meta = partnerMeta.get(pairKey(parentId, co))
        addEdge(parentPoint, cp, 'chord', 'partner', { ended: meta?.ended })
        addEdge(cp, hub, 'unionStem', 'parent_child')
      }

      // Children across the union's wedge.
      const kids = u.children
      const kWeights = kids.map((c) => descLeaves(c))
      const kTotal = kWeights.reduce((a, b) => a + b, 0) || kids.length
      let kCursor = cursor
      kids.forEach((cid, ci) => {
        const kSpan = (span * kWeights[ci]) / kTotal
        const kMid = kCursor + kSpan / 2
        if (placed.has(cid)) {
          const cp = posOf.get(cid)!
          addEdge(hub, cp, 'chord', 'parent_child', {
            subtype: pcSubtype(parentId, cid),
          })
          kCursor += kSpan
          return
        }
        const cp = place(cid, childRing, kMid, 'descendant')
        // If any parent in this union relates to the child non-biologically,
        // draw the stem distinctly (dashed/tinted in the renderer).
        const bio =
          isBiological(parentId, cid) &&
          u.coParents.every((co) => isBiological(co, cid))
        addEdge(hub, cp, 'radial', 'parent_child', {
          subtype: bio ? undefined : nonBioSubtype(parentId, u.coParents, cid),
        })
        placeDescendants(cid, cp, childRing, kCursor, kCursor + kSpan)
        kCursor += kSpan
      })
      cursor += span
    })
  }

  // Group `parentId`'s (unplaced) children into unions keyed by their set of
  // other parents, so full siblings share a family wedge and each distinct
  // co-parent set (a remarriage) becomes its own union.
  function groupChildren(parentId: string): {
    coParents: string[]
    children: string[]
  }[] {
    // Keep already-placed children too, so a cross-link (a child reached a
    // second way) can still draw a chord back to where they sit.
    const kids = sortedChildren(parentId)
    const groups = new Map<string, { coParents: string[]; children: string[] }>()
    const order: string[] = []
    for (const c of kids) {
      const co = sortedParents(c).filter((p) => p !== parentId)
      const key = co.slice().sort(byInput).join(',')
      if (!groups.has(key)) {
        groups.set(key, { coParents: co, children: [] })
        order.push(key)
      }
      groups.get(key)!.children.push(c)
    }
    return order.map((k) => groups.get(k)!)
  }

  // A representative non-biological subtype for the stem into a child (used only
  // when at least one parent relates non-biologically).
  function nonBioSubtype(
    parentId: string,
    coParents: string[],
    childId: string,
  ): string | undefined {
    for (const p of [parentId, ...coParents]) {
      const s = pcSubtype(p, childId)
      if (s && s !== 'biological') return s
    }
    return undefined
  }

  // The focus's siblings: anyone sharing ≥1 parent with the focus. Full when the
  // parent sets match exactly, else half. Derived, never stored (mirrors
  // siblings.ts, but keyed off the same adjacency we already built here).
  function focusSiblings(): { id: string; half: boolean }[] {
    const mine = new Set(parents.get(focusId)!)
    if (mine.size === 0) return []
    const out: { id: string; half: boolean }[] = []
    for (const id of nodeIds) {
      if (id === focusId || placed.has(id)) continue
      const theirs = parents.get(id)!
      if (theirs.length === 0) continue
      const shared = theirs.some((p) => mine.has(p))
      if (!shared) continue
      const full =
        theirs.length === mine.size && theirs.every((p) => mine.has(p))
      out.push({ id, half: !full })
    }
    return out.sort((a, b) => byInput(a.id, b.id))
  }

  function finalize(): RadialLayout {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const consider = (x: number, y: number) => {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (const n of nodes) consider(n.x, n.y)
    for (const j of junctions) consider(j.x, j.y)
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }
    return {
      nodes,
      edges: edgeList,
      junctions,
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
    }
  }
}
