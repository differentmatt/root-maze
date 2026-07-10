import { useEffect, useMemo, useRef, useState } from 'react'

// A searchable person picker — a combobox that replaces long native <select>
// lists (which get unwieldy once a family tree has more than a handful of
// people). Shows the current selection as a button; opening it reveals a filter
// box and a scrollable, filtered list. Mobile-first and dark-themed to match the
// rest of the app.

export interface PickerOption {
  id: string
  label: string
  // Optional dimmer second line (e.g. an email, or "likely other parent").
  hint?: string
}

const triggerClass =
  'flex w-full items-center justify-between gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-left text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:opacity-40'

export default function PersonPicker({
  options,
  value,
  onChange,
  placeholder = 'Select person…',
  clearLabel,
  disabled = false,
  ariaLabel,
}: {
  options: PickerOption[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder?: string
  // When set, an explicit "clear" row is offered at the top of the list that
  // calls onChange(null) — used where "not linked" is a valid choice.
  clearLabel?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = options.find((o) => o.id === value) ?? null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  // Rows the keyboard can land on: the optional clear row, then the matches.
  const rows: Array<{ id: string | null; label: string; hint?: string }> = [
    ...(clearLabel ? [{ id: null, label: clearLabel }] : []),
    ...filtered,
  ]

  // Focus the filter box on open, and keep the active row in range.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // Defer so the input is mounted before we focus it.
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1))
  }, [rows.length, active])

  // Close on click outside or Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function choose(id: string | null) {
    onChange(id)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(rows.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (row) choose(row.id)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
      >
        <span className={selected ? 'truncate' : 'truncate text-zinc-500'}>
          {selected ? selected.label : placeholder}
        </span>
        <span aria-hidden className="shrink-0 text-xs text-zinc-400">
          ▼
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
          <div className="border-b border-zinc-800 p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Type to filter…"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <ul role="listbox" className="max-h-52 overflow-y-auto py-1">
            {rows.length === 0 ? (
              <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
            ) : (
              rows.map((row, i) => {
                const isActive = i === active
                const isSelected =
                  row.id === value || (row.id === null && value == null && !!clearLabel)
                return (
                  <li key={row.id ?? '__clear__'} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(row.id)}
                      className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm ${
                        isActive ? 'bg-zinc-800' : ''
                      } ${row.id === null ? 'text-zinc-400' : 'text-zinc-100'}`}
                    >
                      <span className="w-full truncate">{row.label}</span>
                      {row.hint && (
                        <span className="w-full truncate text-xs text-zinc-500">
                          {row.hint}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
