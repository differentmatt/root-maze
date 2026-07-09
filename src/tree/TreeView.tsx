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
  if (choice === 'partner_of') {
    return { edgeKind: 'partner', fromPerson: refId, toPerson: otherId, subtype }
  }
  if (choice === 'parent_of') {
    return { edgeKind: 'parent_child', fromPerson: refId, toPerson: otherId, subtype }
  }
  // child_of: the other person is the parent.
  return { edgeKind: 'parent_child', fromPerson: otherId, toPerson: refId, subtype }
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

  // One panel element, shown inline normally or layered over the graph while
  // fullscreen — so selecting a person in fullscreen doesn't drop you out of it.
  const panel = selected ? (
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
  ) : null

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
            onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
            isFull={isFull}
            onFullscreenChange={setIsFull}
          />

          {/* Inline layout (not fullscreen). Editing a person replaces the
              add-person form so the screen stays focused on that person. */}
          {!isFull && (
            <>
              <Legend />
              {selected ? (
                panel
              ) : (
                <>
                  <p className="text-sm text-zinc-500">
                    Tap a person in the graph to edit them or add relationships.
                  </p>
                  <AddPersonForm
                    groupId={group.groupId}
                    people={graph.nodes}
                    onAdded={(newId) => {
                      setSelectedId(newId)
                      reload()
                    }}
                  />
                </>
              )}
            </>
          )}

          {/* Fullscreen: the graph is a full-screen overlay; layer the edit
              panel over its lower half as a scrollable sheet. */}
          {isFull && selected && (
            <div className="fixed inset-x-0 bottom-0 z-[60] max-h-[70vh] overflow-y-auto border-t border-zinc-700 bg-zinc-950 p-4">
              {panel}
            </div>
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

function AddPersonForm({
  groupId,
  people,
  onAdded,
}: {
  groupId: string
  people: PersonNode[]
  onAdded: (newNodeId: string) => void
}) {
  const [name, setName] = useState('')
  const [birthdate, setBirthdate] = useState('')
  const [withRel, setWithRel] = useState(false)
  const [choice, setChoice] = useState<RelChoice>('child_of')
  const [otherId, setOtherId] = useState('')
  const [subtype, setSubtype] = useState('')
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
      if (withRel && otherId) {
        await createEdge(
          groupId,
          buildEdgeInput(choice, node.nodeId, otherId, subtype),
        )
      }
      setName('')
      setBirthdate('')
      setWithRel(false)
      setOtherId('')
      setSubtype('')
      onAdded(node.nodeId)
    } catch (err) {
      // The person may have been created even if the relationship failed;
      // surface the error and let the reload reflect reality.
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
      <DateField
        value={birthdate}
        onChange={setBirthdate}
        placeholder="Birthdate (optional)"
      />

      {people.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={withRel}
            onChange={(e) => setWithRel(e.target.checked)}
            className="h-4 w-4 accent-zinc-300"
          />
          Also link to someone
        </label>
      )}

      {withRel && people.length > 0 && (
        <RelationshipFields
          choice={choice}
          setChoice={setChoice}
          otherId={otherId}
          setOtherId={setOtherId}
          subtype={subtype}
          setSubtype={setSubtype}
          candidates={people}
        />
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        className={primaryBtn}
        onClick={submit}
        disabled={busy || !name.trim() || (withRel && !otherId)}
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      onChanged()
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
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
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
      <DateField value={birthdate} onChange={setBirthdate} placeholder="Birthdate" />
      <DateField value={deathdate} onChange={setDeathdate} placeholder="Death date (optional)" />
      <textarea
        className={inputClass}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button className={primaryBtn} onClick={save} disabled={busy || !name.trim()}>
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
