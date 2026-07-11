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

function wedgeMap(layout: Layout) {
  const m: Record<string, Layout['wedges'][number]> = {}
  for (const w of layout.wedges) m[w.id] = w
  return m
}
// Screen y of a wedge's mid-radius/mid-angle (positive = below the focus).
function wedgeMidY(w: Layout['wedges'][number]) {
  const mid = (w.a0 + w.a1) / 2
  return -((w.r0 + w.r1) / 2) * Math.sin(mid)
}

describe('computeRadialLayout', () => {
  it('returns an empty layout for no nodes', () => {
    const l = computeRadialLayout([], [], 'x')
    expect(l.focus).toBeNull()
    expect(l.wedges).toEqual([])
  })

  it('returns an empty layout when the focus is absent', () => {
    expect(computeRadialLayout(['a'], [], 'ghost').focus).toBeNull()
  })

  it('places the focus at the origin', () => {
    const l = computeRadialLayout(['a'], [], 'a')
    expect(l.focus?.id).toBe('a')
    expect(l.focus?.x).toBeCloseTo(0)
    expect(l.focus?.y).toBeCloseTo(0)
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
    expect(l.focus?.id).toBe('a')
    expect(l.wedges.every((w) => Number.isFinite(w.a0) && Number.isFinite(w.r0))).toBe(
      true,
    )
  })

  it('fans ancestors above and descendants below, both as wedges', () => {
    const l = computeRadialLayout(
      ['me', 'mom', 'kid'],
      [pc('mom', 'me'), pc('me', 'kid')],
      'me',
    )
    const w = wedgeMap(l)
    expect(w.mom.kind).toBe('ancestor')
    expect(w.mom.ring).toBe(1)
    expect(wedgeMidY(w.mom)).toBeLessThan(0) // ancestor → up
    expect(w.kid.kind).toBe('descendant')
    expect(w.kid.ring).toBe(1)
    expect(wedgeMidY(w.kid)).toBeGreaterThan(0) // descendant → down
  })

  it('subdivides an ancestor wedge among all parents when there are more than two', () => {
    const ids = ['me', 'mom', 'dad', 'adopt']
    const edges = [pc('mom', 'me'), pc('dad', 'me'), pc('adopt', 'me', 'adoptive')]
    const l = computeRadialLayout(ids, edges, 'me')
    const ring1 = l.wedges.filter((w) => w.kind === 'ancestor' && w.ring === 1)
    expect(ring1.length).toBe(3)
    const sorted = [...ring1].sort((a, b) => a.a0 - b.a0)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].a0).toBeGreaterThanOrEqual(sorted[i - 1].a1 - 1e-9)
    }
    expect(wedgeMap(l).adopt.subtype).toBe('adoptive')
  })

  it('sibling wedges at the same ring have disjoint arcs', () => {
    const ids = ['me', 'mom', 'dad', 'gm', 'gf']
    const edges = [pc('mom', 'me'), pc('dad', 'me'), pc('gm', 'mom'), pc('gf', 'mom')]
    const l = computeRadialLayout(ids, edges, 'me')
    const ring2 = l.wedges
      .filter((w) => w.kind === 'ancestor' && w.ring === 2)
      .sort((a, b) => a.a0 - b.a0)
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

  it('groups a couple’s shared children under one spouse band', () => {
    const ids = ['mom', 'dad', 'a', 'b']
    const edges = [pc('mom', 'a'), pc('dad', 'a'), pc('mom', 'b'), pc('dad', 'b')]
    const l = computeRadialLayout(ids, edges, 'mom')
    const bands = l.wedges.filter((w) => w.kind === 'spouse')
    const kids = l.wedges.filter((w) => w.kind === 'descendant')
    expect(bands.length).toBe(1)
    expect(bands[0].id).toBe('dad')
    expect(kids.map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('gives each remarriage its own spouse band', () => {
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
    const bands = l.wedges.filter((w) => w.kind === 'spouse')
    expect(bands.map((b) => b.id).sort()).toEqual(['s1', 's2'])
    const kids = l.wedges.filter((w) => w.kind === 'descendant')
    expect(kids.map((w) => w.id).sort()).toEqual(['c1', 'c2'])
  })

  it('marks a spouse band as ended when the marriage has ended', () => {
    const ids = ['p', 'ex', 'c']
    const l = computeRadialLayout(
      ids,
      [partner('p', 'ex', true), pc('p', 'c'), pc('ex', 'c')],
      'p',
    )
    const band = wedgeMap(l).ex
    expect(band.kind).toBe('spouse')
    expect(band.ended).toBe(true)
  })

  it('flags a non-biological child wedge with its subtype', () => {
    const l = computeRadialLayout(['p', 'kid'], [pc('p', 'kid', 'adoptive')], 'p')
    expect(wedgeMap(l).kid.subtype).toBe('adoptive')
  })

  it('draws siblings as slices in the horizontal channel, half-siblings marked', () => {
    const ids = ['me', 'mom', 'dad', 'ofather', 'half', 'full']
    const edges = [
      pc('mom', 'me'),
      pc('dad', 'me'),
      pc('mom', 'full'),
      pc('dad', 'full'),
      pc('mom', 'half'),
      pc('ofather', 'half'),
    ]
    const w = wedgeMap(computeRadialLayout(ids, edges, 'me'))
    expect(w.full.kind).toBe('sibling')
    expect(w.full.half).toBeFalsy()
    expect(w.half.kind).toBe('sibling')
    expect(w.half.half).toBe(true)
    // A sibling slice sits at ring 1 near the horizontal (small |y| at mid).
    expect(w.full.ring).toBe(1)
    expect(Math.abs(wedgeMidY(w.full))).toBeLessThan(w.full.r1)
  })

  it('re-roots cleanly when the focus changes', () => {
    const ids = ['a', 'b', 'c']
    const edges = [pc('a', 'b'), pc('b', 'c')]
    // Rooted at A, C is two generations of descendants down.
    expect(wedgeMap(computeRadialLayout(ids, edges, 'a')).c.ring).toBe(2)
    // Rooted at C, A is two generations of ancestors up.
    expect(wedgeMap(computeRadialLayout(ids, edges, 'c')).a.ring).toBe(2)
  })

  it('draws a childless partner as a spouse slice in the horizontal channel', () => {
    const l = computeRadialLayout(['a', 'b'], [partner('a', 'b')], 'a')
    const b = wedgeMap(l).b
    expect(b.kind).toBe('spouse')
    expect(b.ring).toBe(1)
  })

  it('keeps descendant wedges at a ring within disjoint arcs', () => {
    const ids = ['me', 'k1', 'k2', 'k3']
    const edges = [pc('me', 'k1'), pc('me', 'k2'), pc('me', 'k3')]
    const l = computeRadialLayout(ids, edges, 'me')
    const ring1 = l.wedges
      .filter((w) => w.kind === 'descendant' && w.ring === 1)
      .sort((a, b) => a.a0 - b.a0)
    expect(ring1.length).toBe(3)
    for (let i = 1; i < ring1.length; i++) {
      expect(ring1[i].a0).toBeGreaterThanOrEqual(ring1[i - 1].a1 - 1e-9)
    }
  })

  it('only shows people connected to the focus', () => {
    const l = computeRadialLayout(
      ['a', 'b', 'd', 'e'],
      [pc('a', 'b'), pc('d', 'e')],
      'a',
    )
    const ids = [l.focus?.id, ...l.wedges.map((w) => w.id)]
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('d')
    expect(ids).not.toContain('e')
  })
})
