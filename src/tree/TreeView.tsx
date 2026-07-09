import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getGraph,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
  SUBTYPES,
  ApiError,
  type Group,
  type Graph,
  type PersonNode,
  type Edge,
  type EdgeInput,
} from '../api'
import GraphCanvas from './GraphCanvas'
import { inferSiblings, type InferredSibling } from './siblings'

type Status =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; message: string }

// A relationship is chosen relative to a reference person: "child of / parent
// of / partner of <someone>". This maps onto the directed edge model.
type RelChoice = 'child_of' | 'parent_of' | 'partner_of'

const REL_LABELS: Record<RelChoice, string> = {
  child_of: 'Child of',
  parent_of: 'Parent of',
  partner_of: 'Partner of',
}

function subtypesFor(choice: RelChoice): string[] {
  return choice === 'partner_of' ? SUBTYPES.partner : SUBTYPES.parent_child
}

function buildEdgeInput(
  choice: RelChoice,
  refId: string,
  otherId: string,
  subtype: string,
): EdgeInput {
  const extra = subtype ? { subtype } : {}
  if (choice === 'partner_of') {
    return { edgeKind: 'partner', fromPerson: refId, toPerson: otherId, ...extra }
  }
  if (choice === 'parent_of') {
    return { edgeKind: 'parent_child', fromPerson: refId, toPerson: otherId, ...extra }
  }
  // child_of: the other person is the parent.
  return { edgeKind: 'parent_child', fromPerson: otherId, toPerson: refId, ...extra }
}

// The Phase 1 group screen: the graph canvas, an add-person form (with an
// optional first relationship), and a panel to edit the selected person, manage
// their relationships, or remove them.
export default function TreeView({ group }: { group: Group }) {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] })
  const [status, setStatus] = useState<Status>({ state: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isFull, setIsFull] = useState(false)

  const reload = useCallback(async () => {
    try {
      const g = await getGraph(group.groupId)
      setGraph(g)
      setStatus({ state: 'ready' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return
      setStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Failed to load',
      })
    }
  }, [group.groupId])

  useEffect(() => {
    setStatus({ state: 'loading' })
    setSelectedId(null)
    reload()
  }, [reload])

  const selected = graph.nodes.find((n) => n.nodeId === selectedId) ?? null

  // Fullscreen is for viewing only. Selecting a person leaves fullscreen so the
  // edit panel shows inline, rather than editing inside the overlay.
  function selectPerson(id: string) {
    setSelectedId((cur) => (cur === id ? null : id))
    setIsFull(false)
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-zinc-500">Group</p>
        <p className="text-lg font-medium">{group.name}</p>
      </div>

      {status.state === 'loading' && <GraphLoading />}

      {status.state === 'error' && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-red-900 bg-zinc-900 p-4">
          <p className="text-sm text-red-400">Error: {status.message}</p>
          <button
            onClick={reload}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      )}

      {status.state === 'ready' && (
        <>
          <GraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selectedId}
            onSelect={selectPerson}
            isFull={isFull}
            onFullscreenChange={setIsFull}
          />

          <Legend />

          {/* Editing a person replaces the add-person form so the screen stays
              focused on that person. */}
          {selected ? (
            <PersonPanel
              key={selected.nodeId}
              groupId={group.groupId}
              person={selected}
              graph={graph}
              onChanged={reload}
              onDeleted={() => {
                setSelectedId(null)
                reload()
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <>
              <p className="text-sm text-zinc-500">
                Tap a person in the graph to edit them or add relationships.
              </p>
              <AddPersonForm
                groupId={group.groupId}
                onAdded={(newId) => {
                  setSelectedId(newId)
                  reload()
                }}
              />
            </>
          )}
        </>
      )}
    </section>
  )
}

function GraphLoading() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 text-sm text-zinc-500">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
      Loading family graph…
    </div>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 bg-sky-400" /> parent → child
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 bg-rose-400" /> partner
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-zinc-400" />{' '}
        ended
      </span>
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none'
const cardClass =
  'flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4'
const primaryBtn =
  'rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Native date picker for the common case, with a graceful fallback to a text
// field for legacy or approximate values (e.g. a year only) so we never drop
// data the picker can't represent.
function DateField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  const type = value === '' || ISO_DATE.test(value) ? 'date' : 'text'
  return (
    <input
      type={type}
      className={inputClass}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}

// Controlled fields for choosing a relationship relative to a reference person.
function RelationshipFields({
  choice,
  setChoice,
  otherId,
  setOtherId,
  subtype,
  setSubtype,
  candidates,
}: {
  choice: RelChoice
  setChoice: (c: RelChoice) => void
  otherId: string
  setOtherId: (id: string) => void
  subtype: string
  setSubtype: (s: string) => void
  candidates: PersonNode[]
}) {
  const subs = subtypesFor(choice)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <select
          className={inputClass}
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value as RelChoice)
            setSubtype('')
          }}
        >
          {(Object.keys(REL_LABELS) as RelChoice[]).map((c) => (
            <option key={c} value={c}>
              {REL_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={otherId}
          onChange={(e) => setOtherId(e.target.value)}
        >
          <option value="">Select person…</option>
          {candidates.map((p) => (
            <option key={p.nodeId} value={p.nodeId}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <select
        className={inputClass}
        value={subtype || subs[0]}
        onChange={(e) => setSubtype(e.target.value)}
      >
        {subs.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  )
}

// Adding a person only captures identity — relationships are managed in one
// place, the person panel, by selecting the person afterward.
function AddPersonForm({
  groupId,
  onAdded,
}: {
  groupId: string
  onAdded: (newNodeId: string) => void
}) {
  const [name, setName] = useState('')
  const [birthdate, setBirthdate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const node = await createNode(groupId, {
        name: name.trim(),
        birthdate: birthdate.trim() || null,
      })
      setName('')
      setBirthdate('')
      onAdded(node.nodeId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cardClass}>
      <p className="text-sm font-medium text-zinc-300">Add a person</p>
      <Field label="Name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ada Lovelace"
        />
      </Field>
      <Field label="Birthdate (optional)">
        <DateField
          value={birthdate}
          onChange={setBirthdate}
          placeholder="Birthdate"
        />
      </Field>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        className={primaryBtn}
        onClick={submit}
        disabled={busy || !name.trim()}
      >
        {busy ? 'Adding…' : 'Add person'}
      </button>
    </div>
  )
}

function PersonPanel({
  groupId,
  person,
  graph,
  onChanged,
  onDeleted,
  onClose,
}: {
  groupId: string
  person: PersonNode
  graph: Graph
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(person.name)
  const [birthdate, setBirthdate] = useState(person.birthdate ?? '')
  const [deathdate, setDeathdate] = useState(person.deathdate ?? '')
  const [notes, setNotes] = useState(person.notes ?? '')
  const [save, setSave] = useState<SaveState>({ state: 'idle' })

  // The last values we know are persisted, so we only auto-save real changes.
  const saved = useRef({
    name: person.name,
    birthdate: person.birthdate ?? '',
    deathdate: person.deathdate ?? '',
    notes: person.notes ?? '',
  })

  const names = useMemo(() => {
    const m: Record<string, string> = {}
    for (const n of graph.nodes) m[n.nodeId] = n.name
    return m
  }, [graph.nodes])

  // This person's relationships, and the set of people they already connect to.
  const myEdges = graph.edges.filter(
    (e) => e.fromPerson === person.nodeId || e.toPerson === person.nodeId,
  )
  const connected = new Set(
    myEdges.map((e) =>
      e.fromPerson === person.nodeId ? e.toPerson : e.fromPerson,
    ),
  )
  const candidates = graph.nodes.filter(
    (n) => n.nodeId !== person.nodeId && !connected.has(n.nodeId),
  )
  const siblings = useMemo(
    () => inferSiblings(graph, person.nodeId),
    [graph, person.nodeId],
  )

  // Auto-save: after a short pause once a field actually changes. An empty name
  // is the one thing we refuse to persist.
  useEffect(() => {
    const dirty =
      name !== saved.current.name ||
      birthdate !== saved.current.birthdate ||
      deathdate !== saved.current.deathdate ||
      notes !== saved.current.notes
    if (!dirty) return
    if (!name.trim()) {
      setSave({ state: 'error', message: 'Name can’t be empty' })
      return
    }
    const t = setTimeout(async () => {
      setSave({ state: 'saving' })
      try {
        await updateNode(groupId, person.nodeId, {
          name: name.trim(),
          birthdate: birthdate.trim() || null,
          deathdate: deathdate.trim() || null,
          notes: notes.trim() || null,
        })
        saved.current = { name, birthdate, deathdate, notes }
        setSave({ state: 'saved' })
        onChanged()
      } catch (err) {
        setSave({
          state: 'error',
          message: err instanceof Error ? err.message : 'Save failed',
        })
      }
    }, 700)
    return () => clearTimeout(t)
  }, [name, birthdate, deathdate, notes, groupId, person.nodeId, onChanged])

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-200">Edit person</p>
        <div className="flex items-center gap-3">
          <SaveStatus save={save} />
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Close
          </button>
        </div>
      </div>

      <Field label="Name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ada Lovelace"
        />
      </Field>
      <Field label="Birthdate">
        <DateField value={birthdate} onChange={setBirthdate} placeholder="Birthdate" />
      </Field>
      <Field label="Death date">
        <DateField value={deathdate} onChange={setDeathdate} placeholder="Death date" />
      </Field>
      <Field label="Notes">
        <textarea
          className={inputClass}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering"
          rows={2}
        />
      </Field>

      <div className="border-t border-zinc-800 pt-3">
        <p className="mb-2 text-sm font-medium text-zinc-300">Relationships</p>
        <RelationshipsSection
          groupId={groupId}
          person={person}
          myEdges={myEdges}
          names={names}
          candidates={candidates}
          siblings={siblings}
          onChanged={onChanged}
        />
      </div>

      <DeleteSection groupId={groupId} person={person} onDeleted={onDeleted} />
    </div>
  )
}

type SaveState =
  | { state: 'idle' | 'saving' | 'saved' }
  | { state: 'error'; message: string }

function SaveStatus({ save }: { save: SaveState }) {
  if (save.state === 'saving')
    return <span className="text-xs text-zinc-500">Saving…</span>
  if (save.state === 'saved')
    return <span className="text-xs text-emerald-500">Saved</span>
  if (save.state === 'error')
    return <span className="text-xs text-red-400">{save.message}</span>
  return null
}

// Labelled field — the native date picker ignores placeholder text, so a label
// is the only reliable way to say what each input is.
function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
      {label}
      {children}
    </label>
  )
}

// Destructive, so it lives at the bottom behind an explicit confirm step.
function DeleteSection({
  groupId,
  person,
  onDeleted,
}: {
  groupId: string
  person: PersonNode
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await deleteNode(groupId, person.nodeId)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-zinc-800 pt-3">
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="text-sm text-red-400 hover:text-red-300"
        >
          Delete person
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-300">
            Delete {person.name}? This also removes their relationships and can’t
            be undone.
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40"
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function describeEdge(edge: Edge, personId: string, names: Record<string, string>) {
  const otherId = edge.fromPerson === personId ? edge.toPerson : edge.fromPerson
  const other = names[otherId] ?? '?'
  if (edge.edgeKind === 'partner') return `partner of ${other}`
  // parent_child: from = parent, to = child.
  return edge.fromPerson === personId ? `parent of ${other}` : `child of ${other}`
}

function RelationshipsSection({
  groupId,
  person,
  myEdges,
  names,
  candidates,
  siblings,
  onChanged,
}: {
  groupId: string
  person: PersonNode
  myEdges: Edge[]
  names: Record<string, string>
  candidates: PersonNode[]
  siblings: InferredSibling[]
  onChanged: () => void
}) {
  const [choice, setChoice] = useState<RelChoice>('child_of')
  const [otherId, setOtherId] = useState('')
  const [subtype, setSubtype] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function removeEdge(edgeId: string) {
    setBusyId(edgeId)
    setError(null)
    try {
      await deleteEdge(groupId, edgeId)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove')
    } finally {
      setBusyId(null)
    }
  }

  async function add() {
    if (!otherId) return
    setAdding(true)
    setError(null)
    try {
      await createEdge(
        groupId,
        buildEdgeInput(choice, person.nodeId, otherId, subtype),
      )
      setOtherId('')
      setSubtype('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {myEdges.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {myEdges.map((e) => (
            <li
              key={e.edgeId}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-zinc-300">
                {describeEdge(e, person.nodeId, names)}
                <span className="ml-2 text-xs text-zinc-500">{e.subtype}</span>
              </span>
              <button
                onClick={() => removeEdge(e.edgeId)}
                disabled={busyId === e.edgeId}
                className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No relationships yet.</p>
      )}

      {siblings.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-zinc-500">
            Siblings (inferred from shared parents)
          </p>
          <ul className="flex flex-col gap-0.5">
            {siblings.map((s) => (
              <li key={s.nodeId} className="text-sm text-zinc-400">
                sibling of {s.name}
                <span className="ml-2 text-xs text-zinc-500">
                  {s.half ? 'half' : 'full'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          <RelationshipFields
            choice={choice}
            setChoice={setChoice}
            otherId={otherId}
            setOtherId={setOtherId}
            subtype={subtype}
            setSubtype={setSubtype}
            candidates={candidates}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            className={primaryBtn}
            onClick={add}
            disabled={adding || !otherId}
          >
            {adding ? 'Adding…' : 'Add relationship'}
          </button>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">
          Everyone else is already connected to this person.
        </p>
      )}
    </div>
  )
}
