import { describe, expect, it } from 'vitest'
import type { Edge, Graph, Member, PersonNode } from '../api'
import { rankLinkCandidates, rankRelationshipCandidates } from './personRanking'

function node(nodeId: string, name: string, extra: Partial<PersonNode> = {}): PersonNode {
  const [firstName, ...restName] = name.split(' ')
  return {
    nodeId,
    groupId: 'g',
    name,
    firstName,
    lastName: restName.join(' ') || null,
    middleName: null,
    birthName: null,
    birthdate: null,
    deathdate: null,
    notes: null,
    accountId: null,
    createdAt: '',
    updatedAt: '',
    updatedBy: '',
    ...extra,
  }
}

let edgeSeq = 0
function edge(
  kind: Edge['edgeKind'],
  fromPerson: string,
  toPerson: string,
): Edge {
  return {
    edgeId: `e${edgeSeq++}`,
    groupId: 'g',
    edgeKind: kind,
    fromPerson,
    toPerson,
    subtype: '',
    startDate: null,
    endDate: null,
    createdAt: '',
    updatedAt: '',
    updatedBy: '',
  }
}

function member(m: Partial<Member>): Member {
  return {
    accountId: 'acct',
    role: 'editor',
    email: null,
    name: null,
    joinedAt: '',
    linkedNodeId: null,
    linkedNodeName: null,
    ...m,
  }
}

describe('rankRelationshipCandidates', () => {
  it('suggests the partner of an existing parent when adding a parent', () => {
    // kid's parent is Ada; Ada's partner is Bob → Bob is the likely other parent.
    const kid = node('kid', 'Kid Smith')
    const ada = node('ada', 'Ada Smith')
    const bob = node('bob', 'Bob Jones')
    const stranger = node('str', 'Zed Stranger')
    const graph: Graph = {
      nodes: [kid, ada, bob, stranger],
      edges: [edge('parent_child', 'ada', 'kid'), edge('partner', 'ada', 'bob')],
    }
    // Candidates exclude the reference person + already-connected (Ada).
    const candidates = [bob, stranger]
    const { suggested, rest } = rankRelationshipCandidates(
      graph,
      kid,
      'child_of',
      candidates,
    )
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['bob'])
    expect(suggested[0].hint).toBe('partner of Ada Smith')
    expect(rest.map((n) => n.nodeId)).toEqual(['str'])
  })

  it("suggests a partner's child when adding a child", () => {
    const dad = node('dad', 'Dad Smith')
    const mom = node('mom', 'Mom Smith')
    const kid = node('kid', 'Kid Smith')
    const other = node('oth', 'Zed Other')
    const graph: Graph = {
      nodes: [dad, mom, kid, other],
      edges: [edge('partner', 'dad', 'mom'), edge('parent_child', 'mom', 'kid')],
    }
    const { suggested } = rankRelationshipCandidates(graph, dad, 'parent_of', [
      kid,
      other,
    ])
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['kid'])
    expect(suggested[0].hint).toBe('child of Mom Smith')
  })

  it('suggests a co-parent when adding a partner', () => {
    const dad = node('dad', 'Dad Smith')
    const mom = node('mom', 'Mom Jones')
    const kid = node('kid', 'Kid Smith')
    const other = node('oth', 'Zed Other')
    const graph: Graph = {
      nodes: [dad, mom, kid, other],
      edges: [
        edge('parent_child', 'dad', 'kid'),
        edge('parent_child', 'mom', 'kid'),
      ],
    }
    const { suggested } = rankRelationshipCandidates(graph, dad, 'partner_of', [
      mom,
      other,
    ])
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['mom'])
    expect(suggested[0].hint).toBe('parent of Kid Smith')
  })

  it('falls back to a clean alphabetical rest when there is no signal', () => {
    const a = node('a', 'Ada Zephyr')
    const b = node('b', 'Bob Alpha')
    const c = node('c', 'Cara Mid')
    const person = node('p', 'Lone Person')
    const graph: Graph = { nodes: [a, b, c, person], edges: [] }
    const { suggested, rest } = rankRelationshipCandidates(
      graph,
      person,
      'child_of',
      [c, a, b],
    )
    expect(suggested).toEqual([])
    expect(rest.map((n) => n.nodeId)).toEqual(['a', 'b', 'c'])
  })

  it('boosts a shared surname above unrelated people', () => {
    const person = node('p', 'Pat Rivers')
    const same = node('s', 'Sam Rivers')
    const diff = node('d', 'Dan Ocean')
    const graph: Graph = { nodes: [person, same, diff], edges: [] }
    const { suggested } = rankRelationshipCandidates(graph, person, 'partner_of', [
      diff,
      same,
    ])
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['s'])
    expect(suggested[0].hint).toBe('same last name')
  })
})

describe('rankLinkCandidates', () => {
  it('surfaces the node whose name matches the member name', () => {
    const nodes = [
      node('a', 'Ada Lovelace'),
      node('b', 'Bob Byron'),
      node('c', 'Cara Stone'),
    ]
    const { suggested, rest } = rankLinkCandidates(
      member({ name: 'Bob Byron' }),
      nodes,
    )
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['b'])
    expect(rest.map((n) => n.nodeId)).toEqual(['a', 'c'])
  })

  it('matches on the email local part when there is no name', () => {
    const nodes = [node('a', 'Ada Lovelace'), node('b', 'Bob Byron')]
    const { suggested } = rankLinkCandidates(
      member({ email: 'ada.lovelace@example.com' }),
      nodes,
    )
    expect(suggested.map((s) => s.node.nodeId)).toEqual(['a'])
  })

  it('returns everyone alphabetically with no suggestions when nothing matches', () => {
    const nodes = [node('b', 'Bob Byron'), node('a', 'Ada Lovelace')]
    const { suggested, rest } = rankLinkCandidates(
      member({ name: 'Zoltan Nomatch' }),
      nodes,
    )
    expect(suggested).toEqual([])
    expect(rest.map((n) => n.nodeId)).toEqual(['a', 'b'])
  })
})
