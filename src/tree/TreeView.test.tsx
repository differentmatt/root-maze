import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { Graph } from '../api'
import TreeView from './TreeView'

// Keep the real module (SUBTYPES, ApiError, types) but stub the network calls.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getGraph: vi.fn(),
  createNode: vi.fn(),
  createEdge: vi.fn(),
  deleteEdge: vi.fn(),
}))

import { getGraph } from '../api'

const group = { groupId: 'grp_1', name: 'The Lotts', role: 'owner' }

function person(nodeId: string, name: string) {
  return {
    nodeId,
    groupId: 'grp_1',
    name,
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

  it('opens the edit panel and shows the selected person’s relationships', async () => {
    vi.mocked(getGraph).mockResolvedValue(graph)
    render(<TreeView group={group} />)

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Ada'))

    expect(screen.getByText('Edit person')).toBeInTheDocument()
    // Ada's partner edge is described relative to Ada.
    expect(screen.getByText('partner of Bo')).toBeInTheDocument()
  })
})
