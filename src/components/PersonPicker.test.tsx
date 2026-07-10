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
})
