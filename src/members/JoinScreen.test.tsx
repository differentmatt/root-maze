import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import JoinScreen from './JoinScreen'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  previewInvite: vi.fn(),
  acceptInvite: vi.fn(),
}))

import { previewInvite, acceptInvite } from '../api'

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

  it('lets a signed-in visitor accept', async () => {
    vi.mocked(previewInvite).mockResolvedValue({ valid: true, groupName: 'The Lotts' })
    vi.mocked(acceptInvite).mockResolvedValue({
      groupId: 'grp_1',
      name: 'The Lotts',
      role: 'editor',
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
})
