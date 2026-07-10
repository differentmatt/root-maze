import { describe, expect, it } from 'vitest'
import { computeLayout, neighborhood, type LayoutEdge } from './layout'

const pc = (from: string, to: string): LayoutEdge => ({
  from,
  to,
  kind: 'parent_child',
})
const partner = (from: string, to: string): LayoutEdge => ({
  from,
  to,
  kind: 'partner',
})

// Minimum center-to-center distance any two placed nodes should keep. Rows are
// 150 apart and columns 120 apart, so 110 is a safe floor that catches overlap.
const MIN_SEP = 110

function minPairwiseDistance(pos: Record<string, { x: number; y: number }>) {
  const ids = Object.keys(pos)
  let min = Infinity
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i]]
      const b = pos[ids[j]]
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  return min
}

describe('computeLayout', () => {
  it('handles an empty graph', () => {
    expect(computeLayout([], [])).toEqual({ pos: {}, width: 0, height: 0 })
  })

  it('places a single node with a positive bounding box', () => {
    const { pos, width, height } = computeLayout(['a'], [])
    expect(pos.a).toBeDefined()
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('is deterministic for the same input', () => {
    const ids = ['a', 'b', 'c']
    const edges = [pc('a', 'b'), pc('a', 'c')]
    expect(computeLayout(ids, edges)).toEqual(computeLayout(ids, edges))
  })

  it('ignores edges referencing absent nodes and self-loops', () => {
    const { pos } = computeLayout(
      ['a', 'b'],
      [pc('a', 'ghost'), pc('a', 'a')],
    )
    expect(pos.a).toBeDefined()
    expect(pos.b).toBeDefined()
    expect(Number.isFinite(pos.a.x)).toBe(true)
  })

  it('puts children on a lower row than their parents', () => {
    const { pos } = computeLayout(['p', 'c'], [pc('p', 'c')])
    expect(pos.c.y).toBeGreaterThan(pos.p.y)
  })

  it('keeps partners on the same row', () => {
    const { pos } = computeLayout(['a', 'b'], [partner('a', 'b')])
    expect(pos.a.y).toBe(pos.b.y)
  })

  it('places grandchildren two rows below grandparents', () => {
    const { pos } = computeLayout(
      ['g', 'p', 'c'],
      [pc('g', 'p'), pc('p', 'c')],
    )
    expect(pos.p.y).toBeGreaterThan(pos.g.y)
    expect(pos.c.y).toBeGreaterThan(pos.p.y)
  })

  it('never overlaps nodes, even in a large dense tree', () => {
    // A synthetic 4-generation family: couples with several children each.
    const ids: string[] = []
    const edges: LayoutEdge[] = []
    let counter = 0
    const mk = () => {
      const id = `n${counter++}`
      ids.push(id)
      return id
    }
    // Seed generation 0 with a few founding couples.
    let generation = Array.from({ length: 4 }, () => {
      const a = mk()
      const b = mk()
      edges.push(partner(a, b))
      return [a, b] as const
    })
    for (let g = 0; g < 3; g++) {
      const nextGen: (readonly [string, string])[] = []
      for (const [pa, pb] of generation) {
        const kids = Array.from({ length: 3 }, () => {
          const kid = mk()
          edges.push(pc(pa, kid), pc(pb, kid))
          return kid
        })
        // Pair up some children with incoming partners for the next generation.
        for (const kid of kids) {
          const spouse = mk()
          edges.push(partner(kid, spouse))
          nextGen.push([kid, spouse])
        }
      }
      generation = nextGen
    }
    expect(ids.length).toBeGreaterThan(100)

    const { pos } = computeLayout(ids, edges)
    for (const id of ids) {
      expect(pos[id]).toBeDefined()
      expect(Number.isFinite(pos[id].x)).toBe(true)
      expect(Number.isFinite(pos[id].y)).toBe(true)
    }
    expect(minPairwiseDistance(pos)).toBeGreaterThanOrEqual(MIN_SEP)
  })

  it('separates unrelated families without overlap', () => {
    const { pos } = computeLayout(
      ['a', 'b', 'x', 'y'],
      [pc('a', 'b'), pc('x', 'y')],
    )
    // The two families should not sit on top of each other.
    expect(minPairwiseDistance(pos)).toBeGreaterThanOrEqual(MIN_SEP)
  })
})

describe('neighborhood', () => {
  // A line of five generations: g0 -> g1 -> g2 -> g3 -> g4.
  const ids = ['g0', 'g1', 'g2', 'g3', 'g4']
  const chain = [pc('g0', 'g1'), pc('g1', 'g2'), pc('g2', 'g3'), pc('g3', 'g4')]

  it('includes the focus person and everyone within the given depth', () => {
    const set = neighborhood(ids, chain, 'g2', 1)
    expect([...set].sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('reaches further as depth grows', () => {
    const set = neighborhood(ids, chain, 'g2', 2)
    expect([...set].sort()).toEqual(['g0', 'g1', 'g2', 'g3', 'g4'])
  })

  it('treats relationships as undirected (reaches parents and children)', () => {
    const set = neighborhood(ids, chain, 'g4', 1)
    expect([...set].sort()).toEqual(['g3', 'g4'])
  })

  it('follows partner as well as parent_child edges', () => {
    const set = neighborhood(
      ['a', 'b', 'c'],
      [partner('a', 'b'), pc('b', 'c')],
      'a',
      1,
    )
    // a's only relative within one hop is partner b.
    expect([...set].sort()).toEqual(['a', 'b'])
  })

  it('returns just the focus person when they have no relatives', () => {
    expect([...neighborhood(['solo', 'x'], [], 'solo', 3)]).toEqual(['solo'])
  })

  it('falls back to every node when the focus is absent', () => {
    const set = neighborhood(ids, chain, 'ghost', 2)
    expect(set.size).toBe(ids.length)
  })

  it('keeps the focus neighborhood laid out without overlap', () => {
    const set = neighborhood(ids, chain, 'g2', 5)
    const subIds = ids.filter((id) => set.has(id))
    const subEdges = chain.filter((e) => set.has(e.from) && set.has(e.to))
    const { pos } = computeLayout(subIds, subEdges)
    expect(minPairwiseDistance(pos)).toBeGreaterThanOrEqual(MIN_SEP)
  })
})
