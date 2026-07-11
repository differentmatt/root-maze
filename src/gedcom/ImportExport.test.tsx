import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ImportExport from './ImportExport'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
  exportGedcom: vi.fn(),
  createGroup: vi.fn(),
}))

import { previewImport, commitImport } from '../api'

const group = { groupId: 'grp_1', name: 'The Lotts', role: 'owner' }

// A .text()-capable File stand-in (jsdom's File.text is unreliable here).
function gedcomFile(contents: string) {
  return { name: 'tree.ged', text: async () => contents } as unknown as File
}

function pickFile(labelMatch: RegExp, contents: string) {
  const label = screen.getByText(labelMatch)
  const input = label.closest('label')!.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { value: [gedcomFile(contents)], configurable: true })
  fireEvent.change(input)
}

const previewWithConflict = {
  treeName: 'Imported Tree',
  stats: { people: 2, relationships: 1, matches: 1, newPeople: 1 },
  people: [
    {
      xref: '@I1@',
      fullName: 'Ada King',
      fields: {
        firstName: 'Ada',
        middleName: null,
        lastName: 'King',
        birthdate: '1815',
        deathdate: null,
        notes: null,
      },
      match: {
        nodeId: 'nod_existing',
        name: 'Ada King',
        updatedAt: '2024-01-01T00:00:00.000Z',
        fills: [],
        conflicts: [{ field: 'birthdate' as const, existing: '1820', imported: '1815' }],
      },
    },
    {
      xref: '@I2@',
      fullName: 'New Person',
      fields: {
        firstName: 'New',
        middleName: null,
        lastName: 'Person',
        birthdate: null,
        deathdate: null,
        notes: null,
      },
      match: null,
    },
  ],
}

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

describe('ImportExport review flow', () => {
  it('defaults a matched person to merge (keep current) and leaves new people to create', async () => {
    vi.mocked(previewImport).mockResolvedValue(previewWithConflict)
    vi.mocked(commitImport).mockResolvedValue({
      created: 1,
      merged: 1,
      skipped: 0,
      relationshipsCreated: 1,
      relationshipsSkipped: 0,
    })

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD\n0 TRLR')

    // The review panel appears with the conflict surfaced.
    await screen.findByText('Review import')
    expect(screen.getByText(/Birth date differs/)).toBeInTheDocument()
    expect(screen.getByText(/New people \(1\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    const [, gedcom, resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(gedcom).toBe('0 HEAD\n0 TRLR')
    // Default: merge with no overwrites for the matched person.
    expect(resolutions['@I1@']).toEqual({
      action: 'merge',
      nodeId: 'nod_existing',
      updatedAt: '2024-01-01T00:00:00.000Z',
      overwrite: [],
    })
    // Unmatched person gets an explicit create resolution.
    expect(resolutions['@I2@']).toEqual({ action: 'create' })
    await screen.findByText(/Imported 1 new/)
  })

  it('overwrites a conflicting field when "Use imported" is chosen', async () => {
    vi.mocked(previewImport).mockResolvedValue(previewWithConflict)
    vi.mocked(commitImport).mockResolvedValue({
      created: 1,
      merged: 1,
      skipped: 0,
      relationshipsCreated: 1,
      relationshipsSkipped: 0,
    })

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    fireEvent.click(screen.getByLabelText(/Use imported/))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(resolutions['@I1@']).toEqual({
      action: 'merge',
      nodeId: 'nod_existing',
      updatedAt: '2024-01-01T00:00:00.000Z',
      overwrite: ['birthdate'],
    })
  })

  it('skips a matched person when Skip is chosen', async () => {
    vi.mocked(previewImport).mockResolvedValue(previewWithConflict)
    vi.mocked(commitImport).mockResolvedValue({
      created: 1,
      merged: 0,
      skipped: 1,
      relationshipsCreated: 0,
      relationshipsSkipped: 1,
    })

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(resolutions['@I1@']).toEqual({ action: 'skip' })
  })

  it('skips an unmatched (fresh) person when Skip is chosen', async () => {
    vi.mocked(previewImport).mockResolvedValue(previewWithConflict)
    vi.mocked(commitImport).mockResolvedValue({
      created: 1,
      merged: 1,
      skipped: 1,
      relationshipsCreated: 0,
      relationshipsSkipped: 1,
    })

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    // The fresh person row has an "Add" (create) and "skip" button.
    const skipButtons = screen.getAllByRole('button', { name: /^skip$/i })
    // There should be a skip button for both the matched person and the fresh person.
    expect(skipButtons.length).toBeGreaterThanOrEqual(1)
    // Click the skip button associated with the fresh person (New Person row).
    const freshPersonRow = screen.getByText('New Person').closest('div')!
    const skipBtn = freshPersonRow.querySelector('button[class*="text-zinc"]')
    // Use the second skip button (index 1) for the fresh row.
    fireEvent.click(skipButtons[skipButtons.length - 1])
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(resolutions['@I2@']).toEqual({ action: 'skip' })
  })
})
