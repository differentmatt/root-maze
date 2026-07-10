import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { Graph } from '../api'
import TreeView from './TreeView'
import { inferSiblings } from './siblings'

// Keep the real module (SUBTYPES, ApiError, types) but stub the network calls.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getGraph: vi.fn(),
  getMembers: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  createEdge: vi.fn(),
  deleteEdge: vi.fn(),
  linkPersonNode: vi.fn(),
  unlinkPersonNode: vi.fn(),
}))

import { getGraph, getMembers, updateNode, deleteNode, linkPersonNode } from '../api'

const group = { groupId: 'grp_1', name: 'The Lotts', role: 'owner' }

function person(nodeId: string, name: string) {
  const [firstName, ...rest] = name.split(' ')
  return {
    nodeId,
    groupId: 'grp_1',
    name,
    firstName,
    lastName: rest.join(' ') || null,
    middleName: null,
    birthName: null,
    birthdate: null,
    deathdate: null,
    notes: null,
    accountId: null,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'acc_1',
  }
}

const graph: Graph = {
  nodes: [person('nod_a', 'Ada'), person('nod_b', 'Bo')],
  edges: [
    {
      edgeId: 'edg_1',
      groupId: 'grp_1',
      edgeKind: 'partner',
      fromPerson: 'nod_a',
      toPerson: 'nod_b',
      subtype: 'married',
      startDate: null,
      endDate: null,
      createdAt: 't',
      updatedAt: 't',
      updatedBy: 'acc_1',
    },
  ],
}

// TreeView fetches members alongside the graph (for who's who); default to an
// empty roster so the graph drives each test unless overridden.
beforeEach(() => {
  vi.mocked(getMembers).mockResolvedValue({ members: [], me: 'acc_1' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TreeView', () => {
  it('loads the graph and renders people plus the add-person form', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    expect(screen.getByText('Bo')).toBeInTheDocument()
    expect(screen.getByText('Add a person')).toBeInTheDocument()
    expect(getGraph).toHaveBeenCalledWith('grp_1')
  })

  it('shows a loading state until the graph resolves', async () => {
    let resolve!: (g: Graph) => void
    vi.mocked(getGraph).mockReturnValue(
      new Promise<Graph>((r) => {
        resolve = r
      }),
    )
    render(<TreeView group={group} />)

    expect(screen.getByText('Loading family graph…')).toBeInTheDocument()
    // The graph and add-person form aren't shown yet.
    expect(screen.queryByText('Add a person')).not.toBeInTheDocument()

    resolve(graph)
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    expect(screen.queryByText('Loading family graph…')).not.toBeInTheDocument()
  })

  it('opens the edit panel and shows the selected person’s relationships', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    // The edit panel is open: its first-name field is seeded with Ada.
    expect(screen.getByDisplayValue('Ada')).toBeInTheDocument()
    // Ada's partner edge is described relative to Ada.
    expect(screen.getByText('partner of Bo')).toBeInTheDocument()
    // The add-person form is hidden while editing a person.
    expect(screen.queryByText('Add a person')).not.toBeInTheDocument()
  })

  it('auto-saves an edited field after a pause (no Save button)', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    vi.mocked(updateNode).mockResolvedValue(graph.nodes[0])
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('Ada'), {
      target: { value: 'Adele' },
    })
    await waitFor(
      () =>
        expect(updateNode).toHaveBeenCalledWith(
          'grp_1',
          'nod_a',
          expect.objectContaining({ firstName: 'Adele' }),
        ),
      { timeout: 2000 },
    )
  })

  it('claims a person as yourself via "This is me"', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    vi.mocked(linkPersonNode).mockResolvedValue({ accountId: 'acc_1', nodeId: 'nod_a' })
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    fireEvent.click(screen.getByRole('button', { name: 'This is me' }))
    await waitFor(() =>
      expect(linkPersonNode).toHaveBeenCalledWith('grp_1', 'acc_1', 'nod_a'),
    )
  })

  it('hides "This is me" when the caller is already linked elsewhere', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    // The caller is already linked to Bo, so Ada must not offer "This is me".
    vi.mocked(getMembers).mockResolvedValue({
      members: [
        {
          accountId: 'acc_1',
          role: 'owner',
          email: 'a@b.com',
          name: 'Ann',
          joinedAt: 't',
          linkedNodeId: 'nod_b',
          linkedNodeName: 'Bo',
        },
      ],
      me: 'acc_1',
    })
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    expect(
      screen.queryByRole('button', { name: 'This is me' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Unlink there first/)).toBeInTheDocument()
  })

  it('requires confirmation before deleting a person', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    vi.mocked(deleteNode).mockResolvedValue({ deleted: true })
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    fireEvent.click(screen.getByText('Delete person'))
    expect(screen.getByText(/Delete Ada\?/)).toBeInTheDocument()
    expect(deleteNode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(deleteNode).toHaveBeenCalledWith('grp_1', 'nod_a'),
    )
  })
})

describe('inferSiblings', () => {
  // mom & dad are the parents; kid1/kid2 share both, kid3 shares only mom.
  function parentEdge(id: string, from: string, to: string): Graph['edges'][number] {
    return {
      edgeId: id, groupId: 'g', edgeKind: 'parent_child', fromPerson: from,
      toPerson: to, subtype: 'biological', startDate: null, endDate: null,
      createdAt: 't', updatedAt: 't', updatedBy: 'a',
    }
  }
  const g: Graph = {
    nodes: ['mom', 'dad', 'kid1', 'kid2', 'kid3'].map((id) => person(id, id)),
    edges: [
      parentEdge('e1', 'mom', 'kid1'),
      parentEdge('e2', 'dad', 'kid1'),
      parentEdge('e3', 'mom', 'kid2'),
      parentEdge('e4', 'dad', 'kid2'),
      parentEdge('e5', 'mom', 'kid3'),
    ],
  }

  it('reports full siblings when the parent sets match', () => {
    const sibs = inferSiblings(g, 'kid1')
    expect(sibs.find((s) => s.nodeId === 'kid2')).toMatchObject({ half: false })
  })

  it('reports half siblings on partial parent overlap', () => {
    const sibs = inferSiblings(g, 'kid1')
    expect(sibs.find((s) => s.nodeId === 'kid3')).toMatchObject({ half: true })
  })

  it('returns nothing for a person with no parents', () => {
    expect(inferSiblings(g, 'mom')).toEqual([])
  })
})
