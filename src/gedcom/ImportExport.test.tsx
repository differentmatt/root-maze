import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
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

function gedcomFile(contents: string) {
  return { name: 'tree.ged', text: async () => contents } as unknown as File
}

function pickFile(labelMatch: RegExp, contents: string) {
  const label = screen.getByText(labelMatch)
  const input = label.closest('label')!.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { value: [gedcomFile(contents)], configurable: true })
  fireEvent.change(input)
}

const commitOk = {
  created: 1,
  merged: 1,
  skipped: 0,
  relationshipsCreated: 1,
  relationshipsSkipped: 0,
}

// One strong (suggested) match with a fill + a conflict + a tree-only field,
// plus one brand-new person.
const preview = {
  treeName: 'Imported',
  stats: { people: 2, relationships: 1, strongMatches: 1, possibleMatches: 0, newPeople: 1 },
  people: [
    {
      xref: '@I1@',
      fullName: 'Matt Lott',
      fields: { firstName: 'Matt', middleName: null, lastName: 'Lott', birthdate: '1979', deathdate: '2020', notes: null },
      suggestedNodeId: 'nod_matt',
      candidates: [
        {
          nodeId: 'nod_matt',
          name: 'Matt McCabe Lott',
          fields: { firstName: 'Matt', middleName: 'McCabe', lastName: 'Lott', birthdate: '1979-05-01', deathdate: null, notes: null },
          score: 10,
          tier: 'strong' as const,
          reasons: ['same surname', 'same first name'],
          updatedAt: '2024-01-01T00:00:00.000Z',
          fieldDiffs: [
            { field: 'birthdate' as const, status: 'conflict' as const, existing: '1979-05-01', imported: '1979' },
            { field: 'deathdate' as const, status: 'fill' as const, existing: null, imported: '2020' },
            { field: 'middleName' as const, status: 'treeOnly' as const, existing: 'McCabe', imported: null },
          ],
        },
      ],
      relationships: [{ relation: 'partner' as const, otherName: 'Maryann Vellanikaran' }],
    },
    {
      xref: '@I2@',
      fullName: 'New Person',
      fields: { firstName: 'New', middleName: null, lastName: 'Person', birthdate: null, deathdate: null, notes: null },
      suggestedNodeId: null,
      candidates: [],
      relationships: [],
    },
  ],
}

// The multi-candidate ambiguous case.
const twoCandidatePreview = {
  treeName: null,
  stats: { people: 1, relationships: 0, strongMatches: 0, possibleMatches: 1, newPeople: 0 },
  people: [
    {
      xref: '@I1@',
      fullName: 'Jim Lott',
      fields: { firstName: 'Jim', middleName: null, lastName: 'Lott', birthdate: null, deathdate: null, notes: null },
      suggestedNodeId: null,
      candidates: [
        {
          nodeId: 'nod_a', name: 'Jim Lott (1910)',
          fields: { firstName: 'Jim', middleName: null, lastName: 'Lott', birthdate: '1910', deathdate: null, notes: null },
          score: 5, tier: 'possible' as const, reasons: ['same surname', 'same first name'],
          updatedAt: 't-a', fieldDiffs: [],
        },
        {
          nodeId: 'nod_b', name: 'Jim Lott (1950)',
          fields: { firstName: 'Jim', middleName: null, lastName: 'Lott', birthdate: '1950', deathdate: null, notes: null },
          score: 5, tier: 'possible' as const, reasons: ['same surname', 'same first name'],
          updatedAt: 't-b', fieldDiffs: [],
        },
      ],
      relationships: [],
    },
  ],
}

function header(nameRe: RegExp) {
  return screen.getByText(nameRe).closest('div') as HTMLElement
}

afterEach(() => {
  vi.clearAllMocks()
  cleanup()
})

describe('ImportExport review flow', () => {
  it('defaults a suggested match to merge with fills, and new people to create', async () => {
    vi.mocked(previewImport).mockResolvedValue(preview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')

    await screen.findByText('Review import')
    // Tier tag and the relationship the person brings are both surfaced.
    expect(screen.getByText(/Likely match/)).toBeInTheDocument()
    expect(screen.getByText(/partner Maryann Vellanikaran/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())

    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    // Fill applied by default (deathdate); conflict (birthdate) left off.
    expect(resolutions['@I1@']).toEqual({
      action: 'merge',
      nodeId: 'nod_matt',
      updatedAt: '2024-01-01T00:00:00.000Z',
      fields: ['deathdate'],
    })
    expect(resolutions['@I2@']).toEqual({ action: 'create' })
    await screen.findByText(/merged 1/)
  })

  it('lets the user opt into a conflicting field', async () => {
    vi.mocked(previewImport).mockResolvedValue(preview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    // Tick the birthdate conflict row to overwrite the tree value.
    const birthRow = screen.getByText(/^Birth date:/).closest('label') as HTMLElement
    fireEvent.click(within(birthRow).getByRole('checkbox'))

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())

    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    const r = resolutions['@I1@']
    if (r.action !== 'merge') throw new Error('expected a merge resolution')
    expect(r.fields).toEqual(expect.arrayContaining(['deathdate', 'birthdate']))
    expect(r.fields).toHaveLength(2)
  })

  it('skips a suggested-match person when Skip is chosen', async () => {
    vi.mocked(previewImport).mockResolvedValue(preview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    fireEvent.click(within(header(/^Matt Lott/)).getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())

    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(resolutions['@I1@']).toEqual({ action: 'skip' })
  })

  it('skips a brand-new person when Skip is chosen', async () => {
    vi.mocked(previewImport).mockResolvedValue(preview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    fireEvent.click(within(header(/^New Person/)).getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())

    const [, , resolutions] = vi.mocked(commitImport).mock.calls[0]
    expect(resolutions['@I2@']).toEqual({ action: 'skip' })
  })

  it('a possible match defaults to add-new until the user chooses a candidate', async () => {
    vi.mocked(previewImport).mockResolvedValue(twoCandidatePreview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    // Default: possible match is NOT auto-merged.
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())
    expect(vi.mocked(commitImport).mock.calls[0][2]['@I1@']).toEqual({ action: 'create' })
  })

  it('merges into a chosen candidate when the user picks one', async () => {
    vi.mocked(previewImport).mockResolvedValue(twoCandidatePreview)
    vi.mocked(commitImport).mockResolvedValue(commitOk)

    render(<ImportExport group={group} onCreated={vi.fn()} />)
    pickFile(/Import GEDCOM into this group/, '0 HEAD')
    await screen.findByText('Review import')

    // Switch to Merge, then pick the second candidate (born 1950).
    fireEvent.click(within(header(/^Jim Lott/)).getByRole('button', { name: 'Merge' }))
    fireEvent.click(screen.getByLabelText(/Jim Lott \(1950\)/))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(commitImport).toHaveBeenCalled())

    const res = vi.mocked(commitImport).mock.calls[0][2]['@I1@']
    expect(res).toEqual({ action: 'merge', nodeId: 'nod_b', updatedAt: 't-b', fields: [] })
  })
})
