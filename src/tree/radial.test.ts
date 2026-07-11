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

function nodeMap(layout: ReturnType<typeof computeRadialLayout>) {
  const m: Record<string, (typeof layout.nodes)[number]> = {}
  for (const n of layout.nodes) m[n.id] = n
  return m
}

function minNodeDistance(layout: ReturnType<typeof computeRadialLayout>) {
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

  it('fans ancestors upward (negative y) and descendants downward', () => {
    const m = nodeMap(
      computeRadialLayout(
        ['me', 'mom', 'kid'],
        [pc('mom', 'me'), pc('me', 'kid')],
        'me',
      ),
    )
    expect(m.mom.y).toBeLessThan(0) // ancestor → up
    expect(m.mom.ring).toBe(-1)
    expect(m.kid.y).toBeGreaterThan(0) // descendant → down
    expect(m.kid.ring).toBe(1)
  })

  it('keeps ancestors and descendants clear of overlap', () => {
    const ids = ['me', 'mom', 'dad', 'gm', 'gf', 'kid1', 'kid2']
    const edges = [
      pc('mom', 'me'),
      pc('dad', 'me'),
      pc('gm', 'mom'),
      pc('gf', 'mom'),
      pc('me', 'kid1'),
      pc('me', 'kid2'),
    ]
    expect(minNodeDistance(computeRadialLayout(ids, edges, 'me'))).toBeGreaterThan(
      30,
    )
  })

  it('collapses a couple’s shared children onto one union junction', () => {
    // Two parents, two shared kids: one union junction, not four parent edges.
    const ids = ['mom', 'dad', 'a', 'b']
    const edges = [pc('mom', 'a'), pc('dad', 'a'), pc('mom', 'b'), pc('dad', 'b')]
    const l = computeRadialLayout(ids, edges, 'mom')
    // dad is the co-parent of both kids → a single union groups them.
    const stems = l.edges.filter((e) => e.style === 'unionStem')
    expect(l.junctions.length).toBe(1)
    // Each child hangs off the junction with a radial stem.
    expect(l.edges.filter((e) => e.style === 'radial').length).toBe(2)
    expect(stems.length).toBeGreaterThan(0)
  })

  it('gives each remarriage its own union wedge', () => {
    // One parent, two partners, a child by each → two distinct unions.
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
    // Both spouses and both children are on the descendant side.
    expect(m.c1.ring).toBe(1)
    expect(m.c2.ring).toBe(1)
    expect(m.s1).toBeDefined()
    expect(m.s2).toBeDefined()
  })

  it('flags a non-biological child stem with its subtype', () => {
    const ids = ['p', 'kid']
    const l = computeRadialLayout(ids, [pc('p', 'kid', 'adoptive')], 'p')
    const stem = l.edges.find(
      (e) => e.relation === 'parent_child' && e.style === 'radial',
    )
    expect(stem?.subtype).toBe('adoptive')
  })

  it('marks half-siblings of the focus', () => {
    // me + halfSib share only mom; fullSib shares mom and dad.
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
    const fromA = nodeMap(computeRadialLayout(ids, edges, 'a'))
    const fromC = nodeMap(computeRadialLayout(ids, edges, 'c'))
    // Rooted at A, C is two generations of descendants down.
    expect(fromA.c.ring).toBe(2)
    // Rooted at C, A is two generations of ancestors up.
    expect(fromC.a.ring).toBe(-2)
  })

  it('draws a partner with no shared children as a chord beside the focus', () => {
    const l = computeRadialLayout(['a', 'b'], [partner('a', 'b')], 'a')
    const m = nodeMap(l)
    expect(m.b.role).toBe('spouse')
    expect(l.edges.some((e) => e.relation === 'partner' && e.style === 'chord')).toBe(
      true,
    )
  })

  it('only shows people connected to the focus', () => {
    // d/e are a separate family, unreachable from the focus.
    const l = computeRadialLayout(
      ['a', 'b', 'd', 'e'],
      [pc('a', 'b'), pc('d', 'e')],
      'a',
    )
    const ids = l.nodes.map((n) => n.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('d')
    expect(ids).not.toContain('e')
  })
})
