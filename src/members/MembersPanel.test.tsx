import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import MembersPanel from './MembersPanel'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getMembers: vi.fn(),
  removeMember: vi.fn(),
  changeMemberRole: vi.fn(),
  getInvites: vi.fn(),
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  getGraph: vi.fn(),
  linkPersonNode: vi.fn(),
  unlinkPersonNode: vi.fn(),
}))

import {
  getMembers,
  removeMember,
  changeMemberRole,
  getInvites,
  createInvite,
  revokeInvite,
  getGraph,
  linkPersonNode,
  unlinkPersonNode,
} from '../api'

const group = { groupId: 'grp_1', name: 'The Lotts', role: 'owner' }

const members = {
  members: [
    {
      accountId: 'acc_1',
      role: 'owner' as const,
      email: 'a@b.com',
      name: 'Ann',
      joinedAt: 't',
      linkedNodeId: null,
      linkedNodeName: null,
    },
    {
      accountId: 'acc_2',
      role: 'editor' as const,
      email: 'b@b.com',
      name: 'Bo',
      joinedAt: 't',
      linkedNodeId: null,
      linkedNodeName: null,
    },
  ],
  me: 'acc_1',
}

const graph = {
  nodes: [
    {
      nodeId: 'nod_1',
      groupId: 'grp_1',
      name: 'Ann Lott',
      birthdate: null,
      deathdate: null,
      notes: null,
      accountId: null,
      createdAt: 't',
      updatedAt: 't',
      updatedBy: 'acc_1',
    },
  ],
  edges: [],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function ready(invites: unknown[] = []) {
  vi.mocked(getMembers).mockResolvedValue(members)
  vi.mocked(getInvites).mockResolvedValue({ invites: invites as never })
  vi.mocked(getGraph).mockResolvedValue(graph as never)
}

describe('MembersPanel', () => {
  it('lists members and marks the current user', async () => {
    ready()
    render(<MembersPanel group={group} />)

    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())
    expect(screen.getByText('Bo')).toBeInTheDocument()
    expect(screen.getByText('(you)')).toBeInTheDocument()
    expect(getMembers).toHaveBeenCalledWith('grp_1')
  })

  it('creates an invite link and reloads', async () => {
    ready()
    vi.mocked(createInvite).mockResolvedValue({
      token: 'tok',
      groupId: 'grp_1',
      role: 'editor',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxUses: null,
      useCount: 0,
      createdAt: 't',
      createdBy: 'acc_1',
    })

    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())

    // First load returned no invites; after creating, reload returns one.
    vi.mocked(getInvites).mockResolvedValue({
      invites: [
        {
          token: 'tok',
          groupId: 'grp_1',
          role: 'editor',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          maxUses: null,
          useCount: 0,
          createdAt: 't',
          createdBy: 'acc_1',
        },
      ],
    })

    fireEvent.click(screen.getByText('New invite link'))
    await waitFor(() => expect(createInvite).toHaveBeenCalledWith('grp_1'))
    await waitFor(() => expect(screen.getByText('Copy link')).toBeInTheDocument())
  })

  it('removes a member', async () => {
    ready()
    vi.mocked(removeMember).mockResolvedValue({ removed: true })
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Bo')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('grp_1', 'acc_2'))
  })

  it('changes a member role', async () => {
    ready()
    vi.mocked(changeMemberRole).mockResolvedValue({ accountId: 'acc_2', role: 'owner' })
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Bo')).toBeInTheDocument())

    const select = screen.getByLabelText('Role for Bo')
    fireEvent.change(select, { target: { value: 'owner' } })
    await waitFor(() =>
      expect(changeMemberRole).toHaveBeenCalledWith('grp_1', 'acc_2', 'owner'),
    )
  })

  it('surfaces a server error (e.g. last-owner guard)', async () => {
    ready()
    const { ApiError } = await import('../api')
    vi.mocked(removeMember).mockRejectedValue(new ApiError(409, 'Cannot remove the last owner'))
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())

    fireEvent.click(screen.getAllByText('Leave')[0])
    await waitFor(() =>
      expect(screen.getByText('Cannot remove the last owner')).toBeInTheDocument(),
    )
  })

  it('links a member to a person via the picker', async () => {
    ready()
    vi.mocked(linkPersonNode).mockResolvedValue({ accountId: 'acc_1', nodeId: 'nod_1' })
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())

    const picker = screen.getByLabelText('Linked person for Ann')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByText('Ann Lott'))
    await waitFor(() =>
      expect(linkPersonNode).toHaveBeenCalledWith('grp_1', 'acc_1', 'nod_1'),
    )
  })

  it('unlinks a linked member by choosing "not linked"', async () => {
    vi.mocked(getMembers).mockResolvedValue({
      members: [
        {
          ...members.members[0],
          linkedNodeId: 'nod_1',
          linkedNodeName: 'Ann Lott',
        },
        members.members[1],
      ],
      me: 'acc_1',
    })
    vi.mocked(getInvites).mockResolvedValue({ invites: [] })
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [{ ...graph.nodes[0], accountId: 'acc_1' }],
      edges: [],
    } as never)
    vi.mocked(unlinkPersonNode).mockResolvedValue({
      accountId: 'acc_1',
      nodeId: 'nod_1',
      unlinked: true,
    })
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())

    const picker = screen.getByLabelText('Linked person for Ann')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByText('— not linked —'))
    await waitFor(() =>
      expect(unlinkPersonNode).toHaveBeenCalledWith('grp_1', 'acc_1'),
    )
  })

  it('revokes an invite', async () => {
    ready([
      {
        token: 'tok',
        groupId: 'grp_1',
        role: 'editor',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        maxUses: null,
        useCount: 0,
        createdAt: 't',
        createdBy: 'acc_1',
      },
    ])
    vi.mocked(revokeInvite).mockResolvedValue({ revoked: true })
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Revoke')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Revoke'))
    await waitFor(() => expect(revokeInvite).toHaveBeenCalledWith('grp_1', 'tok'))
  })
})
