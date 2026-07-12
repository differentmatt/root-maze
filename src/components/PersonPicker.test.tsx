import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PersonPicker from './PersonPicker'

const options = [
  { id: 'a', label: 'Ada Lovelace' },
  { id: 'b', label: 'Bob Byron' },
  { id: 'c', label: 'Cara Stone' },
]

afterEach(cleanup)

describe('PersonPicker', () => {
  it('shows the placeholder when nothing is selected', () => {
    render(
      <PersonPicker options={options} value={null} onChange={() => {}} placeholder="Pick…" />,
    )
    expect(screen.getByText('Pick…')).toBeInTheDocument()
  })

  it('shows the selected option label', () => {
    render(<PersonPicker options={options} value="b" onChange={() => {}} />)
    expect(screen.getByText('Bob Byron')).toBeInTheDocument()
  })

  it('filters the list by the typed query', () => {
    render(<PersonPicker options={options} value={null} onChange={() => {}} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    fireEvent.change(screen.getByPlaceholderText('Type to filter…'), {
      target: { value: 'car' },
    })
    expect(screen.getByText('Cara Stone')).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
  })

  it('calls onChange with the chosen id', () => {
    const onChange = vi.fn()
    render(<PersonPicker options={options} value={null} onChange={onChange} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    fireEvent.click(screen.getByText('Ada Lovelace'))
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('offers a clear row that calls onChange(null)', () => {
    const onChange = vi.fn()
    render(
      <PersonPicker
        options={options}
        value="a"
        onChange={onChange}
        clearLabel="— none —"
        ariaLabel="pick"
      />,
    )
    fireEvent.click(screen.getByLabelText('pick'))
    fireEvent.click(screen.getByText('— none —'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  const sectioned = [
    { id: 'b', label: 'Bob Byron', section: 'suggested' as const },
    { id: 'a', label: 'Ada Lovelace', section: 'all' as const },
    { id: 'c', label: 'Cara Stone', section: 'all' as const },
  ]

  it('renders non-selectable section headers when options are grouped', () => {
    render(<PersonPicker options={sectioned} value={null} onChange={() => {}} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    expect(screen.getByText('Suggested')).toBeInTheDocument()
    expect(screen.getByText('All people')).toBeInTheDocument()
    // Headers carry role=presentation, so only the real people are options.
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('keeps the suggested option pinned first even though it sorts later', () => {
    render(<PersonPicker options={sectioned} value={null} onChange={() => {}} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    const labels = screen.getAllByRole('option').map((el) => el.textContent)
    expect(labels).toEqual(['Bob Byron', 'Ada Lovelace', 'Cara Stone'])
  })

  it('Enter activates the first option, skipping the header', () => {
    const onChange = vi.fn()
    render(<PersonPicker options={sectioned} value={null} onChange={onChange} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    fireEvent.keyDown(screen.getByPlaceholderText('Type to filter…'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('ranks a prefix match ahead of a mid-word match', () => {
    const opts = [
      { id: '1', label: 'Diana' },
      { id: '2', label: 'Ann' },
    ]
    render(<PersonPicker options={opts} value={null} onChange={() => {}} ariaLabel="pick" />)
    fireEvent.click(screen.getByLabelText('pick'))
    fireEvent.change(screen.getByPlaceholderText('Type to filter…'), {
      target: { value: 'an' },
    })
    // Both contain "an"; "Ann" (prefix) should rank above "Diana" (mid-word).
    const labels = screen.getAllByRole('option').map((el) => el.textContent)
    expect(labels).toEqual(['Ann', 'Diana'])
  })
})
