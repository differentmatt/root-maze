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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listNodes).mockResolvedValue([])
  vi.mocked(listEdges).mockResolvedValue([])
  vi.mocked(createNode).mockImplementation(async (_g, _a, input) => ({
    nodeId: 'nod_' + input.firstName,
    ...input,
  }))
  vi.mocked(updateNode).mockResolvedValue({})
  vi.mocked(putEdgeIfNew).mockImplementation(async (_g, _a, _input, pairsSeen) => {
    const key = [_input.fromPerson, _input.toPerson].sort().join('|')
    if (pairsSeen.has(key)) return null
    pairsSeen.add(key)
    return {}
  })
})

describe('previewImport', () => {
  it('reports stats, the tree name, and all-new people for an empty group', async () => {
    const preview = await previewImport('g1', GED)
    expect(preview.treeName).toBe('The Family')
    expect(preview.stats).toEqual({
      people: 2,
      relationships: 1,
      matches: 0,
      newPeople: 2,
    })
    expect(preview.people.every((p) => p.match === null)).toBe(true)
  })

  it('suggests a match and splits differences into fills vs conflicts', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      {
        nodeId: 'nod_existing',
        firstName: 'Ada',
        middleName: null,
        lastName: 'King',
        birthdate: '1815',
        deathdate: null,
        notes: 'Old note',
      },
    ])

    const preview = await previewImport('g1', GED)
    const ada = preview.people.find((p) => p.fullName === 'Ada King')
    expect(ada.match.nodeId).toBe('nod_existing')
    // Imported birthdate equals existing -> no conflict there.
    expect(ada.match.conflicts).toHaveLength(0)
    expect(preview.stats.matches).toBe(1)
  })

  it('flags a same-name person with a different birthdate as a conflict', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      {
        nodeId: 'nod_a',
        firstName: 'William',
        middleName: null,
        lastName: 'King',
        birthdate: null,
        deathdate: null,
        notes: null,
      },
    ])
    const preview = await previewImport('g1', GED)
    const will = preview.people.find((p) => p.fullName === 'William King')
    expect(will.match.nodeId).toBe('nod_a')
    // existing has no birthdate; import has none either for William -> no diff.
    expect(will.match.conflicts).toHaveLength(0)
  })

  it('does not suggest a same-name match when birthdates disagree', async () => {
    vi.mocked(listNodes).mockResolvedValueOnce([
      {
        nodeId: 'nod_other',
        firstName: 'Ada',
        middleName: null,
        lastName: 'King',
        birthdate: '1900',
        deathdate: null,
        notes: null,
      },
    ])
    const preview = await previewImport('g1', GED)
    const ada = preview.people.find((p) => p.fullName === 'Ada King')
    expect(ada.match).toBeNull()
  })

  it('matches across a middle-name gap and a year-vs-full-date difference', async () => {
    // The real report: existing "Matt McCabe Lott" (born 1979-05-01) should be
    // recognised when importing "Matt Lott" (born 1979) — the middle name and
    // date precision differ but it's the same person.
    vi.mocked(listNodes).mockResolvedValueOnce([
      {
        nodeId: 'nod_matt',
        firstName: 'Matt',
        middleName: 'McCabe',
        lastName: 'Lott',
        birthdate: '1979-05-01',
        deathdate: null,
        notes: null,
        updatedAt: 't',
      },
    ])
    const ged = '0 HEAD\n0 @I1@ INDI\n1 NAME Matt /Lott/\n1 BIRT\n2 DATE 1979\n0 TRLR'
    const preview = await previewImport('g1', ged)
    const matt = preview.people.find((p) => p.fullName === 'Matt Lott')
    expect(matt.match).not.toBeNull()
    expect(matt.match.nodeId).toBe('nod_matt')
    // The differing birthdate precision is surfaced as a conflict to resolve,
    // not silently overwritten; the existing middle name is left intact.
    expect(matt.match.conflicts.some((c) => c.field === 'birthdate')).toBe(true)
  })

  it('does not suggest the same existing node to two different imported people', async () => {
    // Two imported people with the same name; only one existing node.
    const gedTwins = `0 HEAD\n0 @I1@ INDI\n1 NAME Ada /King/\n0 @I2@ INDI\n1 NAME Ada /King/\n0 TRLR`
    vi.mocked(listNodes).mockResolvedValueOnce([
      {
        nodeId: 'nod_ada',
        firstName: 'Ada',
        middleName: null,
        lastName: 'King',
        birthdate: null,
        deathdate: null,
        notes: null,
        updatedAt: '2024-01-01',
      },
    ])
    const preview = await previewImport('g1', gedTwins)
    const matches = preview.people.filter((p) => p.match !== null)
    // At most one of the two should be matched to the single existing node.
    expect(matches.length).toBe(1)
  })
})

describe('commitImport', () => {
  it('creates everyone by default and wires relationships', async () => {
    const summary = await commitImport('g1', 'acc_1', GED, {})
    expect(summary.created).toBe(2)
    expect(summary.merged).toBe(0)
    expect(summary.relationshipsCreated).toBe(1)
    expect(putEdgeIfNew).toHaveBeenCalledTimes(1)
    expect(putEdgeIfNew).toHaveBeenCalledWith('g1', 'acc_1', expect.objectContaining({
      edgeKind: 'partner',
      subtype: 'partner',
    }), expect.any(Set))
  })

  it('skips a person and drops relationships that touch them', async () => {
    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': { action: 'skip' },
    })
    expect(summary.skipped).toBe(1)
    expect(summary.created).toBe(1)
    // The partner edge needs @I1@, which was skipped -> not created.
    expect(summary.relationshipsCreated).toBe(0)
    expect(summary.relationshipsSkipped).toBe(1)
    expect(putEdgeIfNew).not.toHaveBeenCalled()
  })

  it('merges into an existing node, filling empties and overwriting on request', async () => {
    vi.mocked(getNode).mockResolvedValue({
      nodeId: 'nod_existing',
      firstName: 'Ada',
      middleName: null,
      lastName: 'King',
      birthdate: null, // empty -> import fills it
      deathdate: null,
      notes: 'Keep me',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })

    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': {
        action: 'merge',
        nodeId: 'nod_existing',
        overwrite: ['notes'],
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    })

    expect(summary.merged).toBe(1)
    expect(summary.created).toBe(1) // William still created
    const patch = vi.mocked(updateNode).mock.calls[0][3]
    expect(patch.birthdate).toBe('1815') // filled (was empty)
  })

  it('rejects a stale merge when updatedAt has changed since preview', async () => {
    vi.mocked(getNode).mockResolvedValue({
      nodeId: 'nod_existing',
      firstName: 'Ada',
      middleName: null,
      lastName: 'King',
      birthdate: null,
      deathdate: null,
      notes: null,
      updatedAt: '2024-06-01T00:00:00.000Z', // newer than the preview snapshot
    })

    await expect(
      commitImport('g1', 'acc_1', GED, {
        '@I1@': {
          action: 'merge',
          nodeId: 'nod_existing',
          overwrite: [],
          updatedAt: '2024-01-01T00:00:00.000Z', // stale
        },
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('counts a duplicate relationship as skipped rather than failing', async () => {
    // Simulate an existing edge for the pair that will be imported.
    vi.mocked(listEdges).mockResolvedValueOnce([
      {
        edgeId: 'edge_1',
        fromPerson: 'nod_Ada',
        toPerson: 'nod_William',
        edgeKind: 'partner',
        subtype: 'partner',
        startDate: null,
        endDate: null,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        updatedBy: 'acc_1',
      },
    ])
    // putEdgeIfNew returns null when pair already exists.
    vi.mocked(putEdgeIfNew).mockResolvedValueOnce(null)
    const summary = await commitImport('g1', 'acc_1', GED, {})
    expect(summary.relationshipsSkipped).toBe(1)
    expect(summary.relationshipsCreated).toBe(0)
  })

  it('falls back to create when a merge target has vanished', async () => {
    vi.mocked(getNode).mockResolvedValueOnce(null)
    const summary = await commitImport('g1', 'acc_1', GED, {
      '@I1@': { action: 'merge', nodeId: 'gone', overwrite: [], updatedAt: '2024-01-01' },
    })
    expect(summary.merged).toBe(0)
    expect(summary.created).toBe(2)
  })
})
