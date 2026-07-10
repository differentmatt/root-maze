import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import JoinScreen from './JoinScreen'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  previewInvite: vi.fn(),
  acceptInvite: vi.fn(),
  getMe: vi.fn(),
  getGraph: vi.fn(),
  linkPersonNode: vi.fn(),
}))

import { previewInvite, acceptInvite, getMe, getGraph, linkPersonNode } from '../api'

function person(nodeId: string, name: string, accountId: string | null = null) {
  const [firstName, ...rest] = name.split(' ')
  return {
    nodeId,
    groupId: 'grp_1',
    name,
    firstName,
    lastName: rest.join(' ') || null,
    middleName: null,
    maidenName: null,
    birthdate: null,
    deathdate: null,
    notes: null,
    accountId,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'acc_1',
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('JoinScreen', () => {
  it('shows an invalid-invite message for a spent token', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: false })
    render(<JoinScreen token="tok" signedIn={false} />)
    await waitFor(() =>
      expect(screen.getByText(/no longer valid/i)).toBeInTheDocument(),
    )
    expect(acceptInvite).not.toHaveBeenCalled()
  })

  it('prompts a signed-out visitor to sign in', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: true, groupName: 'The Lotts' })
    render(<JoinScreen token="tok" signedIn={false} />)
    await waitFor(() =>
      expect(screen.getByText(/You've been invited to join/)).toBeInTheDocument(),
    )
    expect(screen.getByText('The Lotts')).toBeInTheDocument()
    expect(screen.getByText('Sign in to join.')).toBeInTheDocument()
  })

  it('lets a signed-in visitor accept (no unclaimed people → straight to app)', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: true, groupName: 'The Lotts' })
    vi.mocked(acceptInvite).mockResolvedValue({
      groupId: 'grp_1',
      name: 'The Lotts',
      role: 'editor',
    })
    vi.mocked(getMe).mockResolvedValue({ accountId: 'acc_9', email: null, groups: [] })
    // Every person is already claimed → no link step, redirect straight in.
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [person('nod_1', 'Ada', 'acc_1')],
      edges: [],
    })
    // Stub navigation so the redirect on success doesn't hit jsdom.
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost', href: '' },
      writable: true,
    })

    render(<JoinScreen token="tok" signedIn={true} />)
    await waitFor(() =>
      expect(screen.getByText('Join The Lotts')).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByText('Join The Lotts'))
    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith('tok'))
  })

  it('offers a "which person are you?" step when unclaimed people exist', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: true, groupName: 'The Lotts' })
    vi.mocked(acceptInvite).mockResolvedValue({
      groupId: 'grp_1',
      name: 'The Lotts',
      role: 'editor',
    })
    vi.mocked(getMe).mockResolvedValue({ accountId: 'acc_9', email: null, groups: [] })
    vi.mocked(getGraph).mockResolvedValue({
      nodes: [person('nod_1', 'Ada'), person('nod_2', 'Bo', 'acc_1')],
      edges: [],
    })
    vi.mocked(linkPersonNode).mockResolvedValue({ accountId: 'acc_9', nodeId: 'nod_1' })
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost', href: '' },
      writable: true,
    })

    render(<JoinScreen token="tok" signedIn={true} />)
    await waitFor(() =>
      expect(screen.getByText('Join The Lotts')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByText('Join The Lotts'))

    // The claim step appears; only the unclaimed person (Ada) is offered.
    await waitFor(() =>
      expect(screen.getByText(/Which person in the tree are you/)).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText('Which person are you?'), {
      target: { value: 'nod_1' },
    })
    fireEvent.click(screen.getByRole('button', { name: "That's me" }))
    await waitFor(() =>
      expect(linkPersonNode).toHaveBeenCalledWith('grp_1', 'acc_9', 'nod_1'),
    )
  })

  it('falls through to the app when the post-join fetch fails', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: true, groupName: 'The Lotts' })
    vi.mocked(acceptInvite).mockResolvedValue({
      groupId: 'grp_1',
      name: 'The Lotts',
      role: 'editor',
    })
    vi.mocked(getMe).mockRejectedValue(new Error('network blip'))
    vi.mocked(getGraph).mockResolvedValue({ nodes: [], edges: [] })
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost', href: '' },
      writable: true,
    })

    render(<JoinScreen token="tok" signedIn={true} />)
    await waitFor(() =>
      expect(screen.getByText('Join The Lotts')).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByText('Join The Lotts'))
    await waitFor(() =>
      expect(window.location.href).toBe('http://localhost/'),
    )
    expect(screen.queryByText(/Could not join/i)).not.toBeInTheDocument()
  })
})
