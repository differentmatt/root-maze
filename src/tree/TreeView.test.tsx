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

import { getGraph, getMembers, createNode, updateNode, deleteNode, linkPersonNode } from '../api'

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

function quadPath(path: SVGPathElement) {
  const d = path.getAttribute('d') ?? ''
  expect(d).toContain(' Q ')
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  expect(nums).toHaveLength(6)
  const [x1, y1, mx, my, x2, y2] = nums!
  return { x1, y1, mx, my, x2, y2 }
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

const legacyPerson = {
  nodeId: 'nod_legacy',
  groupId: 'grp_1',
  name: 'Mary Anne Van Der Berg',
  firstName: null,
  lastName: null,
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

  it('does not migrate a legacy name when auto-saving unrelated fields', async () => {
    vi.mocked(getGraph).mockResolvedValue({ nodes: [legacyPerson], edges: [] })
    vi.mocked(updateNode).mockResolvedValue(legacyPerson)
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Mary')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Mary'))
    fireEvent.change(screen.getByPlaceholderText('Anything worth remembering'), {
      target: { value: 'Keeps legacy name' },
    })

    await waitFor(
      () =>
        expect(updateNode).toHaveBeenCalledWith('grp_1', 'nod_legacy', {
          notes: 'Keeps legacy name',
        }),
      { timeout: 2000 },
    )
  })

  it('keeps the full name in the graph node aria-label', async () => {
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [person('nod_a', 'Ada Lovelace')],
      edges: [],
    })
    render(<TreeView group={group} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeInTheDocument(),
    )
    expect(screen.getByText('Ada L.')).toBeInTheDocument()
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

  it('renders family junctions and draws every descendant edge the same (no dashing by subtype) in Graph mode', async () => {
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [
        person('nod_a', 'Ada'),
        person('nod_b', 'Bo'),
        person('nod_c', 'Cy'),
      ],
      edges: [
        {
          edgeId: 'edg_partner',
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
        {
          edgeId: 'edg_parent_1',
          groupId: 'grp_1',
          edgeKind: 'parent_child',
          fromPerson: 'nod_a',
          toPerson: 'nod_c',
          subtype: 'foster',
          startDate: null,
          endDate: null,
          createdAt: 't',
          updatedAt: 't',
          updatedBy: 'acc_1',
        },
        {
          edgeId: 'edg_parent_2',
          groupId: 'grp_1',
          edgeKind: 'parent_child',
          fromPerson: 'nod_b',
          toPerson: 'nod_c',
          subtype: 'foster',
          startDate: null,
          endDate: null,
          createdAt: 't',
          updatedAt: 't',
          updatedBy: 'acc_1',
        },
      ],
    })
    const { container } = render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))

    const svg = screen.getByRole('img', { name: 'Family graph' })
    expect(svg).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(container.querySelector('circle[r="4"][fill="#52525b"]')).not.toBeNull()
    // Cy is a foster child of both Ada and Bo, but descendant edges no longer
    // vary by subtype — the family→child curves render solid, like every other.
    const descendantCurves = container.querySelectorAll('path[stroke="#38bdf8"]')
    expect(descendantCurves.length).toBeGreaterThan(0)
    for (const path of Array.from(descendantCurves)) {
      expect(path.getAttribute('stroke-dasharray')).toBeNull()
    }
  })

  it('marks lineage direction with a mid-edge arrow on each descendant line in Graph mode', async () => {
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [
        person('nod_a', 'Ada'),
        person('nod_b', 'Bo'),
        person('nod_c', 'Cy'),
        person('nod_d', 'Di'),
      ],
      edges: [
        {
          edgeId: 'edg_partner',
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
        ...['nod_c', 'nod_d'].flatMap((child, i) =>
          ['nod_a', 'nod_b'].map((parent, j) => ({
            edgeId: `edg_pc_${i}_${j}`,
            groupId: 'grp_1',
            edgeKind: 'parent_child' as const,
            fromPerson: parent,
            toPerson: child,
            subtype: 'biological',
            startDate: null,
            endDate: null,
            createdAt: 't',
            updatedAt: 't',
            updatedBy: 'acc_1',
          })),
        ),
      ],
    })
    const { container } = render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))

    // The arrow marker is defined, and there is one lineage arrow per
    // family→child line (Ada+Bo → Cy and → Di = two children = two arrows).
    expect(container.querySelector('marker#lineage')).not.toBeNull()
    expect(
      container.querySelectorAll('line[marker-end="url(#lineage)"]'),
    ).toHaveLength(2)
  })

  it('renders partner edges as consistently bowed quadratic paths regardless of endpoint order', async () => {
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [person('nod_a', 'Ada'), person('nod_b', 'Bo'), person('nod_c', 'Cy')],
      edges: [
        {
          edgeId: 'edg_left',
          groupId: 'grp_1',
          edgeKind: 'partner',
          fromPerson: 'nod_b',
          toPerson: 'nod_a',
          subtype: 'married',
          startDate: null,
          endDate: null,
          createdAt: 't',
          updatedAt: 't',
          updatedBy: 'acc_1',
        },
        {
          edgeId: 'edg_right',
          groupId: 'grp_1',
          edgeKind: 'partner',
          fromPerson: 'nod_c',
          toPerson: 'nod_b',
          subtype: 'married',
          startDate: null,
          endDate: null,
          createdAt: 't',
          updatedAt: 't',
          updatedBy: 'acc_1',
        },
      ],
    })
    const { container } = render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))

    await waitFor(() =>
      expect(container.querySelectorAll('path[stroke="#fb7185"]')).toHaveLength(2),
    )
    for (const path of Array.from(container.querySelectorAll<SVGPathElement>('path[stroke="#fb7185"]'))) {
      const { x1, y1, mx, my, x2, y2 } = quadPath(path)
      const midX = (x1 + x2) / 2
      const midY = (y1 + y2) / 2
      expect(my).toBeLessThanOrEqual(midY + 0.01)
      if (Math.abs(my - midY) <= 0.01) expect(mx).toBeGreaterThan(midX)
    }
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

  it('confirms before deleting a person, and aborts if declined', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    vi.mocked(deleteNode).mockResolvedValue({ deleted: true })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    // Declining the confirmation does not delete.
    fireEvent.click(screen.getByText('Delete person'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Delete Ada\?/))
    expect(deleteNode).not.toHaveBeenCalled()

    // Accepting it deletes.
    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByText('Delete person'))
    await waitFor(() => expect(deleteNode).toHaveBeenCalledWith('grp_1', 'nod_a'))

    confirmSpy.mockRestore()
  })

  it('shows "Opening person…" while the reload is pending, then opens the edit panel', async () => {
    const newPerson = person('nod_new', 'Eve')
    const updatedGraph: Graph = { nodes: [...graph.nodes, newPerson], edges: graph.edges }

    let resolveReload!: (g: Graph) => void
    vi.mocked(getGraph)
      .mockResolvedValueOnce(graph)
      .mockReturnValueOnce(new Promise<Graph>((r) => { resolveReload = r }))
    vi.mocked(createNode).mockResolvedValue(newPerson)

    render(<TreeView group={group} />)
    await waitFor(() => expect(screen.getByText('Add a person')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('e.g. Ada'), { target: { value: 'Eve' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }))

    // While the reload is pending, the wait indicator is shown and the add form is gone.
    await waitFor(() => expect(screen.getByText('Opening person…')).toBeInTheDocument())
    expect(screen.queryByText('Add a person')).not.toBeInTheDocument()

    // Resolve the reload with the graph that now includes the new person.
    resolveReload(updatedGraph)

    // The edit panel for Eve should open and the wait indicator should disappear.
    await waitFor(() => expect(screen.getByDisplayValue('Eve')).toBeInTheDocument())
    expect(screen.queryByText('Opening person…')).not.toBeInTheDocument()
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
