import { describe, expect, it } from 'vitest'
import { computeRadialLayout, type RadialInputEdge } from './radial'

const pc = (
  from: string,
  to: string,
  subtype?: string,
): RadialInputEdge => ({ from, to, kind: 'parent_child', subtype })
const partner = (
  from: string,
  to: string,
  ended?: boolean,
): RadialInputEdge => ({ from, to, kind: 'partner', ended })

type Layout = ReturnType<typeof computeRadialLayout>

function nodeMap(layout: Layout) {
  const m: Record<string, Layout['nodes'][number]> = {}
  for (const n of layout.nodes) m[n.id] = n
  return m
}
function wedgeMap(layout: Layout) {
  const m: Record<string, Layout['wedges'][number]> = {}
  for (const w of layout.wedges) m[w.id] = w
  return m
}

function minNodeDistance(layout: Layout) {
  const ns = layout.nodes
  let min = Infinity
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      min = Math.min(min, Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y))
    }
  }
  return min
}

describe('computeRadialLayout', () => {
  it('returns an empty layout for no nodes', () => {
    const l = computeRadialLayout([], [], 'x')
    expect(l.nodes).toEqual([])
    expect(l.edges).toEqual([])
    expect(l.wedges).toEqual([])
  })

  it('returns an empty layout when the focus is absent', () => {
    expect(computeRadialLayout(['a'], [], 'ghost').nodes).toEqual([])
  })

  it('places the focus at the origin', () => {
    const m = nodeMap(computeRadialLayout(['a'], [], 'a'))
    expect(m.a.x).toBeCloseTo(0)
    expect(m.a.y).toBeCloseTo(0)
    expect(m.a.ring).toBe(0)
    expect(m.a.role).toBe('focus')
  })

  it('is deterministic for the same input', () => {
    const ids = ['a', 'b', 'c', 'd']
    const edges = [pc('b', 'a'), pc('c', 'a'), pc('a', 'd')]
    expect(computeRadialLayout(ids, edges, 'a')).toEqual(
      computeRadialLayout(ids, edges, 'a'),
    )
  })

  it('ignores edges referencing absent nodes and self-loops', () => {
    const l = computeRadialLayout(['a', 'b'], [pc('a', 'ghost'), pc('a', 'a')], 'a')
    expect(nodeMap(l).a).toBeDefined()
    expect(l.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(
      true,
    )
  })

  it('draws ancestors as wedges and descendants as nodes below', () => {
    const l = computeRadialLayout(
      ['me', 'mom', 'kid'],
      [pc('mom', 'me'), pc('me', 'kid')],
      'me',
    )
    // Ancestor → a ring-1 wedge, not a node.
    const w = wedgeMap(l)
    expect(w.mom).toBeDefined()
    expect(w.mom.ring).toBe(1)
    expect(w.mom.r1).toBeGreaterThan(w.mom.r0)
    expect(nodeMap(l).mom).toBeUndefined()
    // Descendant → a node below the focus.
    const kid = nodeMap(l).kid
    expect(kid.y).toBeGreaterThan(0)
    expect(kid.ring).toBe(1)
  })

  it('subdivides a wedge among all parents when there are more than two', () => {
    // Adoptive + two biological parents: three wedges share the focus's arc.
    const ids = ['me', 'mom', 'dad', 'adopt']
    const edges = [pc('mom', 'me'), pc('dad', 'me'), pc('adopt', 'me', 'adoptive')]
    const l = computeRadialLayout(ids, edges, 'me')
    const ring1 = l.wedges.filter((w) => w.ring === 1)
    expect(ring1.length).toBe(3)
    // Their arcs tile the fan without overlapping.
    const sorted = [...ring1].sort((a, b) => a.a0 - b.a0)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].a0).toBeGreaterThanOrEqual(sorted[i - 1].a1 - 1e-9)
    }
    // The non-biological parent keeps its subtype for styling.
    expect(wedgeMap(l).adopt.subtype).toBe('adoptive')
  })

  it('sibling wedges at the same ring have disjoint arcs', () => {
    const ids = ['me', 'mom', 'dad', 'gm', 'gf']
    const edges = [pc('mom', 'me'), pc('dad', 'me'), pc('gm', 'mom'), pc('gf', 'mom')]
    const l = computeRadialLayout(ids, edges, 'me')
    const ring2 = l.wedges.filter((w) => w.ring === 2).sort((a, b) => a.a0 - b.a0)
    expect(ring2.length).toBe(2)
    expect(ring2[1].a0).toBeGreaterThanOrEqual(ring2[0].a1 - 1e-9)
  })

  it('gives each ancestral branch its own lineage color', () => {
    const l = computeRadialLayout(
      ['me', 'mom', 'dad'],
      [pc('mom', 'me'), pc('dad', 'me')],
      'me',
    )
    const w = wedgeMap(l)
    expect(w.mom.lineage).not.toBe(w.dad.lineage)
  })

  it('collapses a couple’s shared children onto one union junction', () => {
    const ids = ['mom', 'dad', 'a', 'b']
    const edges = [pc('mom', 'a'), pc('dad', 'a'), pc('mom', 'b'), pc('dad', 'b')]
    const l = computeRadialLayout(ids, edges, 'mom')
    expect(l.junctions.length).toBe(1)
    expect(l.edges.filter((e) => e.style === 'radial').length).toBe(2)
  })

  it('gives each remarriage its own union wedge', () => {
    const ids = ['p', 's1', 's2', 'c1', 'c2']
    const edges = [
      partner('p', 's1'),
      partner('p', 's2'),
      pc('p', 'c1'),
      pc('s1', 'c1'),
      pc('p', 'c2'),
      pc('s2', 'c2'),
    ]
    const l = computeRadialLayout(ids, edges, 'p')
    expect(l.junctions.length).toBe(2)
    const m = nodeMap(l)
    expect(m.c1.ring).toBe(1)
    expect(m.c2.ring).toBe(1)
    expect(m.s1).toBeDefined()
    expect(m.s2).toBeDefined()
  })

  it('flags a non-biological child stem with its subtype', () => {
    const l = computeRadialLayout(['p', 'kid'], [pc('p', 'kid', 'adoptive')], 'p')
    const stem = l.edges.find(
      (e) => e.relation === 'parent_child' && e.style === 'radial',
    )
    expect(stem?.subtype).toBe('adoptive')
  })

  it('marks half-siblings of the focus', () => {
    const ids = ['me', 'mom', 'dad', 'ofather', 'half', 'full']
    const edges = [
      pc('mom', 'me'),
      pc('dad', 'me'),
      pc('mom', 'full'),
      pc('dad', 'full'),
      pc('mom', 'half'),
      pc('ofather', 'half'),
    ]
    const m = nodeMap(computeRadialLayout(ids, edges, 'me'))
    expect(m.full.role).toBe('sibling')
    expect(m.full.half).toBe(false)
    expect(m.half.role).toBe('sibling')
    expect(m.half.half).toBe(true)
  })

  it('re-roots cleanly when the focus changes', () => {
    const ids = ['a', 'b', 'c']
    const edges = [pc('a', 'b'), pc('b', 'c')]
    // Rooted at A, C is two generations of descendants down (a node at ring 2).
    expect(nodeMap(computeRadialLayout(ids, edges, 'a')).c.ring).toBe(2)
    // Rooted at C, A is two generations of ancestors up (a ring-2 wedge).
    expect(wedgeMap(computeRadialLayout(ids, edges, 'c')).a.ring).toBe(2)
  })

  it('draws a partner with no shared children as a chord beside the focus', () => {
    const l = computeRadialLayout(['a', 'b'], [partner('a', 'b')], 'a')
    expect(nodeMap(l).b.role).toBe('spouse')
    expect(l.edges.some((e) => e.relation === 'partner' && e.style === 'chord')).toBe(
      true,
    )
  })

  it('keeps descendant nodes clear of overlap', () => {
    const ids = ['me', 'k1', 'k2', 'k3', 'g1']
    const edges = [pc('me', 'k1'), pc('me', 'k2'), pc('me', 'k3'), pc('k1', 'g1')]
    expect(minNodeDistance(computeRadialLayout(ids, edges, 'me'))).toBeGreaterThan(
      30,
    )
  })

  it('only shows people connected to the focus', () => {
    const l = computeRadialLayout(
      ['a', 'b', 'd', 'e'],
      [pc('a', 'b'), pc('d', 'e')],
      'a',
    )
    const ids = [...l.nodes.map((n) => n.id), ...l.wedges.map((w) => w.id)]
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('d')
    expect(ids).not.toContain('e')
  })
})
