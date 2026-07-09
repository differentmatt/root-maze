import { describe, expect, it } from 'vitest'
import { computeLayout } from './layout'

describe('computeLayout', () => {
  it('centers a single node', () => {
    const pos = computeLayout(['a'], [], 600, 400)
    expect(pos.a).toEqual({ x: 300, y: 200 })
  })

  it('returns a position for every node, inside the viewport', () => {
    const ids = ['a', 'b', 'c', 'd']
    const links = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
    ]
    const pos = computeLayout(ids, links, 600, 460, 120)
    for (const id of ids) {
      expect(pos[id]).toBeDefined()
      expect(pos[id].x).toBeGreaterThanOrEqual(24)
      expect(pos[id].x).toBeLessThanOrEqual(576)
      expect(pos[id].y).toBeGreaterThanOrEqual(24)
      expect(pos[id].y).toBeLessThanOrEqual(436)
      expect(Number.isFinite(pos[id].x)).toBe(true)
      expect(Number.isFinite(pos[id].y)).toBe(true)
    }
  })

  it('is deterministic for the same input', () => {
    const ids = ['a', 'b', 'c']
    const links = [{ from: 'a', to: 'b' }]
    const one = computeLayout(ids, links, 600, 400)
    const two = computeLayout(ids, links, 600, 400)
    expect(one).toEqual(two)
  })

  it('ignores links referencing absent nodes', () => {
    const pos = computeLayout(['a', 'b'], [{ from: 'a', to: 'ghost' }], 600, 400)
    expect(pos.a).toBeDefined()
    expect(pos.b).toBeDefined()
    expect(Number.isFinite(pos.a.x)).toBe(true)
  })

  it('handles an empty graph', () => {
    expect(computeLayout([], [], 600, 400)).toEqual({})
  })
})
