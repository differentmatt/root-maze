import { useCallback, useEffect, useMemo, useState } from 'react'
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
  type EdgeKind,
} from '../api'
import GraphCanvas from './GraphCanvas'

type Status =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; message: string }

// The Phase 1 group screen: the graph canvas plus forms to add people and
// relationships, and a panel to edit or remove the selected person.
export default function TreeView({ group }: { group: Group }) {
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] })
  const [status, setStatus] = useState<Status>({ state: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  return (
    <section className="flex flex-col gap-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-zinc-500">Group</p>
        <p className="text-lg font-medium">{group.name}</p>
      </div>

      {status.state === 'error' && (
        <p className="text-sm text-red-400">Error: {status.message}</p>
      )}

      <GraphCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
      />

      <Legend />

      {selected && (
        <PersonPanel
          key={selected.nodeId}
          groupId={group.groupId}
          person={selected}
          onSaved={reload}
          onDeleted={() => {
            setSelectedId(null)
            reload()
          }}
          onClose={() => setSelectedId(null)}
        />
      )}

      <AddPersonForm groupId={group.groupId} onAdded={reload} />

      <AddRelationshipForm
        groupId={group.groupId}
        people={graph.nodes}
        onAdded={reload}
      />

      <RelationshipList
        groupId={group.groupId}
        graph={graph}
        onDeleted={reload}
      />
    </section>
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
  'rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none'
const cardClass =
  'flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4'
const primaryBtn =
  'rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40'

function AddPersonForm({
  groupId,
  onAdded,
}: {
  groupId: string
  onAdded: () => void
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
      await createNode(groupId, {
        name: name.trim(),
        birthdate: birthdate.trim() || null,
      })
      setName('')
      setBirthdate('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cardClass}>
      <p className="text-sm font-medium text-zinc-300">Add a person</p>
      <input
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
      />
      <input
        className={inputClass}
        value={birthdate}
        onChange={(e) => setBirthdate(e.target.value)}
        placeholder="Birth year or date (optional)"
      />
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

function AddRelationshipForm({
  groupId,
  people,
  onAdded,
}: {
  groupId: string
  people: Graph['nodes']
  onAdded: () => void
}) {
  const [kind, setKind] = useState<EdgeKind>('parent_child')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [subtype, setSubtype] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const labels =
    kind === 'parent_child'
      ? { from: 'Parent', to: 'Child' }
      : { from: 'Partner', to: 'Partner' }

  if (people.length < 2) {
    return (
      <div className={cardClass}>
        <p className="text-sm font-medium text-zinc-300">Add a relationship</p>
        <p className="text-sm text-zinc-500">
          Add at least two people first.
        </p>
      </div>
    )
  }

  async function submit() {
    if (!from || !to || from === to) {
      setError('Pick two different people.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createEdge(groupId, {
        edgeKind: kind,
        fromPerson: from,
        toPerson: to,
        subtype: subtype || undefined,
      })
      setFrom('')
      setTo('')
      setSubtype('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cardClass}>
      <p className="text-sm font-medium text-zinc-300">Add a relationship</p>

      <select
        className={inputClass}
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as EdgeKind)
          setSubtype('')
        }}
      >
        <option value="parent_child">Parent → Child</option>
        <option value="partner">Partners</option>
      </select>

      <label className="text-xs text-zinc-500">{labels.from}</label>
      <select
        className={inputClass}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
      >
        <option value="">Select…</option>
        {people.map((p) => (
          <option key={p.nodeId} value={p.nodeId}>
            {p.name}
          </option>
        ))}
      </select>

      <label className="text-xs text-zinc-500">{labels.to}</label>
      <select
        className={inputClass}
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        <option value="">Select…</option>
        {people.map((p) => (
          <option key={p.nodeId} value={p.nodeId}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        className={inputClass}
        value={subtype}
        onChange={(e) => setSubtype(e.target.value)}
      >
        {SUBTYPES[kind].map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className={primaryBtn} onClick={submit} disabled={busy}>
        {busy ? 'Adding…' : 'Add relationship'}
      </button>
    </div>
  )
}

function PersonPanel({
  groupId,
  person,
  onSaved,
  onDeleted,
  onClose,
}: {
  groupId: string
  person: Graph['nodes'][number]
  onSaved: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(person.name)
  const [birthdate, setBirthdate] = useState(person.birthdate ?? '')
  const [deathdate, setDeathdate] = useState(person.deathdate ?? '')
  const [notes, setNotes] = useState(person.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await updateNode(groupId, person.nodeId, {
        name: name.trim(),
        birthdate: birthdate.trim() || null,
        deathdate: deathdate.trim() || null,
        notes: notes.trim() || null,
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await deleteNode(groupId, person.nodeId)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-200">Edit person</p>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Close
        </button>
      </div>
      <input
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
      />
      <input
        className={inputClass}
        value={birthdate}
        onChange={(e) => setBirthdate(e.target.value)}
        placeholder="Birth year or date"
      />
      <input
        className={inputClass}
        value={deathdate}
        onChange={(e) => setDeathdate(e.target.value)}
        placeholder="Death date (optional)"
      />
      <textarea
        className={inputClass}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          className={primaryBtn}
          onClick={save}
          disabled={busy || !name.trim()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          className="rounded-md border border-red-900 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-40"
          onClick={remove}
          disabled={busy}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

function RelationshipList({
  groupId,
  graph,
  onDeleted,
}: {
  groupId: string
  graph: Graph
  onDeleted: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const names = useMemo(() => {
    const m: Record<string, string> = {}
    for (const n of graph.nodes) m[n.nodeId] = n.name
    return m
  }, [graph.nodes])

  if (graph.edges.length === 0) return null

  async function remove(edgeId: string) {
    setBusyId(edgeId)
    try {
      await deleteEdge(groupId, edgeId)
      onDeleted()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={cardClass}>
      <p className="text-sm font-medium text-zinc-300">Relationships</p>
      <ul className="flex flex-col gap-2">
        {graph.edges.map((e) => {
          const arrow = e.edgeKind === 'parent_child' ? '→' : '↔'
          return (
            <li
              key={e.edgeId}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-zinc-300">
                {names[e.fromPerson] ?? '?'} {arrow}{' '}
                {names[e.toPerson] ?? '?'}
                <span className="ml-2 text-xs text-zinc-500">{e.subtype}</span>
              </span>
              <button
                onClick={() => remove(e.edgeId)}
                disabled={busyId === e.edgeId}
                className="text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
