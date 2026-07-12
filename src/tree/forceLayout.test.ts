import { describe, expect, it } from 'vitest'
import {
  computeForceLayout,
  NODE_W,
  NODE_H,
  FAMILY_SIZE,
  type ForceInputEdge,
  type ForceLayout,
} from './forceLayout'

const pc = (from: string, to: string, subtype?: string): ForceInputEdge => ({
  from,
  to,
  kind: 'parent_child',
  subtype,
})
const partner = (from: string, to: string, ended?: boolean): ForceInputEdge => ({
  from,
  to,
  kind: 'partner',
  ended,
})

// Every placed thing (person or family junction) as a box, so overlap invariants
// can reason about the same rectangles the layout separated.
function boxes(layout: ForceLayout) {
  const out: { id: string; x: number; y: number; w: number; h: number }[] = []
  for (const [id, p] of Object.entries(layout.pos)) {
    out.push({ id, x: p.x, y: p.y, w: NODE_W, h: NODE_H })
  }
  for (const f of layout.familyNodes) {
    out.push({ id: f.id, x: f.x, y: f.y, w: FAMILY_SIZE, h: FAMILY_SIZE })
  }
  return out
}

// The deepest overlap between any two boxes (0 when nothing overlaps). A pair
// overlaps only when their extents overlap on *both* axes.
function worstOverlap(layout: ForceLayout): number {
  const bs = boxes(layout)
  let worst = 0
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]
      const b = bs[j]
      const ox = (a.w + b.w) / 2 - Math.abs(a.x - b.x)
      const oy = (a.h + b.h) / 2 - Math.abs(a.y - b.y)
      if (ox > 1e-6 && oy > 1e-6) worst = Math.max(worst, Math.min(ox, oy))
    }
  }
  return worst
}

describe('computeForceLayout', () => {
  it('returns an empty layout for no nodes', () => {
    const l = computeForceLayout([], [])
    expect(l.pos).toEqual({})
    expect(l.familyNodes).toEqual([])
  })

  it('places a single node with a positive bounding box', () => {
    const l = computeForceLayout(['a'], [])
    expect(l.pos.a).toBeDefined()
    expect(Number.isFinite(l.pos.a.x)).toBe(true)
    expect(Number.isFinite(l.pos.a.y)).toBe(true)
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
  })

  it('is deterministic for the same input', () => {
    const ids = ['a', 'b', 'c', 'd']
    const edges = [pc('a', 'c'), pc('b', 'c'), pc('c', 'd'), partner('a', 'b')]
    expect(computeForceLayout(ids, edges)).toEqual(computeForceLayout(ids, edges))
  })

  it('ignores edges referencing absent nodes and self-loops, no NaNs', () => {
    const l = computeForceLayout(['a', 'b'], [pc('a', 'ghost'), pc('a', 'a'), pc('a', 'b')])
    expect(l.pos.a).toBeDefined()
    expect(l.pos.b).toBeDefined()
    for (const p of Object.values(l.pos)) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    for (const f of l.familyNodes) {
      expect(Number.isFinite(f.x)).toBe(true)
      expect(Number.isFinite(f.y)).toBe(true)
    }
  })

  it('only places the given nodes (ignores absent references)', () => {
    const l = computeForceLayout(['a', 'b'], [pc('a', 'b'), pc('a', 'ghost')])
    expect(Object.keys(l.pos).sort()).toEqual(['a', 'b'])
  })

  it('derives one family junction per distinct parent set', () => {
    // mom+dad share two kids (one union); dad+stepmom share one (another union).
    const ids = ['mom', 'dad', 'stepmom', 'k1', 'k2', 'half']
    const edges = [
      pc('mom', 'k1'),
      pc('dad', 'k1'),
      pc('mom', 'k2'),
      pc('dad', 'k2'),
      pc('dad', 'half'),
      pc('stepmom', 'half'),
    ]
    const l = computeForceLayout(ids, edges)
    expect(l.familyNodes.length).toBe(2)
    const momDad = l.familyNodes.find((f) => f.children.includes('k1'))!
    expect(momDad.parents.sort()).toEqual(['dad', 'mom'])
    expect(momDad.children.sort()).toEqual(['k1', 'k2'])
  })

  it('puts parents above children across every parent_child edge once settled', () => {
    // A three-generation family with a remarriage and an adoption.
    const ids = ['gm', 'gf', 'mom', 'dad', 'me', 'sis', 'spouse', 'kid', 'adopt']
    const edges = [
      partner('gm', 'gf'),
      pc('gm', 'mom'),
      pc('gf', 'mom'),
      partner('mom', 'dad'),
      pc('mom', 'me'),
      pc('dad', 'me'),
      pc('mom', 'sis'),
      pc('dad', 'sis'),
      pc('mom', 'adopt', 'adoptive'),
      pc('dad', 'adopt', 'adoptive'),
      partner('me', 'spouse'),
      pc('me', 'kid'),
      pc('spouse', 'kid'),
    ]
    const l = computeForceLayout(ids, edges)
    for (const e of edges) {
      if (e.kind !== 'parent_child') continue
      expect(l.pos[e.from].y).toBeLessThan(l.pos[e.to].y)
    }
  })

  it('routes a family junction below its parents and above its children', () => {
    const ids = ['mom', 'dad', 'kid']
    const l = computeForceLayout(ids, [pc('mom', 'kid'), pc('dad', 'kid'), partner('mom', 'dad')])
    const fam = l.familyNodes[0]
    expect(fam.y).toBeGreaterThan(l.pos.mom.y)
    expect(fam.y).toBeGreaterThan(l.pos.dad.y)
    expect(fam.y).toBeLessThan(l.pos.kid.y)
  })

  it('never overlaps any two nodes in a small family', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const edges = [
      partner('a', 'b'),
      pc('a', 'c'),
      pc('b', 'c'),
      pc('a', 'd'),
      pc('b', 'd'),
      pc('a', 'e'),
      pc('b', 'e'),
    ]
    expect(worstOverlap(computeForceLayout(ids, edges))).toBeLessThan(0.01)
  })

  it('never overlaps nodes, even in a large dense tree', () => {
    // A synthetic 4-generation family: couples with several children each. Two
    // founding couples fan out to 100+ people — enough to stress the invariant,
    // while the O(n²) stress solve still finishes fast. (The generous timeout is
    // headroom for slow CI, not an expectation it takes that long.)
    const ids: string[] = []
    const edges: ForceInputEdge[] = []
    let counter = 0
    const mk = () => {
      const id = `n${counter++}`
      ids.push(id)
      return id
    }
    let generation = Array.from({ length: 2 }, () => {
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
        for (const kid of kids) {
          const spouse = mk()
          edges.push(partner(kid, spouse))
          nextGen.push([kid, spouse])
        }
      }
      generation = nextGen
    }
    expect(ids.length).toBeGreaterThan(100)

    const l = computeForceLayout(ids, edges)
    for (const id of ids) {
      expect(l.pos[id]).toBeDefined()
      expect(Number.isFinite(l.pos[id].x)).toBe(true)
      expect(Number.isFinite(l.pos[id].y)).toBe(true)
    }
    expect(worstOverlap(l)).toBeLessThan(0.01)
  }, 20000)

  it('lays out unrelated families without overlap', () => {
    const l = computeForceLayout(
      ['a', 'b', 'x', 'y'],
      [pc('a', 'b'), pc('x', 'y')],
    )
    expect(worstOverlap(l)).toBeLessThan(0.01)
    // Both families are placed and finite.
    for (const id of ['a', 'b', 'x', 'y']) {
      expect(Number.isFinite(l.pos[id].x)).toBe(true)
    }
  })

  it('handles a person with no relationships', () => {
    const l = computeForceLayout(['solo', 'a', 'b'], [pc('a', 'b')])
    expect(l.pos.solo).toBeDefined()
    expect(worstOverlap(l)).toBeLessThan(0.01)
  })
})
