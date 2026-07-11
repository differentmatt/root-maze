import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/nodes.js', async () => {
  const actual = await vi.importActual('../lib/nodes.js')
  return {
    // Keep the real nodeFullName (pure), mock the DynamoDB-facing functions.
    nodeFullName: actual.nodeFullName,
    listNodes: vi.fn(),
    getNode: vi.fn(),
    createNode: vi.fn(),
    updateNode: vi.fn(),
  }
})
vi.mock('../lib/edges.js', () => ({
  createEdge: vi.fn(),
  listEdges: vi.fn(),
  putEdgeIfNew: vi.fn(),
}))

import { listNodes, getNode, createNode, updateNode } from '../lib/nodes.js'
import { listEdges, putEdgeIfNew } from '../lib/edges.js'
import { ValidationError } from '../lib/errors.js'
import { previewImport, commitImport } from '../lib/gedcom-import.js'

const GED = `0 HEAD
1 SOUR X
2 NAME The Family
0 @I1@ INDI
1 NAME Ada /King/
1 BIRT
2 DATE 1815
0 @I2@ INDI
1 NAME William /King/
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
0 TRLR
`

// Convenience: an existing node with sensible defaults.
const node = (over) => ({
  nodeId: 'nod_x',
  firstName: 'X',
  middleName: null,
  lastName: null,
  birthdate: null,
  deathdate: null,
  notes: null,
  updatedAt: '2024-01-01',
  ...over,
})

const findPerson = (preview, name) => preview.people.find((p) => p.fullName === name)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listNodes).mockResolvedValue([])
  vi.mocked(listEdges).mockResolvedValue([])
  vi.mocked(createNode).mockImplementation(async (_g, _a, input) => ({
    nodeId: 'nod_' + input.firstName,
    ...input,
  }))
  vi.mocked(updateNode).mockResolvedValue({})
  vi.mocked(putEdgeIfNew).mockImplementation(async (_g, _a, input, pairsSeen) => {
    const key = [input.fromPerson, input.toPerson].sort().join('|')
    if (pairsSeen.has(key)) return null
    pairsSeen.add(key)
    return {}
  })
})

describe('previewImport', () => {
  it('reports stats and all-new people for an empty group', async () => {
    const preview = await previewImport('g1', GED)
    expect(preview.treeName).toBe('The Family')
    expect(preview.stats).toEqual({
      people: 2,
      relationships: 1,
      strongMatches: 0,
      possibleMatches: 0,
      newPeople: 2,
      alreadyInTree: 0,
    })
    expect(preview.people.every((p) => p.candidates.length === 0)).toBe(true)
    expect(preview.people.every((p) => p.suggestedNodeId === null)).toBe(true)
  })

  it('surfaces relationships each imported person brings (new into an empty group)', async () => {
    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.relationships).toContainEqual({
      relation: 'partner',
      otherName: 'William King',
      isNew: true,
    })
  })

  it('marks a re-imported, fully-present person as alreadyInTree', async () => {
    // The tree already holds Ada and William, partnered — importing the same
    // file again should have nothing to add for either of them.
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King', birthdate: '1815' }),
      node({ nodeId: 'nod_will', firstName: 'William', lastName: 'King' }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([
      { edgeKind: 'partner', fromPerson: 'nod_ada', toPerson: 'nod_will', subtype: 'partner' },
    ])
    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.alreadyInTree).toBe(true)
    expect(ada.relationships).toContainEqual({ relation: 'partner', otherName: 'William King', isNew: false })
    expect(preview.stats.alreadyInTree).toBe(2)
  })

  it('detects an import parent as an existing no-surname parent via tree shape', async () => {
    // The reported case: the tree has "Jim"/"Lyn" (no surname) as Matt's
    // parents; importing "Jim Lott"/"Lyn Lott" (also Matt's parents) should
    // merge into them via the shared-child structural signal, not add dupes.
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'm', firstName: 'Matt', middleName: 'McCabe', lastName: 'Lott', birthdate: '1979-05-01' }),
      node({ nodeId: 'jim', firstName: 'Jim', lastName: null }),
      node({ nodeId: 'lyn', firstName: 'Lyn', lastName: null }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([
      { edgeKind: 'parent_child', fromPerson: 'jim', toPerson: 'm', subtype: 'biological' },
      { edgeKind: 'parent_child', fromPerson: 'lyn', toPerson: 'm', subtype: 'biological' },
      { edgeKind: 'partner', fromPerson: 'jim', toPerson: 'lyn', subtype: 'partner' },
    ])
    const ged = `0 HEAD
0 @I1@ INDI
1 NAME Matt /Lott/
1 BIRT
2 DATE 1979
0 @I5@ INDI
1 NAME Jim /Lott/
0 @I6@ INDI
1 NAME Lyn /Lott/
0 @F1@ FAM
1 HUSB @I5@
1 WIFE @I6@
1 CHIL @I1@
0 TRLR`
    const preview = await previewImport('g1', ged)
    expect(findPerson(preview, 'Matt Lott').suggestedNodeId).toBe('m')
    expect(findPerson(preview, 'Jim Lott').suggestedNodeId).toBe('jim')
    expect(findPerson(preview, 'Lyn Lott').suggestedNodeId).toBe('lyn')
  })

  it('structural boost requires a matching relationship type', async () => {
    // In the file, Jim is Matt's PARENT. In the tree, the existing "Jim" is
    // Matt's CHILD (m -> jim). The shared relative (Matt) is the wrong type, so
    // it must not boost Jim into a suggested merge.
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'm', firstName: 'Matt', lastName: 'Lott', birthdate: '1979' }),
      node({ nodeId: 'jim', firstName: 'Jim', lastName: null }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([
      { edgeKind: 'parent_child', fromPerson: 'm', toPerson: 'jim', subtype: 'biological' },
    ])
    const ged = `0 HEAD
0 @I1@ INDI
1 NAME Matt /Lott/
1 BIRT
2 DATE 1979
0 @I5@ INDI
1 NAME Jim /Lott/
0 @F1@ FAM
1 HUSB @I5@
1 CHIL @I1@
0 TRLR`
    const preview = await previewImport('g1', ged)
    // No matching-type relative -> Jim is at most a "possible" match, not merged.
    expect(findPerson(preview, 'Jim Lott').suggestedNodeId).toBeNull()
    // Matt still matches (name + date), just without lifting Jim.
    expect(findPerson(preview, 'Matt Lott').suggestedNodeId).toBe('m')
  })

  it('re-import: committed people are hidden, a previously-skipped one is reviewable', async () => {
    // Scenario: last time you imported this file, accepted Ada + William (now in
    // the tree, partnered) and skipped Zed (never created). Re-importing the
    // same file: Ada + William are alreadyInTree; Zed comes back as reviewable.
    const ged = `0 HEAD
0 @I1@ INDI
1 NAME Ada /King/
0 @I2@ INDI
1 NAME William /King/
0 @I3@ INDI
1 NAME Zed /King/
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
0 TRLR`
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King' }),
      node({ nodeId: 'nod_will', firstName: 'William', lastName: 'King' }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([
      { edgeKind: 'partner', fromPerson: 'nod_ada', toPerson: 'nod_will', subtype: 'partner' },
    ])

    const preview = await previewImport('g1', ged)
    expect(findPerson(preview, 'Ada King').alreadyInTree).toBe(true)
    expect(findPerson(preview, 'William King').alreadyInTree).toBe(true)

    const zed = findPerson(preview, 'Zed King')
    expect(zed.alreadyInTree).toBe(false)
    expect(zed.suggestedNodeId).toBeNull() // not in the tree — a fresh import again
    expect(preview.stats.alreadyInTree).toBe(2)
  })

  it('does NOT mark alreadyInTree when the file adds a new relationship', async () => {
    // Ada and William both already exist but are NOT yet connected; the file's
    // partner edge is new, so Ada has something to add.
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King', birthdate: '1815' }),
      node({ nodeId: 'nod_will', firstName: 'William', lastName: 'King' }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([]) // no existing edges
    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.alreadyInTree).toBe(false)
    expect(ada.relationships).toContainEqual({ relation: 'partner', otherName: 'William King', isNew: true })
  })

  it('suggests a strong match and diffs fields (same vs tree-only)', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King', birthdate: '1815', notes: 'Old note' }),
    ])

    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.suggestedNodeId).toBe('nod_ada')
    expect(ada.candidates[0].tier).toBe('strong')
    const byField = Object.fromEntries(ada.candidates[0].fieldDiffs.map((d) => [d.field, d.status]))
    expect(byField.birthdate).toBe('same')
    expect(byField.notes).toBe('treeOnly') // tree has a note, import doesn't
  })

  it('matches across a middle-name gap and a year-vs-full-date difference', async () => {
    // The real report: existing "Matt McCabe Lott" (born 1979-05-01) recognised
    // when importing "Matt Lott" (born 1979).
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_matt', firstName: 'Matt', middleName: 'McCabe', lastName: 'Lott', birthdate: '1979-05-01' }),
    ])
    const ged = '0 HEAD\n0 @I1@ INDI\n1 NAME Matt /Lott/\n1 BIRT\n2 DATE 1979\n0 TRLR'
    const preview = await previewImport('g1', ged)
    const matt = findPerson(preview, 'Matt Lott')
    expect(matt.suggestedNodeId).toBe('nod_matt')
    const byField = Object.fromEntries(matt.candidates[0].fieldDiffs.map((d) => [d.field, d.status]))
    expect(byField.birthdate).toBe('conflict') // 1979 vs 1979-05-01, for review
    expect(byField.middleName).toBe('treeOnly') // keep existing "McCabe"
  })

  it('matches a nickname (Matthew Lott -> existing Matt Lott)', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_matt', firstName: 'Matt', lastName: 'Lott', birthdate: '1979' }),
    ])
    const ged = '0 HEAD\n0 @I1@ INDI\n1 NAME Matthew /Lott/\n1 BIRT\n2 DATE 1979\n0 TRLR'
    const preview = await previewImport('g1', ged)
    const matt = findPerson(preview, 'Matthew Lott')
    expect(matt.suggestedNodeId).toBe('nod_matt')
    expect(matt.candidates[0].reasons.join(' ')).toMatch(/nickname/)
  })

  it('does not surface a same-name node whose birth year disagrees', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_other', firstName: 'Ada', lastName: 'King', birthdate: '1900' }),
    ])
    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.candidates).toHaveLength(0)
    expect(ada.suggestedNodeId).toBeNull()
  })

  it('does not surface same-surname relatives with unrelated first names', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_zed', firstName: 'Zebediah', lastName: 'King' }),
    ])
    const preview = await previewImport('g1', GED)
    // Neither Ada nor William should match Zebediah on surname alone.
    expect(preview.people.every((p) => p.candidates.length === 0)).toBe(true)
  })

  it('boosts a candidate that shares a relative already in the tree', async () => {
    // Tree: Ada King <-> William King (partners). Import the same couple; each
    // person's match should be reinforced by the other's provisional match.
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King' }),
      node({ nodeId: 'nod_will', firstName: 'William', lastName: 'King' }),
    ])
    vi.mocked(listEdges).mockResolvedValueOnce([
      { edgeKind: 'partner', fromPerson: 'nod_ada', toPerson: 'nod_will', subtype: 'partner' },
    ])
    const preview = await previewImport('g1', GED)
    const ada = findPerson(preview, 'Ada King')
    expect(ada.suggestedNodeId).toBe('nod_ada')
    expect(ada.candidates[0].reasons.join(' ')).toMatch(/shares 1 relative/)
  })

  it('defaults only one imported person to a shared candidate node', async () => {
    const gedTwins = '0 HEAD\n0 @I1@ INDI\n1 NAME Ada /King/\n0 @I2@ INDI\n1 NAME Ada /King/\n0 TRLR'
    vi.mocked(listNodes).mockResolvedValueOnce([
      node({ nodeId: 'nod_ada', firstName: 'Ada', lastName: 'King' }),
    ])
    const preview = await previewImport('g1', gedTwins)
    const suggested = preview.people.filter((p) => p.suggestedNodeId === 'nod_ada')
    expect(suggested).toHaveLength(1)
  })
})

describe('commitImport', () => {
  it('creates everyone by default and wires relationships', async () => {
    const summary = await commitImport('g1', 'acc_1', GED, {})
    expect(summary.created).toBe(2)
    expect(summary.merged).toBe(0)
    expect(summary.relationshipsCreated).toBe(1)
    expect(putEdgeIfNew).toHaveBeenCalledTimes(1)
    expect(putEdgeIfNew).toHaveBeenCalledWith(
      'g1',
      'acc_1',
      expect.objectContaining({ edgeKind: 'partner', subtype: 'partner' }),
      expect.any(Set),
    )
  })

  it('skips a person and drops relationships that touch them', async () => {
    const summary = await commitImport('g1', 'acc_1', GED, { '@I1@': { action: 'skip' } })
    expect(summary.skipped).toBe(1)
    expect(summary.created).toBe(1)
    expect(summary.relationshipsCreated).toBe(0)
    expect(summary.relationshipsSkipped).toBe(1)
    expect(putEdgeIfNew).not.toHaveBeenCalled()
  })

  it('merges into an existing node, writing only the requested fields', async () => {
    vi.mocked(getNode).mockResolvedValue(
      node({ nodeId: 'nod_existing', firstName: 'Ada', lastName: 'King', birthdate: null, notes: 'Keep me', updatedAt: 't' }),
    )

    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': { action: 'merge', nodeId: 'nod_existing', fields: ['birthdate'], updatedAt: 't' },
    })

    expect(summary.merged).toBe(1)
    expect(summary.created).toBe(1) // William still created
    const patch = vi.mocked(updateNode).mock.calls[0][3]
    expect(patch).toEqual({ birthdate: '1815' })
  })

  it('a relationships-only merge writes no fields but still connects the person', async () => {
    vi.mocked(getNode).mockResolvedValue(node({ nodeId: 'nod_existing', firstName: 'Ada', lastName: 'King', updatedAt: 't' }))
    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': { action: 'merge', nodeId: 'nod_existing', fields: [], updatedAt: 't' },
    })
    expect(summary.merged).toBe(1)
    expect(updateNode).not.toHaveBeenCalled()
    // The partner edge (Ada<->William) is still created against nod_existing.
    expect(summary.relationshipsCreated).toBe(1)
  })

  it('rejects a stale merge when updatedAt has changed since preview', async () => {
    vi.mocked(getNode).mockResolvedValue(node({ nodeId: 'nod_existing', firstName: 'Ada', lastName: 'King', updatedAt: '2024-06-01' }))
    await expect(
      commitImport('g1', 'acc_1', GED, {
        '@I1@': { action: 'merge', nodeId: 'nod_existing', fields: [], updatedAt: '2024-01-01' },
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('counts a duplicate relationship as skipped rather than failing', async () => {
    vi.mocked(listEdges).mockResolvedValueOnce([
      { fromPerson: 'nod_Ada', toPerson: 'nod_William', edgeKind: 'partner', subtype: 'partner' },
    ])
    vi.mocked(putEdgeIfNew).mockResolvedValueOnce(null)
    const summary = await commitImport('g1', 'acc_1', GED, {})
    expect(summary.relationshipsSkipped).toBe(1)
    expect(summary.relationshipsCreated).toBe(0)
  })

  it('falls back to create when a merge target has vanished', async () => {
    vi.mocked(getNode).mockResolvedValueOnce(null)
    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': { action: 'merge', nodeId: 'gone', fields: [], updatedAt: 't' },
    })
    expect(summary.merged).toBe(0)
    expect(summary.created).toBe(2)
  })
})
