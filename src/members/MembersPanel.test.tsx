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
}))

import {
  getMembers,
  removeMember,
  changeMemberRole,
  getInvites,
  createInvite,
  revokeInvite,
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function ready(invites: unknown[] = []) {
  vi.mocked(getMembers).mockResolvedValue(members)
  vi.mocked(getInvites).mockResolvedValue({ invites: invites as never })
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

  it('shows a linked member as read-only (no linking control)', async () => {
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
    render(<MembersPanel group={group} />)
    await waitFor(() => expect(screen.getByText('Ann')).toBeInTheDocument())

    // The member's linked person is surfaced read-only…
    expect(screen.getByText('Ann Lott')).toBeInTheDocument()
    // …and there is no person picker/dropdown to edit the link here.
    expect(screen.queryByLabelText(/Linked person for/)).not.toBeInTheDocument()
    expect(screen.queryByText('Link a person…')).not.toBeInTheDocument()
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
