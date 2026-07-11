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

// How an edge should be drawn:
//   - 'radial'    a straight spoke between adjacent rings,
//   - 'unionStem' a light stem tying a sibling to the focus,
//   - 'chord'     a curved link (e.g. a childless partner beside the focus).
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

// A person drawn as a filled arc segment (a fan-chart wedge) rather than a node:
// adjacency is implied by nesting, so both fans are dense and crossing-free.
// Angles are math-convention (0 = right, π/2 = up); the renderer flips y so
// ancestors sweep the upper half and descendants the lower half.
//   - kind 'ancestor'   — a parent/grandparent, colored by ancestral branch.
//   - kind 'descendant' — a child/grandchild, colored by descent line.
//   - kind 'spouse'     — a thin band at the base of a union's children naming
//                         the married-in co-parent (which a fan can't nest).
// `lineage` groups a wedge into a branch for coloring; `subtype` is the
// parent→child relationship (a step/adoptive link is styled distinctly);
// `ended` marks a spouse band whose marriage has ended.
export type WedgeKind = 'ancestor' | 'descendant' | 'spouse'

export interface Wedge {
  id: string
  kind: WedgeKind
  r0: number
  r1: number
  a0: number
  a1: number
  ring: number
  lineage?: number
  subtype?: string
  ended?: boolean
}

export interface RadialLayout {
  nodes: RadialNode[]
  edges: RadialEdge[]
  wedges: Wedge[]
  // Content bounding box, so the canvas can fit the whole chart in view.
  minX: number
  minY: number
  width: number
  height: number
}

// Spacing for the sibling nodes flanking the center (the one non-wedge element).
const RING_GAP = 110
const SIBLING_SPREAD = RING_GAP * 0.62

// Wedge geometry. The focus is a disc of radius CENTER_R; each generation is a
// ring of thickness *_BAND outward from it — ancestors across the upper half,
// descendants across the lower half, each leaving a gap at the horizontal so the
// two fans read as distinct and the siblings have room between them.
const CENTER_R = 30
const ANC_BAND = 52
const DESC_BAND = 52
// Gaps at the horizontal keep the two fans distinct and leave a clear channel
// on the left and right for the focus's siblings and childless partners.
const ANC_A0 = Math.PI * 0.1
const ANC_A1 = Math.PI * 0.9
const DESC_A0 = Math.PI * 1.1
const DESC_A1 = Math.PI * 1.9
// Thickness of the spouse band drawn at the inner edge of a union's children.
const SPOUSE_BAND = 13
// Fan depth cap (generations drawn as wedges, either direction).
const MAX_RING = 8

const EMPTY: RadialLayout = {
  nodes: [],
  edges: [],
  wedges: [],
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
  const descLeaves = leafMemo(new Map(), sortedChildren)

  const nodes: RadialNode[] = []
  const edgeList: RadialEdge[] = []
  const wedges: Wedge[] = []
  const posOf = new Map<string, Point>()
  const placed = new Set<string>()
  let seq = 0
  let lineageSeq = 0

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

  // --- Ancestors above, descendants below, both as nested wedge fans --------
  wedgeAncestors(focusId, 1, ANC_A0, ANC_A1, -1)
  wedgeDescendants(focusId, 1, DESC_A0, DESC_A1, -1)

  // --- The focus's siblings + childless partners: nodes in the clear
  // horizontal channel between the two fans, tied to the focus by a light stem.
  placeFlankers()

  return finalize()

  // ------------------------------------------------------------------------

  // Draw `childId`'s parents as nested wedges filling the arc [a0, a1] one ring
  // out, recursing outward. A person with >2 parents just subdivides their arc
  // among all of them (the fan goes locally non-binary — honest for adoption /
  // multiple parents). `lineage` colors a whole ancestral branch: a fresh id is
  // minted for each parent and grandparent (giving the classic up-to-four-color
  // fan), and inherited further out.
  function wedgeAncestors(
    childId: string,
    ring: number,
    a0: number,
    a1: number,
    lineage: number,
  ) {
    if (ring > MAX_RING) return
    const ps = sortedParents(childId).filter((p) => !placed.has(p))
    if (ps.length === 0) return

    const r0 = CENTER_R + (ring - 1) * ANC_BAND
    const r1 = CENTER_R + ring * ANC_BAND
    // Split the arc equally among parents — the classic symmetric fan, where
    // every ancestor slot is the same width regardless of how much of its branch
    // is known (unknown branches simply leave their outer wedge empty). With >2
    // parents the arc just divides into that many equal slices.
    const span = (a1 - a0) / ps.length
    let cursor = a0
    ps.forEach((pid) => {
      const start = cursor
      const end = cursor + span
      // Fresh lineage color per parent (ring 1) and per grandparent (ring 2);
      // deeper ancestors inherit their grandparent's color.
      const lin = ring <= 2 ? lineageSeq++ : lineage
      placed.add(pid)
      wedges.push({
        id: pid,
        kind: 'ancestor',
        r0,
        r1,
        a0: start,
        a1: end,
        ring,
        lineage: lin,
        subtype: pcSubtype(pid, childId),
      })
      wedgeAncestors(pid, ring + 1, start, end, lin)
      cursor = end
    })
  }

  // The focus's siblings (sharing the parents in the fan above) and any
  // childless partners have no wedge — a sibling isn't a descendant and a
  // childless partner has no children to nest under. Place them as nodes in the
  // clear horizontal channel between the two fans, alternating left/right, tied
  // to the focus by a light stem. Half-siblings are flagged for the renderer.
  function placeFlankers() {
    const sibs = focusSiblings().map((s) => ({
      id: s.id,
      role: 'sibling' as const,
      half: s.half,
      ended: undefined as boolean | undefined,
    }))
    const loose = sortedPartners(focusId)
      .filter((p) => !placed.has(p))
      .map((p) => ({
        id: p,
        role: 'spouse' as const,
        half: false,
        ended: partnerMeta.get(pairKey(focusId, p))?.ended,
      }))
    ;[...sibs, ...loose].forEach((f, i) => {
      const side = i % 2 === 0 ? -1 : 1
      const col = Math.floor(i / 2)
      const sp = placeAt(
        f.id,
        { x: side * (CENTER_R + 28 + col * SIBLING_SPREAD), y: 0 },
        0,
        side < 0 ? Math.PI : 0,
        f.role,
        f.half,
      )
      if (f.role === 'spouse') {
        addEdge(focusPoint, sp, 'chord', 'partner', { ended: f.ended })
      } else {
        addEdge(focusPoint, sp, 'unionStem', 'parent_child')
      }
    })
  }

  // Draw `parentId`'s descendants as nested wedges filling [a0, a1] one ring out.
  // Children are grouped into unions (by their set of other parents), so each
  // marriage occupies a contiguous block; the married-in co-parent — who isn't a
  // blood descendant and so has no wedge of their own — is drawn as a thin
  // "spouse band" at the inner edge of that block. Wedge widths are weighted by
  // descendant-count so a bushy line gets more arc. `lineage` colors a descent
  // line: a fresh id per top-level child, inherited further out.
  function wedgeDescendants(
    parentId: string,
    ring: number,
    a0: number,
    a1: number,
    lineage: number,
  ) {
    if (ring > MAX_RING) return
    const unions = groupChildren(parentId)
      .map((u) => ({ ...u, children: u.children.filter((c) => !placed.has(c)) }))
      .filter((u) => u.children.length > 0)
    if (unions.length === 0) return

    const r0 = CENTER_R + (ring - 1) * DESC_BAND
    const r1 = CENTER_R + ring * DESC_BAND
    const weightOf = (ids: string[]) =>
      ids.reduce((s, c) => s + descLeaves(c), 0)
    const total = weightOf(unions.flatMap((u) => u.children)) || 1
    let cursor = a0
    for (const u of unions) {
      const uSpan = ((a1 - a0) * weightOf(u.children)) / total

      // Spouse band: name the married-in co-parent(s) at the base of the block.
      for (const co of u.coParents) {
        if (placed.has(co)) continue
        placed.add(co)
        const meta = partnerMeta.get(pairKey(parentId, co))
        wedges.push({
          id: co,
          kind: 'spouse',
          r0,
          r1: r0 + SPOUSE_BAND,
          a0: cursor,
          a1: cursor + uSpan,
          ring,
          ended: meta?.ended,
        })
      }
      const bandInset = u.coParents.length > 0 ? SPOUSE_BAND + 2 : 0

      // Children across the union's block, weighted by their own descent size.
      const kids = u.children
      const kTotal = weightOf(kids) || kids.length
      let kCursor = cursor
      kids.forEach((cid) => {
        const kSpan = (uSpan * descLeaves(cid)) / kTotal
        const lin = ring === 1 ? lineageSeq++ : lineage
        placed.add(cid)
        const bio =
          isBiological(parentId, cid) &&
          u.coParents.every((co) => isBiological(co, cid))
        wedges.push({
          id: cid,
          kind: 'descendant',
          r0: r0 + bandInset,
          r1,
          a0: kCursor,
          a1: kCursor + kSpan,
          ring,
          lineage: lin,
          subtype: bio ? undefined : nonBioSubtype(parentId, u.coParents, cid),
        })
        wedgeDescendants(cid, ring + 1, kCursor, kCursor + kSpan, lin)
        kCursor += kSpan
      })
      cursor += uSpan
    }
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
    // A wedge's extent is its outer arc, which can bulge past its corners where
    // it crosses an axis — sample the corners plus any axis angle inside [a0,a1].
    for (const w of wedges) {
      const angles = [w.a0, w.a1]
      for (const ax of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        if (ax >= w.a0 && ax <= w.a1) angles.push(ax)
      }
      for (const a of angles) {
        const p = polar(w.r1, a)
        consider(p.x, p.y)
      }
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }
    return {
      nodes,
      edges: edgeList,
      wedges,
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
    }
  }
}
