// A deterministic, layered family-tree layout.
//
// Force-directed layouts read as a hairball once a family has more than a
// dozen people, and — because nodes only repel — they can never *guarantee*
// two people won't land on top of each other. A family graph, though, has a
// natural structure we can exploit: parent→child edges define generations. So
// we place people in horizontal rows by generation and space them out within
// each row, which gives a hard "no two people overlap" guarantee and reads the
// way a family tree is expected to read.
//
// The pipeline is a small Sugiyama-style layered layout:
//   1. split the graph into connected components (unrelated families),
//   2. assign each person a generation (row) from the parent→child edges,
//   3. order people within each row to reduce edge crossings (barycenter),
//   4. assign x-coordinates, pulling people toward their relatives while
//      enforcing a minimum gap so nobody overlaps,
//   5. pack the components side by side.
//
// Everything is seeded from the input order (no randomness) so the layout is
// stable across re-renders and testable.

export interface Point {
  x: number
  y: number
}

export type LayoutEdgeKind = 'parent_child' | 'partner'

export interface LayoutEdge {
  from: string
  to: string
  kind: LayoutEdgeKind
}

export interface LayoutResult {
  pos: Record<string, Point>
  // The content's bounding box, so the canvas can fit the whole tree in view.
  width: number
  height: number
}

// Center-to-center spacing. COL_GAP leaves room for a node's label without it
// colliding with a neighbor's; ROW_GAP leaves room for the label below a node.
const COL_GAP = 120
const ROW_GAP = 150
// Horizontal breathing room between unrelated families. Kept a bit wider than a
// within-row column gap so separate families read as clearly distinct clusters.
const COMPONENT_GAP = 160
const MARGIN = 60
// How hard people are pulled toward the average position of their relatives
// each pass; the rest is the leftover of the previous position (damping).
const PULL = 0.6
const RELAX_PASSES = 60

export function computeLayout(
  nodeIds: string[],
  edges: LayoutEdge[],
): LayoutResult {
  if (nodeIds.length === 0) return { pos: {}, width: 0, height: 0 }

  const index = new Map(nodeIds.map((id, i) => [id, i]))
  // Stable, deterministic ordering helper (falls back to id for safety).
  const byInput = (a: string, b: string) =>
    (index.get(a) ?? 0) - (index.get(b) ?? 0)

  // Keep only edges whose endpoints both exist and aren't self-loops.
  const valid = edges.filter(
    (e) => index.has(e.from) && index.has(e.to) && e.from !== e.to,
  )
  const parentEdges = valid.filter((e) => e.kind === 'parent_child')
  const partnerEdges = valid.filter((e) => e.kind === 'partner')

  // Adjacency. `parents`/`children` are directed; `partners` is undirected.
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

  // --- 1. Connected components (both edge kinds connect people) ------------
  const comp = componentsOf(nodeIds, valid)

  // --- 2. Generation (row) per person -------------------------------------
  // Relax gen[child] >= gen[parent] + 1 and keep partners on the same row,
  // iterating to a fixed point. Capped so a data cycle can't loop forever.
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

  // Group people by component, then by row within the component. Each
  // component is normalized so its shallowest generation sits at row 0.
  const compIds = [...new Set(comp.values())]
  const members = new Map<number, string[]>()
  for (const id of nodeIds) {
    const c = comp.get(id)!
    if (!members.has(c)) members.set(c, [])
    members.get(c)!.push(id)
  }

  const pos: Record<string, Point> = {}
  // Lay out components largest-first for a stable, tidy left-to-right packing.
  const orderedComps = compIds.sort((a, b) => {
    const sa = members.get(a)!.length
    const sb = members.get(b)!.length
    if (sa !== sb) return sb - sa
    return byInput(members.get(a)![0], members.get(b)![0])
  })

  let offsetX = 0
  for (const c of orderedComps) {
    const ids = members.get(c)!
    const minGen = Math.min(...ids.map((id) => gen.get(id)!))
    const rows = new Map<number, string[]>()
    for (const id of ids) {
      const r = gen.get(id)! - minGen
      if (!rows.has(r)) rows.set(r, [])
      rows.get(r)!.push(id)
    }

    // --- 3. Order within each row to reduce crossings --------------------
    orderRows(rows, parents, children, partners, byInput)

    // --- 4. X-coordinates: pull toward relatives, keep a minimum gap ------
    const x = assignX(rows, parents, children, partners)

    // Shift this component to sit just right of the previous one.
    let minX = Infinity
    let maxX = -Infinity
    for (const id of ids) {
      minX = Math.min(minX, x.get(id)!)
      maxX = Math.max(maxX, x.get(id)!)
    }
    const shift = offsetX - minX
    for (const id of ids) {
      pos[id] = { x: x.get(id)! + shift, y: (gen.get(id)! - minGen) * ROW_GAP }
    }
    offsetX += maxX - minX + COMPONENT_GAP
  }

  // --- 5. Normalize to a padded bounding box ------------------------------
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of nodeIds) {
    minX = Math.min(minX, pos[id].x)
    minY = Math.min(minY, pos[id].y)
    maxX = Math.max(maxX, pos[id].x)
    maxY = Math.max(maxY, pos[id].y)
  }
  for (const id of nodeIds) {
    pos[id].x += MARGIN - minX
    pos[id].y += MARGIN - minY
  }

  return {
    pos,
    width: maxX - minX + 2 * MARGIN,
    height: maxY - minY + 2 * MARGIN,
  }
}

// The set of people within `depth` relationship-hops of `focusId` — the focus
// person plus their partners, parents, children, and outward from there. Used
// by the focus/ego view to show one person's local family instead of the whole
// tree, which is what keeps a hundred-plus-person graph readable on a phone.
// Falls back to every node when the focus person isn't present.
export function neighborhood(
  nodeIds: string[],
  edges: LayoutEdge[],
  focusId: string,
  depth: number,
): Set<string> {
  const all = new Set(nodeIds)
  if (!all.has(focusId)) return all

  const adj = new Map<string, string[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to) && e.from !== e.to) {
      adj.get(e.from)!.push(e.to)
      adj.get(e.to)!.push(e.from)
    }
  }

  const seen = new Set<string>([focusId])
  let frontier = [focusId]
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id)!) {
        if (!seen.has(nb)) {
          seen.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  return seen
}

// Union-find over both edge kinds, returning a component id per node.
function componentsOf(
  nodeIds: string[],
  edges: LayoutEdge[],
): Map<string, number> {
  const parent = new Map<string, string>(nodeIds.map((id) => [id, id]))
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    // Path compression.
    let cur = a
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!
      parent.set(cur, r)
      cur = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of edges) union(e.from, e.to)

  const label = new Map<string, number>()
  let next = 0
  const comp = new Map<string, number>()
  for (const id of nodeIds) {
    const root = find(id)
    if (!label.has(root)) label.set(root, next++)
    comp.set(id, label.get(root)!)
  }
  return comp
}

// Reorder people within each row so relatives line up above/below each other.
// A few barycenter sweeps: each pass, sort a row by the average slot-position
// of each person's neighbors (parents, children, partners), which pulls
// connected people into vertical alignment and cuts edge crossings.
function orderRows(
  rows: Map<number, string[]>,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  partners: Map<string, string[]>,
  byInput: (a: string, b: string) => number,
) {
  const rowKeys = [...rows.keys()].sort((a, b) => a - b)
  // Seed each row's order deterministically by input order for a stable start.
  for (const r of rowKeys) rows.get(r)!.sort(byInput)

  const slot = new Map<string, number>()
  const reindex = () => {
    for (const r of rowKeys) {
      rows.get(r)!.forEach((id, i) => slot.set(id, i))
    }
  }
  reindex()

  const neighborsOf = (id: string) => [
    ...parents.get(id)!,
    ...children.get(id)!,
    ...partners.get(id)!,
  ]

  const SWEEPS = 8
  for (let s = 0; s < SWEEPS; s++) {
    // Alternate sweep direction so ordering info flows both up and down.
    const keys = s % 2 === 0 ? rowKeys : [...rowKeys].reverse()
    for (const r of keys) {
      const row = rows.get(r)!
      const bary = new Map<string, number>()
      row.forEach((id, i) => {
        const nb = neighborsOf(id)
        const vals = nb.map((n) => slot.get(n)).filter((v) => v !== undefined) as number[]
        // People with no placed relatives keep their current slot.
        bary.set(id, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : i)
      })
      // Stable sort by barycenter; ties keep prior order.
      row
        .map((id, i) => ({ id, i }))
        .sort((a, b) => bary.get(a.id)! - bary.get(b.id)! || a.i - b.i)
        .forEach((e, i) => (row[i] = e.id))
      reindex()
    }
  }
}

// Assign an x to every person: pull each toward the average x of their
// relatives, then separate anyone too close within a row. The final pass
// guarantees a minimum gap, so no two people in a row can overlap.
function assignX(
  rows: Map<number, string[]>,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  partners: Map<string, string[]>,
): Map<string, number> {
  const rowKeys = [...rows.keys()].sort((a, b) => a - b)
  const x = new Map<string, number>()
  // Seed each row evenly spaced.
  for (const r of rowKeys) {
    rows.get(r)!.forEach((id, i) => x.set(id, i * COL_GAP))
  }

  const neighborsOf = (id: string) => [
    ...parents.get(id)!,
    ...children.get(id)!,
    ...partners.get(id)!,
  ]

  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    // Pull toward relatives (Jacobi: read old positions, write new ones).
    const next = new Map<string, number>()
    for (const r of rowKeys) {
      for (const id of rows.get(r)!) {
        const nb = neighborsOf(id)
        if (nb.length === 0) {
          next.set(id, x.get(id)!)
          continue
        }
        const target = nb.reduce((s, n) => s + x.get(n)!, 0) / nb.length
        next.set(id, x.get(id)! * (1 - PULL) + target * PULL)
      }
    }
    for (const [id, v] of next) x.set(id, v)

    // Separate overlaps within each row. Alternate direction to avoid a
    // consistent drift to one side.
    for (const r of rowKeys) separateRow(rows.get(r)!, x, pass % 2 === 0)
  }

  // Final guarantee: enforce the minimum gap left-to-right in every row.
  for (const r of rowKeys) {
    const row = rows.get(r)!
    for (let i = 1; i < row.length; i++) {
      const need = x.get(row[i - 1])! + COL_GAP
      if (x.get(row[i])! < need) x.set(row[i], need)
    }
  }
  return x
}

// Push apart any neighbors in a row that are closer than COL_GAP, keeping their
// order. `leftward` chooses which end stays put, so alternating passes don't
// bias the whole row in one direction.
function separateRow(row: string[], x: Map<string, number>, leftward: boolean) {
  if (leftward) {
    for (let i = 1; i < row.length; i++) {
      const need = x.get(row[i - 1])! + COL_GAP
      if (x.get(row[i])! < need) x.set(row[i], need)
    }
  } else {
    for (let i = row.length - 2; i >= 0; i--) {
      const need = x.get(row[i + 1])! - COL_GAP
      if (x.get(row[i])! > need) x.set(row[i], need)
    }
  }
}
