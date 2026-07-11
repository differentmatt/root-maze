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

// Per-person decisions, keyed by GEDCOM xref. `merge` is the default for a
// matched person; unmatched people default to `create` (and aren't tracked
// here unless the user chooses to skip them).
type Decision = {
  action: 'merge' | 'create' | 'skip'
  // For a merge: fields where the imported value should overwrite the existing.
  overwrite: Set<string>
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

// The heart of "review & confirm": show every person the file would add, mark
// the ones that look like existing people, and let the user decide merge /
// import-as-new / skip and pick a winner for each conflicting field.
function ReviewPanel({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: ImportPreview
  onCancel: () => void
  onConfirm: (resolutions: Record<string, ImportResolution>) => void
}) {
  const matched = preview.people.filter((p) => p.match)
  const fresh = preview.people.filter((p) => !p.match)

  // Only matched people need a stored decision; everyone else defaults to
  // `create`. Fresh (unmatched) people are seeded here too so the user can
  // choose to skip them.
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => {
    const seed: Record<string, Decision> = {}
    for (const p of matched) seed[p.xref] = { action: 'merge', overwrite: new Set() }
    for (const p of fresh) seed[p.xref] = { action: 'create', overwrite: new Set() }
    return seed
  })

  function setAction(xref: string, action: Decision['action']) {
    setDecisions((d) => ({ ...d, [xref]: { ...d[xref], action } }))
  }

  function toggleOverwrite(xref: string, field: string) {
    setDecisions((d) => {
      const next = new Set(d[xref].overwrite)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return { ...d, [xref]: { ...d[xref], overwrite: next } }
    })
  }

  function confirm() {
    const resolutions: Record<string, ImportResolution> = {}
    for (const p of [...matched, ...fresh]) {
      const d = decisions[p.xref]
      if (d.action === 'skip') {
        resolutions[p.xref] = { action: 'skip' }
      } else if (d.action === 'create' || !p.match) {
        resolutions[p.xref] = { action: 'create' }
      } else {
        resolutions[p.xref] = {
          action: 'merge',
          nodeId: p.match.nodeId,
          updatedAt: p.match.updatedAt,
          overwrite: [...d.overwrite],
        }
      }
    }
    onConfirm(resolutions)
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <p className="text-sm font-medium text-zinc-200">Review import</p>
        <p className="text-xs text-zinc-500">
          {preview.stats.people} people, {preview.stats.relationships} relationships
          {preview.stats.matches > 0 &&
            ` · ${preview.stats.matches} look like existing people`}
        </p>
      </div>

      {matched.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Possible duplicates
          </p>
          {matched.map((p) => (
            <MatchRow
              key={p.xref}
              person={p}
              decision={decisions[p.xref]}
              onAction={(a) => setAction(p.xref, a)}
              onToggleOverwrite={(f) => toggleOverwrite(p.xref, f)}
            />
          ))}
        </div>
      )}

      {fresh.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            New people ({fresh.length})
          </p>
          {fresh.map((p) => (
            <div
              key={p.xref}
              className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2"
            >
              <p className="text-sm text-zinc-300">{p.fullName}</p>
              <div className="flex gap-1 rounded border border-zinc-800 p-0.5 text-xs">
                {(['create', 'skip'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setAction(p.xref, a)}
                    className={`rounded px-2 py-1 capitalize ${
                      decisions[p.xref]?.action === a
                        ? 'bg-zinc-100 text-zinc-900'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {a === 'create' ? 'Add' : a}
                  </button>
                ))}
              </div>
            </div>
          ))}
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

function MatchRow({
  person,
  decision,
  onAction,
  onToggleOverwrite,
}: {
  person: ImportPerson
  decision: Decision
  onAction: (a: Decision['action']) => void
  onToggleOverwrite: (field: string) => void
}) {
  const match = person.match!
  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-200">
          {person.fullName}{' '}
          <span className="text-zinc-500">↔ existing “{match.name}”</span>
        </p>
        <div className="flex gap-1 rounded border border-zinc-800 p-0.5 text-xs">
          {(['merge', 'create', 'skip'] as const).map((a) => (
            <button
              key={a}
              onClick={() => onAction(a)}
              className={`rounded px-2 py-1 capitalize ${
                decision.action === a
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {a === 'create' ? 'Add new' : a}
            </button>
          ))}
        </div>
      </div>

      {decision.action === 'merge' && (
        <div className="flex flex-col gap-2">
          {match.fills.length > 0 && (
            <p className="text-xs text-zinc-500">
              Fills in:{' '}
              {match.fills
                .map((f) => FIELD_LABELS[f.field])
                .join(', ')}
            </p>
          )}
          {match.conflicts.map((c) => {
            const useImported = decision.overwrite.has(c.field)
            return (
              <div
                key={c.field}
                className="flex flex-col gap-1 rounded border border-amber-900/40 bg-amber-950/20 p-2 text-xs"
              >
                <p className="font-medium text-amber-300">
                  {FIELD_LABELS[c.field]} differs
                </p>
                <label className="flex items-start gap-2 text-zinc-300">
                  <input
                    type="radio"
                    checked={!useImported}
                    onChange={() =>
                      useImported && onToggleOverwrite(c.field)
                    }
                    className="mt-0.5"
                  />
                  <span>
                    Keep current: <span className="text-zinc-100">{c.existing}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-zinc-300">
                  <input
                    type="radio"
                    checked={useImported}
                    onChange={() =>
                      !useImported && onToggleOverwrite(c.field)
                    }
                    className="mt-0.5"
                  />
                  <span>
                    Use imported: <span className="text-zinc-100">{c.imported}</span>
                  </span>
                </label>
              </div>
            )
          })}
        </div>
      )}
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
