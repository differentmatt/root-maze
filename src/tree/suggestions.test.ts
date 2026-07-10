import { describe, expect, it } from 'vitest'
import { suggestOtherParents } from './suggestions'
import type { Edge, Graph, PersonNode } from '../api'

function node(nodeId: string, name: string): PersonNode {
  return {
    nodeId,
    groupId: 'g',
    name,
    firstName: name,
    lastName: null,
    middleName: null,
    birthName: null,
    birthdate: null,
    deathdate: null,
    notes: null,
    accountId: null,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'a',
  }
}

function parentEdge(parent: string, child: string): Edge {
  return {
    edgeId: `pc_${parent}_${child}`,
    groupId: 'g',
    edgeKind: 'parent_child',
    fromPerson: parent,
    toPerson: child,
    subtype: 'biological',
    startDate: null,
    endDate: null,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'a',
  }
}

function partnerEdge(a: string, b: string): Edge {
  return {
    edgeId: `pt_${a}_${b}`,
    groupId: 'g',
    edgeKind: 'partner',
    fromPerson: a,
    toPerson: b,
    subtype: 'married',
    startDate: null,
    endDate: null,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'a',
  }
}

describe('suggestOtherParents', () => {
  it('suggests the partner of an existing parent', () => {
    // Kid has parent Ada; Ada is partnered with Bob -> Bob is a likely parent.
    const graph: Graph = {
      nodes: [node('kid', 'Kid'), node('ada', 'Ada'), node('bob', 'Bob')],
      edges: [parentEdge('ada', 'kid'), partnerEdge('ada', 'bob')],
    }
    const out = suggestOtherParents(graph, 'kid')
    expect(out).toEqual([{ nodeId: 'bob', name: 'Bob', viaParentName: 'Ada' }])
  })

  it('returns nothing when the person has no parents', () => {
    const graph: Graph = {
      nodes: [node('kid', 'Kid'), node('ada', 'Ada')],
      edges: [partnerEdge('ada', 'kid')],
    }
    expect(suggestOtherParents(graph, 'kid')).toEqual([])
  })

  it('does not suggest someone who is already a parent', () => {
    // Both Ada and Bob are parents already; Bob shouldn't be re-suggested.
    const graph: Graph = {
      nodes: [node('kid', 'Kid'), node('ada', 'Ada'), node('bob', 'Bob')],
      edges: [
        parentEdge('ada', 'kid'),
        parentEdge('bob', 'kid'),
        partnerEdge('ada', 'bob'),
      ],
    }
    expect(suggestOtherParents(graph, 'kid')).toEqual([])
  })

  it('honours the exclude set', () => {
    const graph: Graph = {
      nodes: [node('kid', 'Kid'), node('ada', 'Ada'), node('bob', 'Bob')],
      edges: [parentEdge('ada', 'kid'), partnerEdge('ada', 'bob')],
    }
    expect(suggestOtherParents(graph, 'kid', new Set(['bob']))).toEqual([])
  })

  it('de-dupes a partner shared across parents', () => {
    // Contrived: Bob partners both parents; still one suggestion.
    const graph: Graph = {
      nodes: [
        node('kid', 'Kid'),
        node('ada', 'Ada'),
        node('cara', 'Cara'),
        node('bob', 'Bob'),
      ],
      edges: [
        parentEdge('ada', 'kid'),
        parentEdge('cara', 'kid'),
        partnerEdge('ada', 'bob'),
        partnerEdge('cara', 'bob'),
      ],
    }
    const out = suggestOtherParents(graph, 'kid')
    expect(out).toHaveLength(1)
    expect(out[0].nodeId).toBe('bob')
  })
})
