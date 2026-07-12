import { useEffect, useId, useMemo, useRef, useState } from 'react'

// A searchable person picker — a combobox that replaces long native <select>
// lists (which get unwieldy once a family tree has more than a handful of
// people). Shows the current selection as a button; opening it reveals a filter
// box and a scrollable, filtered listbox. Mobile-first and dark-themed to match
// the rest of the app.
//
// Accessibility: the filter input is the combobox (aria-controls the listbox,
// aria-activedescendant tracks the highlighted option); each option element is
// itself the interactive target and carries aria-selected, so pointer and
// screen-reader users act on the same element. Arrow keys move `active` and the
// highlighted option is scrolled into view.

export interface PickerOption {
  id: string
  label: string
  // Optional dimmer second line (e.g. an email, or "likely other parent").
  hint?: string
  // Optional grouping. When any option carries a section, the list renders a
  // small header before each non-empty group ("Suggested" pinned above "All
  // people") and keeps the suggested rows on top even while filtering. Options
  // with no section fall into "all". If no option has a section, the picker
  // renders a single flat list exactly as before.
  section?: 'suggested' | 'all'
}

const SECTION_LABELS: Record<'suggested' | 'all', string> = {
  suggested: 'Suggested',
  all: 'All people',
}

// Rank substring matches so the closest hit floats up: a prefix match beats a
// word-start match beats a mid-word match. Ties keep the caller's order (stable
// by original index). Returns null when the query doesn't match at all.
function queryScore(label: string, q: string): number | null {
  const l = label.toLowerCase()
  let best: number | null = null
  for (let i = l.indexOf(q); i !== -1; i = l.indexOf(q, i + 1)) {
    const score = i === 0 ? 3 : /\s/.test(l[i - 1] ?? '') ? 2 : 1
    if (score === 3) return score
    best = best === null ? score : Math.max(best, score)
  }
  return best
}

function rankByQuery(list: PickerOption[], q: string): PickerOption[] {
  if (!q) return list
  return list
    .map((o, i) => ({ o, i, s: queryScore(o.label, q) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => (b.s as number) - (a.s as number) || a.i - b.i)
    .map((x) => x.o)
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
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const optionId = (i: number) => `${baseId}-opt-${i}`

  const selected = options.find((o) => o.id === value) ?? null

  const hasSections = useMemo(() => options.some((o) => o.section), [options])

  // Group first (so "Suggested" stays pinned above everyone else regardless of
  // the query), then rank each group's matches by the query. When no option is
  // sectioned this collapses to a single query-ranked list.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!hasSections) {
      return [{ section: null as null, items: rankByQuery(options, q) }]
    }
    return (['suggested', 'all'] as const).map((section) => ({
      section,
      items: rankByQuery(
        options.filter((o) => (o.section ?? 'all') === section),
        q,
      ),
    }))
  }, [options, query, hasSections])

  // Rows the keyboard can land on: the optional clear row, then every group's
  // matches in display order (section headers are not selectable).
  const rows: Array<{ id: string | null; label: string; hint?: string }> = [
    ...(clearLabel ? [{ id: null, label: clearLabel }] : []),
    ...groups.flatMap((g) => g.items),
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

  // Keep the highlighted option visible even when the list scrolls past its
  // max height — otherwise arrowing down would select a row you can't see.
  useEffect(() => {
    if (!open) return
    // Use getElementById instead of querySelector to avoid CSS-escaping the
    // colon-containing IDs produced by useId().
    const el = document.getElementById(`${baseId}-opt-${active}`)
    // Optional-call: jsdom (tests) and some older engines don't implement it.
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active, baseId, open])

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

  function renderOption(
    row: { id: string | null; label: string; hint?: string },
    i: number,
  ) {
    const isActive = i === active
    const isSelected =
      row.id === value || (row.id === null && value == null && !!clearLabel)
    return (
      // The option element is itself the click target — no nested button — so
      // aria-selected sits on what the user interacts with. Keyboard activation
      // goes through the combobox input's onKeyDown + aria-activedescendant.
      <li
        key={row.id ?? '__clear__'}
        id={optionId(i)}
        role="option"
        aria-selected={isSelected}
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(row.id)}
        className={`flex cursor-pointer flex-col items-start px-3 py-2 text-sm ${
          isActive ? 'bg-zinc-800' : ''
        } ${row.id === null ? 'text-zinc-400' : 'text-zinc-100'}`}
      >
        <span className="w-full truncate">{row.label}</span>
        {row.hint && (
          <span className="w-full truncate text-xs text-zinc-500">
            {row.hint}
          </span>
        )}
      </li>
    )
  }

  // Walk the clear row + grouped matches, emitting a non-selectable header
  // before each non-empty section. The running `idx` mirrors each option's
  // position in `rows`, so keyboard nav (which indexes `rows`) stays aligned.
  function renderRows() {
    const els: React.ReactNode[] = []
    let idx = 0
    if (clearLabel) {
      els.push(renderOption(rows[0], idx))
      idx += 1
    }
    for (const g of groups) {
      if (g.items.length === 0) continue
      if (hasSections && g.section) {
        const sectionLabel = SECTION_LABELS[g.section]
        const groupOptions = g.items.map((item) => {
          const option = renderOption(item, idx)
          idx += 1
          return option
        })
        els.push(
          <li
            key={`__section-${g.section}`}
            role="presentation"
            className="pt-2"
          >
            <div
              aria-hidden
              className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500"
            >
              {sectionLabel}
            </div>
            <ul role="group" aria-label={sectionLabel}>
              {groupOptions}
            </ul>
          </li>,
        )
        continue
      }
      for (const item of g.items) {
        els.push(renderOption(item, idx))
        idx += 1
      }
    }
    return els
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
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                rows.length > 0 ? optionId(active) : undefined
              }
              placeholder="Type to filter…"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-52 overflow-y-auto py-1"
          >
            {rows.length === 0 ? (
              <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
            ) : (
              renderRows()
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
