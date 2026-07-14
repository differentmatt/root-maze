import { useState } from 'react'
import {
  previewImport,
  commitImport,
  exportGedcom,
  createGroup,
  type Group,
  type ImportPreview,
  type ImportPerson,
  type ImportResolution,
  type ImportSummary,
  type ImportedFields,
  type MatchCandidate,
  type ImportRelationship,
} from '../api'

// GEDCOM import/export lives in the Group tab. Export is a one-click download of
// the whole group. Import is deliberately two-step: you pick a file, we show a
// preview that flags likely-duplicate people and field conflicts, and only once
// you've resolved those do we write anything. You can also spin up a brand-new
// group straight from a file (no review step — an empty group has nothing to
// conflict with, so everyone imports as new).

const FIELD_LABELS: Record<keyof ImportedFields, string> = {
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  birthdate: 'Birth date',
  deathdate: 'Death date',
  notes: 'Notes',
}

// Per-person review decision, keyed by GEDCOM xref.
//   action  — merge into an existing person / add as new / skip entirely
//   nodeId  — which candidate to merge into (people can have several)
//   fields  — which imported fields to write onto that person on merge
type Decision = {
  action: 'merge' | 'create' | 'skip'
  nodeId: string | null
  fields: Set<string>
}

export default function ImportExport({
  group,
  onCreated,
}: {
  group: Group
  onCreated: (group: Group) => Promise<void> | void
}) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Import / export
      </h3>
      <ExportRow group={group} />
      <div className="border-t border-zinc-800/60" />
      <ImportRow group={group} />
      <NewGroupFromFile onCreated={onCreated} />
    </section>
  )
}

// --- Export --------------------------------------------------------------

function ExportRow({ group }: { group: Group }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function download() {
    setBusy(true)
    setError('')
    try {
      const { gedcom } = await exportGedcom(group.groupId)
      const url = URL.createObjectURL(
        new Blob([gedcom], { type: 'text/vnd.familysearch.gedcom' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeFileName(group.name)}.ged`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={download}
        disabled={busy}
        className="self-start rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
      >
        {busy ? 'Preparing…' : 'Export GEDCOM'}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}

// --- Import into the current group ---------------------------------------

type ImportState =
  | { phase: 'idle' }
  | { phase: 'previewing' }
  | { phase: 'review'; gedcom: string; preview: ImportPreview }
  | { phase: 'committing' }
  | { phase: 'done'; summary: ImportSummary }
  | { phase: 'error'; message: string }

function ImportRow({ group }: { group: Group }) {
  const [state, setState] = useState<ImportState>({ phase: 'idle' })

  async function onFile(file: File) {
    setState({ phase: 'previewing' })
    try {
      const gedcom = await file.text()
      const preview = await previewImport(group.groupId, gedcom)
      setState({ phase: 'review', gedcom, preview })
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Could not read that file',
      })
    }
  }

  async function commit(resolutions: Record<string, ImportResolution>, gedcom: string) {
    setState({ phase: 'committing' })
    try {
      const summary = await commitImport(group.groupId, gedcom, resolutions)
      setState({ phase: 'done', summary })
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Import failed',
      })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <FilePicker
        label="Import GEDCOM into this group"
        disabled={state.phase === 'previewing' || state.phase === 'committing'}
        onFile={onFile}
      />
      <ImageToGedcomNote />
      {state.phase === 'previewing' && (
        <p className="text-sm text-zinc-400">Reading file…</p>
      )}
      {state.phase === 'committing' && (
        <p className="text-sm text-zinc-400">Importing…</p>
      )}
      {state.phase === 'error' && (
        <p className="text-sm text-red-400">{state.message}</p>
      )}
      {state.phase === 'done' && (
        <ImportDone
          summary={state.summary}
          onDismiss={() => setState({ phase: 'idle' })}
        />
      )}
      {state.phase === 'review' && (
        <ReviewPanel
          preview={state.preview}
          onCancel={() => setState({ phase: 'idle' })}
          onConfirm={(resolutions) => commit(resolutions, state.gedcom)}
        />
      )}
    </div>
  )
}

function ImportDone({
  summary,
  onDismiss,
}: {
  summary: ImportSummary
  onDismiss: () => void
}) {
  const rel = summary.relationshipsCreated
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-3 text-sm">
      <p className="text-emerald-300">
        Imported {summary.created} new · merged {summary.merged} · skipped{' '}
        {summary.skipped}. Added {rel} relationship{rel === 1 ? '' : 's'}.
      </p>
      <p className="text-zinc-400">Switch to the Tree tab to see the changes.</p>
      <button
        onClick={onDismiss}
        className="self-start text-xs text-zinc-400 hover:text-zinc-200"
      >
        Dismiss
      </button>
    </div>
  )
}

// The default fields to apply when merging into a candidate: everything the
// tree is missing (a "fill"). Conflicts start off, for the user to opt into.
function defaultMergeFields(candidate: MatchCandidate): Set<string> {
  return new Set(
    candidate.fieldDiffs.filter((d) => d.status === 'fill').map((d) => d.field),
  )
}

const RELATION_LABEL: Record<ImportRelationship['relation'], string> = {
  partner: 'partner',
  parent: 'parent',
  child: 'child',
}

// The heart of "review & confirm": one card per imported person showing ranked
// candidate matches, side-by-side fields, the data/relationships they bring, and
// the merge / add-new / skip decision.
function ReviewPanel({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: ImportPreview
  onCancel: () => void
  onConfirm: (resolutions: Record<string, ImportResolution>) => void
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const seed: Record<string, Decision> = {}
    for (const p of preview.people) {
      const cand = p.suggestedNodeId
        ? p.candidates.find((c) => c.nodeId === p.suggestedNodeId)
        : p.candidates[0]
      seed[p.xref] = {
        // Only a suggested (strong, unambiguous) match defaults to merge; a mere
        // "possible" match is surfaced but defaults to adding a new person.
        action: p.suggestedNodeId ? 'merge' : 'create',
        nodeId: cand ? cand.nodeId : null,
        fields: cand ? defaultMergeFields(cand) : new Set(),
      }
    }
    return seed
  })

  function setAction(xref: string, action: Decision['action']) {
    setDecisions((d) => ({ ...d, [xref]: { ...d[xref], action } }))
  }

  function selectCandidate(xref: string, candidate: MatchCandidate) {
    setDecisions((d) => ({
      ...d,
      [xref]: { action: 'merge', nodeId: candidate.nodeId, fields: defaultMergeFields(candidate) },
    }))
  }

  function toggleField(xref: string, field: string) {
    setDecisions((d) => {
      const next = new Set(d[xref].fields)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return { ...d, [xref]: { ...d[xref], fields: next } }
    })
  }

  function confirm() {
    const resolutions: Record<string, ImportResolution> = {}
    for (const p of preview.people) {
      const d = decisions[p.xref]
      if (d.action === 'skip') {
        resolutions[p.xref] = { action: 'skip' }
        continue
      }
      const cand = d.action === 'merge' && d.nodeId
        ? p.candidates.find((c) => c.nodeId === d.nodeId)
        : undefined
      if (cand) {
        resolutions[p.xref] = {
          action: 'merge',
          nodeId: cand.nodeId,
          updatedAt: cand.updatedAt,
          fields: [...d.fields],
        }
      } else {
        resolutions[p.xref] = { action: 'create' }
      }
    }
    onConfirm(resolutions)
  }

  // On a repeat import, most people are already fully in the tree with nothing
  // to add; keep the review focused on the ones with a real delta and tuck the
  // rest behind a toggle. Their decisions still ride along (they default to
  // merging into their existing node), so any relationships still get wired.
  const needsReview = preview.people.filter((p) => !p.alreadyInTree)
  const settled = preview.people.filter((p) => p.alreadyInTree)
  const [showSettled, setShowSettled] = useState(false)

  const { possibleMatches, newPeople, alreadyInTree } = preview.stats
  const summary = [
    newPeople && `${newPeople} new`,
    possibleMatches && `${possibleMatches} possible`,
    alreadyInTree && `${alreadyInTree} already in your tree`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <p className="text-sm font-medium text-zinc-200">Review import</p>
        <p className="text-xs text-zinc-500">
          {preview.stats.people} people, {preview.stats.relationships} relationships
          {summary && ` · ${summary}`}
        </p>
      </div>

      {needsReview.length === 0 && (
        <p className="text-sm text-zinc-400">
          Everything in this file is already in your tree — nothing to add.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {needsReview.map((p) => (
          <PersonReview
            key={p.xref}
            person={p}
            decision={decisions[p.xref]}
            onAction={(a) => setAction(p.xref, a)}
            onSelectCandidate={(c) => selectCandidate(p.xref, c)}
            onToggleField={(f) => toggleField(p.xref, f)}
          />
        ))}
      </div>

      {settled.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setShowSettled((s) => !s)}
            className="self-start text-xs text-zinc-500 hover:text-zinc-300"
          >
            {showSettled ? '▾' : '▸'} {settled.length} already in your tree
          </button>
          {showSettled && (
            <p className="text-xs text-zinc-500">
              {settled.map((p) => p.fullName).join(', ')}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={confirm}
          className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          Import
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function PersonReview({
  person,
  decision,
  onAction,
  onSelectCandidate,
  onToggleField,
}: {
  person: ImportPerson
  decision: Decision
  onAction: (a: Decision['action']) => void
  onSelectCandidate: (c: MatchCandidate) => void
  onToggleField: (field: string) => void
}) {
  const hasCandidates = person.candidates.length > 0
  const selected = person.candidates.find((c) => c.nodeId === decision.nodeId)
  const tag = person.suggestedNodeId
    ? { text: 'Likely match', cls: 'text-emerald-300' }
    : hasCandidates
      ? { text: 'Possible match', cls: 'text-amber-300' }
      : { text: 'New', cls: 'text-zinc-500' }

  const actions = hasCandidates
    ? (['merge', 'create', 'skip'] as const)
    : (['create', 'skip'] as const)

  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-200">
          {person.fullName} <span className={`text-xs ${tag.cls}`}>· {tag.text}</span>
        </p>
        <div className="flex gap-1 rounded border border-zinc-800 p-0.5 text-xs">
          {actions.map((a) => (
            <button
              key={a}
              onClick={() => onAction(a)}
              className={`rounded px-2 py-1 ${
                decision.action === a
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {a === 'merge' ? 'Merge' : a === 'create' ? 'Add new' : 'Skip'}
            </button>
          ))}
        </div>
      </div>

      {(() => {
        // Show new relationships prominently ("Adds: …"); a relationship already
        // in the tree isn't worth the user's attention on a repeat import.
        const added = person.relationships.filter((r) => r.isNew)
        if (!added.length) return null
        return (
          <p className="text-xs text-zinc-500">
            Adds:{' '}
            {added.map((r) => `${RELATION_LABEL[r.relation]} ${r.otherName}`).join(' · ')}
          </p>
        )
      })()}

      {decision.action === 'merge' && hasCandidates && (
        <div className="flex flex-col gap-2">
          {person.candidates.length > 1 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Merge into
              </p>
              {person.candidates.map((c) => (
                <label
                  key={c.nodeId}
                  className="flex items-start gap-2 text-xs text-zinc-300"
                >
                  <input
                    type="radio"
                    name={`cand-${person.xref}`}
                    checked={decision.nodeId === c.nodeId}
                    onChange={() => onSelectCandidate(c)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-zinc-100">{c.name}</span>{' '}
                    <span className="text-zinc-500">— {c.reasons.join(', ')}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected && (
            <FieldTable
              candidate={selected}
              apply={decision.fields}
              onToggle={onToggleField}
            />
          )}
        </div>
      )}
    </div>
  )
}

// Side-by-side field comparison of the imported record vs the chosen candidate.
// `fill` and `conflict` rows get an apply checkbox; `same`/`treeOnly` are shown
// muted for context (nothing to decide).
function FieldTable({
  candidate,
  apply,
  onToggle,
}: {
  candidate: MatchCandidate
  apply: Set<string>
  onToggle: (field: string) => void
}) {
  const rows = candidate.fieldDiffs.filter((d) => d.status !== 'same')
  if (!rows.length) {
    return <p className="text-xs text-zinc-500">Nothing new to add — identical fields.</p>
  }
  return (
    <div className="flex flex-col gap-1 rounded border border-zinc-800 p-2">
      {rows.map((d) => {
        const editable = d.status === 'fill' || d.status === 'conflict'
        return (
          <label
            key={d.field}
            className={`flex items-start gap-2 text-xs ${
              editable ? 'text-zinc-300' : 'text-zinc-500'
            }`}
          >
            <input
              type="checkbox"
              disabled={!editable}
              checked={editable ? apply.has(d.field) : false}
              onChange={() => onToggle(d.field)}
              className="mt-0.5 disabled:opacity-30"
            />
            <span className="min-w-0">
              <span className="text-zinc-400">{FIELD_LABELS[d.field]}: </span>
              {d.status === 'fill' && (
                <span className="text-zinc-100">add “{d.imported}”</span>
              )}
              {d.status === 'conflict' && (
                <span>
                  <span className="text-zinc-100">“{d.imported}”</span>
                  <span className="text-zinc-500"> (replaces “{d.existing}”)</span>
                </span>
              )}
              {d.status === 'treeOnly' && (
                <span className="text-zinc-500">keep “{d.existing}” (not in file)</span>
              )}
            </span>
          </label>
        )
      })}
    </div>
  )
}

// --- New group straight from a file --------------------------------------

function NewGroupFromFile({
  onCreated,
}: {
  onCreated: (group: Group) => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<
    'idle' | 'working' | { error: string }
  >('idle')

  async function create() {
    if (!name.trim() || !file) return
    setStatus('working')
    let group: Group | null = null
    try {
      const gedcom = await file.text()
      group = await createGroup(name.trim())
      // A brand-new group is empty, so every person imports as new — no review.
      await commitImport(group.groupId, gedcom, {})
      setOpen(false)
      setName('')
      setFile(null)
      setStatus('idle')
      await onCreated(group)
    } catch (err) {
      setStatus({ error: err instanceof Error ? err.message : 'Import failed' })
      // If the group was already persisted but the import failed, hand it back
      // to the workspace so the user can see and manage the (possibly partial)
      // group rather than losing it entirely. onCreated may return void or a
      // promise, so normalize before catching its failure.
      if (group) await Promise.resolve(onCreated(group)).catch(() => {})
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start text-sm text-zinc-400 hover:text-zinc-200"
      >
        + New group from a GEDCOM file
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-300">New group from a file</p>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Cancel
        </button>
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Group name"
        className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
      />
      <FilePicker
        label={file ? `Selected: ${file.name}` : 'Choose GEDCOM file'}
        onFile={(f) => setFile(f)}
      />
      {typeof status === 'object' && (
        <p className="text-sm text-red-400">{status.error}</p>
      )}
      <button
        onClick={create}
        disabled={status === 'working' || !name.trim() || !file}
        className="self-start rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40"
      >
        {status === 'working' ? 'Creating…' : 'Create & import'}
      </button>
    </div>
  )
}

// --- "No GEDCOM file? Make one with an AI" help note ---------------------

// Many people only have a photo, screenshot, or hand-drawn sketch of their
// family tree — not a GEDCOM file. This collapsible note tells them they can ask
// an AI assistant (e.g. Claude) to turn that image into GEDCOM they can import
// here, which is often the fastest way to get an existing tree into the app.
function ImageToGedcomNote() {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="self-start text-zinc-500 hover:text-zinc-300"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Only have a photo of a family tree?
      </button>
      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-zinc-400">
          <p>
            No GEDCOM file? An AI assistant like{' '}
            <span className="text-zinc-200">Claude</span> can read a photo,
            screenshot, or scan of a family tree and turn it into one.
          </p>
          <ol className="ml-4 list-decimal space-y-1">
            <li>Upload your family-tree image to the assistant.</li>
            <li>
              Ask it to{' '}
              <span className="text-zinc-300">
                “convert this family tree into a GEDCOM 5.5.1 file”
              </span>
              .
            </li>
            <li>
              Save its reply as a{' '}
              <span className="text-zinc-300">.ged</span> file, then import it
              above.
            </li>
          </ol>
          <p className="text-zinc-500">
            Double-check names and dates after importing — reading handwriting or
            a photo isn’t always perfect.
          </p>
        </div>
      )}
    </div>
  )
}

// --- Shared file input ---------------------------------------------------

function FilePicker({
  label,
  disabled,
  onFile,
}: {
  label: string
  disabled?: boolean
  onFile: (file: File) => void
}) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-2 self-start rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 ${
        disabled ? 'pointer-events-none opacity-40' : ''
      }`}
    >
      {label}
      <input
        type="file"
        // No `accept` filter on purpose. `.ged` has no registered type, so
        // iOS/Safari (and some Android/Windows pickers) grey the file out when
        // accept is set — which is exactly the "I can't pick my file" bug. We
        // validate the content server-side, so letting any file through is both
        // safe and the only reliable way to select a .ged on every platform.
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          // Reset so re-picking the same file fires onChange again.
          e.target.value = ''
        }}
      />
    </label>
  )
}

function safeFileName(name: string) {
  return name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'family'
}
