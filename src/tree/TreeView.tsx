import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getGraph,
  getMembers,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
  linkPersonNode,
  unlinkPersonNode,
  SUBTYPES,
  ApiError,
  type Group,
  type Graph,
  type PersonNode,
  type Edge,
  type EdgeInput,
  type Member,
} from '../api'
import GraphCanvas from './GraphCanvas'
import { inferSiblings, type InferredSibling } from './siblings'
import { suggestOtherParents, type ParentSuggestion } from './suggestions'
import { fullName, bornSuffix, namePartsOf } from './names'
import PersonPicker from '../components/PersonPicker'

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
  const [members, setMembers] = useState<Member[]>([])
  const [me, setMe] = useState('')
  const [status, setStatus] = useState<Status>({ state: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isFull, setIsFull] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const reload = useCallback(async () => {
    try {
      // Members come along so the tree can show who's who (which node each
      // signed-in account has claimed) and offer the "this is me" control.
      const [g, m] = await Promise.all([
        getGraph(group.groupId),
        getMembers(group.groupId),
      ])
      setGraph(g)
      setMembers(m.members)
      setMe(m.me)
      setStatus({ state: 'ready' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return
      setStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Failed to load',
      })
    }
  }, [group.groupId])

  const memberById = useMemo(() => {
    const o: Record<string, Member> = {}
    for (const m of members) o[m.accountId] = m
    return o
  }, [members])
  const myMember = memberById[me]
  const isOwner = myMember?.role === 'owner'
  const myNodeId = myMember?.linkedNodeId ?? null

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
            meNodeId={myNodeId}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 text-[10px]">
                ?
              </span>
              Help &amp; legend
            </button>
          </div>
          {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

          {/* Editing a person replaces the add-person form so the screen stays
              focused on that person. */}
          {selected ? (
            <PersonPanel
              key={selected.nodeId}
              groupId={group.groupId}
              person={selected}
              graph={graph}
              me={me}
              memberById={memberById}
              isOwner={isOwner}
              onChanged={reload}
              onDeleted={() => {
                setSelectedId(null)
                reload()
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <AddPersonForm
              groupId={group.groupId}
              onAdded={(newId) => {
                setSelectedId(newId)
                reload()
              }}
            />
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

// All graph help — view modes, gestures, and the marker legend — behind one
// dismissible overlay, so the tree screen itself stays uncluttered.
function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Graph help"
    >
      <div
        className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium text-zinc-100">Graph help</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="flex h-8 w-8 items-center justify-center rounded-md text-lg text-zinc-400 hover:bg-zinc-800"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 text-sm text-zinc-300">
          <section>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              Views
            </h3>
            <p>
              <span className="text-zinc-100">Tree</span> — everyone, laid out
              by generation.
            </p>
            <p>
              <span className="text-zinc-100">Focus</span> — zoom in on one
              person and their close family; tap anyone to re-center on them.
            </p>
            <p>
              <span className="text-zinc-100">Radial</span> — one person at the
              center, with a color-coded fan of ancestors above and descendants
              below (one hue per family branch); spouses show as thin bands and
              siblings flank the center. Tap anyone to re-root the chart on them.
              Best for large or complex families on a phone.
            </p>
          </section>

          <section>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              Getting around
            </h3>
            <p>
              Drag to pan · pinch or scroll to zoom · ⌾ re-fits · ⤢ goes
              fullscreen · tap a person to edit them or add relationships.
            </p>
          </section>

          <section>
            <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              Who's who
            </h3>
            <p>
              Tap a person and use{' '}
              <span className="text-zinc-100">This is me</span> to claim your own
              node. In the <span className="text-zinc-100">Group</span> tab you
              can link any member to their person, so the tree shows who each
              account is.
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
              Legend
            </h3>
            <Legend />
          </section>
        </div>
      </div>
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
        <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-amber-400" />{' '}
        adopted / step
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-zinc-400" />{' '}
        ended
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 rounded-sm bg-rose-500/40" /> spouse
        band (radial)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed border-zinc-400" />{' '}
        half-sibling
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex h-3 w-3 overflow-hidden rounded-full">
          <span className="h-full w-1/2 bg-sky-500/50" />
          <span className="h-full w-1/2 bg-rose-500/50" />
        </span>{' '}
        fan color = family branch
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-emerald-400" />{' '}
        you
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-amber-400" />{' '}
        focused on
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> claimed by a
        member
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

// Birth/death dates are stored free-form, so they can hold anything GEDCOM does
// — a full date, a year, or an approximate value like "ABT 1850". The editable
// field is therefore a plain text box (it clears reliably and accepts a year or
// an approximate date, which a native date input can't). A calendar button
// summons the native date picker for the common exact-date case, writing the
// chosen ISO date back into the text field.
function DateField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <input
        type="text"
        className={`${inputClass} pr-10`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {/* A transparent native date input overlaid on the calendar icon. Tapping
          the icon actually taps this input, so the native picker opens directly
          (reliable on mobile, no showPicker needed); picking a date writes its
          ISO value into the free-form text field. Seeded from the current value
          only when it's a full ISO date the picker can represent. */}
      <span className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center">
        <span aria-hidden className="pointer-events-none text-zinc-400">
          📅
        </span>
        <input
          type="date"
          aria-label="Pick a date"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={ISO_DATE.test(value) ? value : ''}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          onClick={(e) => e.currentTarget.showPicker?.()}
        />
      </span>
    </div>
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
        <div className="min-w-0 flex-1">
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
        </div>
        <div className="min-w-0 flex-1">
          <PersonPicker
            ariaLabel="Select person"
            options={candidates.map((p) => ({ id: p.nodeId, label: p.name }))}
            value={otherId || null}
            onChange={(id) => setOtherId(id ?? '')}
          />
        </div>
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
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [middleName, setMiddleName] = useState('')
  const [birthName, setBirthName] = useState('')
  const [birthdate, setBirthdate] = useState('')
  // Middle and birth names are the exception, not the rule — keep them tucked
  // away so the common path stays two fields.
  const [showMore, setShowMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!firstName.trim()) return
    setBusy(true)
    setError(null)
    try {
      const node = await createNode(groupId, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        middleName: middleName.trim() || null,
        birthName: birthName.trim() || null,
        birthdate: birthdate.trim() || null,
      })
      setFirstName('')
      setLastName('')
      setMiddleName('')
      setBirthName('')
      setBirthdate('')
      setShowMore(false)
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
      <Field label="First name">
        <input
          className={inputClass}
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="e.g. Ada"
        />
      </Field>
      <Field label="Last name (optional)">
        <input
          className={inputClass}
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="e.g. Lovelace"
        />
      </Field>
      {showMore ? (
        <>
          <Field label="Middle name (optional)">
            <input
              className={inputClass}
              value={middleName}
              onChange={(e) => setMiddleName(e.target.value)}
              placeholder="e.g. Byron"
            />
          </Field>
          <Field label="Birth name (optional)">
            <input
              className={inputClass}
              value={birthName}
              onChange={(e) => setBirthName(e.target.value)}
              placeholder="Name at birth"
            />
          </Field>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="self-start text-xs text-zinc-500 hover:text-zinc-300"
        >
          + Middle / birth name
        </button>
      )}
      <Field label="Birthdate (optional)">
        <DateField
          value={birthdate}
          onChange={setBirthdate}
          placeholder="e.g. 1979 or 1979-05-01"
        />
      </Field>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        className={primaryBtn}
        onClick={submit}
        disabled={busy || !firstName.trim()}
      >
        {busy ? 'Adding…' : 'Add person'}
      </button>
    </div>
  )
}

function buildPersonPatch({
  firstName,
  lastName,
  middleName,
  birthName,
  birthdate,
  deathdate,
  notes,
  saved,
  isLegacyName,
}: {
  firstName: string
  lastName: string
  middleName: string
  birthName: string
  birthdate: string
  deathdate: string
  notes: string
  saved: {
    firstName: string
    lastName: string
    middleName: string
    birthName: string
    birthdate: string
    deathdate: string
    notes: string
  }
  isLegacyName: boolean
}): Parameters<typeof updateNode>[2] {
  const patch: Parameters<typeof updateNode>[2] = {}
  const nextFirstName = firstName.trim()
  const structuredDirty =
    firstName !== saved.firstName ||
    lastName !== saved.lastName ||
    middleName !== saved.middleName ||
    birthName !== saved.birthName

  if (firstName !== saved.firstName) patch.firstName = nextFirstName
  if (lastName !== saved.lastName) patch.lastName = lastName.trim() || null
  if (middleName !== saved.middleName) patch.middleName = middleName.trim() || null
  if (birthName !== saved.birthName) patch.birthName = birthName.trim() || null
  if (birthdate !== saved.birthdate) patch.birthdate = birthdate.trim() || null
  if (deathdate !== saved.deathdate) patch.deathdate = deathdate.trim() || null
  if (notes !== saved.notes) patch.notes = notes.trim() || null

  // Ensure legacy rows also send firstName when any structured field changes,
  // so migrating an old single-string name can't persist only lastName/birthName.
  if (structuredDirty && isLegacyName && patch.firstName === undefined) {
    patch.firstName = nextFirstName
  }

  return patch
}

function PersonPanel({
  groupId,
  person,
  graph,
  me,
  memberById,
  isOwner,
  onChanged,
  onDeleted,
  onClose,
}: {
  groupId: string
  person: PersonNode
  graph: Graph
  me: string
  memberById: Record<string, Member>
  isOwner: boolean
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  // Seed the structured fields from the node, splitting a legacy single name
  // into first/last so editing an old person starts sensibly if the user opts to
  // review those fields.
  const initialParts = namePartsOf(person)
  const isLegacyName =
    !person.firstName && !person.lastName && !person.middleName && !person.birthName
  const [firstName, setFirstName] = useState(initialParts.firstName)
  const [lastName, setLastName] = useState(initialParts.lastName)
  const [middleName, setMiddleName] = useState(initialParts.middleName)
  const [birthName, setBirthName] = useState(initialParts.birthName)
  const [showMore, setShowMore] = useState(
    Boolean(initialParts.middleName || initialParts.birthName),
  )
  const [birthdate, setBirthdate] = useState(person.birthdate ?? '')
  const [deathdate, setDeathdate] = useState(person.deathdate ?? '')
  const [notes, setNotes] = useState(person.notes ?? '')
  const [save, setSave] = useState<SaveState>({ state: 'idle' })

  // The last values we know are persisted, so we only auto-save real changes.
  const saved = useRef({
    firstName: initialParts.firstName,
    lastName: initialParts.lastName,
    middleName: initialParts.middleName,
    birthName: initialParts.birthName,
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
  // Likely "other parent(s)" — partners of this person's known parents who
  // aren't already parents themselves — offered as one-tap adds below.
  const parentSuggestions = useMemo(
    () => suggestOtherParents(graph, person.nodeId, connected),
    // `connected` is recomputed each render, but suggestOtherParents is cheap
    // and derived from the same graph/edges, so key on graph + person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, person.nodeId],
  )

  // Auto-save: after a short pause once a field actually changes. An empty first
  // name is the one thing we refuse to persist.
  useEffect(() => {
    const dirty =
      firstName !== saved.current.firstName ||
      lastName !== saved.current.lastName ||
      middleName !== saved.current.middleName ||
      birthName !== saved.current.birthName ||
      birthdate !== saved.current.birthdate ||
      deathdate !== saved.current.deathdate ||
      notes !== saved.current.notes
    if (!dirty) return
    if (!firstName.trim()) {
      setSave({ state: 'error', message: 'First name can’t be empty' })
      return
    }
    const t = setTimeout(async () => {
      setSave({ state: 'saving' })
      try {
        const patch = buildPersonPatch({
          firstName,
          lastName,
          middleName,
          birthName,
          birthdate,
          deathdate,
          notes,
          saved: saved.current,
          isLegacyName,
        })

        await updateNode(groupId, person.nodeId, patch)
        saved.current = {
          firstName,
          lastName,
          middleName,
          birthName,
          birthdate,
          deathdate,
          notes,
        }
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
  }, [
    firstName,
    lastName,
    middleName,
    birthName,
    birthdate,
    deathdate,
    notes,
    groupId,
    person.nodeId,
    isLegacyName,
    onChanged,
  ])

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-zinc-200">
            {fullName({ firstName, lastName, middleName }) || 'Edit person'}
          </p>
          {bornSuffix({ lastName, birthName }) && (
            <p className="text-xs italic text-zinc-500">
              {bornSuffix({ lastName, birthName })}
            </p>
          )}
        </div>
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

      <Field label="First name">
        <input
          className={inputClass}
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="e.g. Ada"
        />
      </Field>
      <Field label="Last name (optional)">
        <input
          className={inputClass}
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          placeholder="e.g. Lovelace"
        />
      </Field>
      {showMore ? (
        <>
          <Field label="Middle name (optional)">
            <input
              className={inputClass}
              value={middleName}
              onChange={(e) => setMiddleName(e.target.value)}
              placeholder="e.g. Byron"
            />
          </Field>
          <Field label="Birth name (optional)">
            <input
              className={inputClass}
              value={birthName}
              onChange={(e) => setBirthName(e.target.value)}
              placeholder="Name at birth"
            />
          </Field>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="self-start text-xs text-zinc-500 hover:text-zinc-300"
        >
          + Middle / birth name
        </button>
      )}
      <Field label="Birthdate">
        <DateField value={birthdate} onChange={setBirthdate} placeholder="e.g. 1979 or 1979-05-01" />
      </Field>
      <Field label="Death date">
        <DateField value={deathdate} onChange={setDeathdate} placeholder="e.g. 1966 or 1966-03-20" />
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

      <LinkSection
        groupId={groupId}
        person={person}
        me={me}
        memberById={memberById}
        isOwner={isOwner}
        onChanged={onChanged}
      />

      <div className="border-t border-zinc-800 pt-3">
        <p className="mb-2 text-sm font-medium text-zinc-300">Relationships</p>
        <RelationshipsSection
          groupId={groupId}
          person={person}
          myEdges={myEdges}
          names={names}
          candidates={candidates}
          siblings={siblings}
          parentSuggestions={parentSuggestions}
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

// Small inline spinner for in-progress buttons. `dark` flips it for use on a
// light (primary) button; otherwise it inherits the current text color.
function Spinner({ dark }: { dark?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t-transparent ${
        dark ? 'border-zinc-900/60' : 'border-current'
      }`}
    />
  )
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

// "This is me": claim (or release) a person as the signed-in account. A member
// manages their own link freely; owners can additionally unlink anyone (to fix
// a wrong claim). This UI hides "This is me" once you're already linked, so
// re-linking yourself here means unlinking first and then claiming the new one.
function LinkSection({
  groupId,
  person,
  me,
  memberById,
  isOwner,
  onChanged,
}: {
  groupId: string
  person: PersonNode
  me: string
  memberById: Record<string, Member>
  isOwner: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linkedAccountId = person.accountId
  const linkedMember = linkedAccountId ? memberById[linkedAccountId] : null
  const isMe = linkedAccountId != null && linkedAccountId === me
  const myNodeId = memberById[me]?.linkedNodeId ?? null

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-zinc-800 pt-3">
      <p className="mb-2 text-sm font-medium text-zinc-300">Identity</p>
      {linkedAccountId ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-zinc-300">
            {isMe ? (
              <>
                This is <span className="text-emerald-400">you</span>
              </>
            ) : (
              <>
                Linked to{' '}
                <span className="text-zinc-100">
                  {linkedMember?.name || linkedMember?.email || 'a member'}
                </span>
              </>
            )}
          </p>
          {(isMe || isOwner) && (
            <button
              onClick={() => run(() => unlinkPersonNode(groupId, linkedAccountId))}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
            >
              {busy && <Spinner />}
              {busy ? 'Unlinking…' : 'Unlink'}
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-zinc-400">No one has claimed this person yet.</p>
            {/* Only offer "This is me" to a caller who hasn't claimed anyone yet;
                once linked, they unlink from their own node before re-claiming. */}
            {!myNodeId && (
              <button
                onClick={() => run(() => linkPersonNode(groupId, me, person.nodeId))}
                disabled={busy}
                className={`flex items-center gap-1.5 ${primaryBtn}`}
              >
                {busy && <Spinner dark />}
                {busy ? 'Linking…' : 'This is me'}
              </button>
            )}
          </div>
          {myNodeId && myNodeId !== person.nodeId && (
            <p className="text-xs text-zinc-500">
              You're linked to someone else. Unlink there first to claim this
              person.
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    // A person delete cascades to their relationships and can't be undone, so
    // gate it behind an explicit confirmation dialog.
    if (
      !window.confirm(
        `Delete ${person.name}? This also removes their relationships and can’t be undone.`,
      )
    ) {
      return
    }
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
      <button
        onClick={remove}
        disabled={busy}
        className="text-sm text-red-400 hover:text-red-300 disabled:opacity-40"
      >
        {busy ? 'Deleting…' : 'Delete person'}
      </button>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
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
  parentSuggestions,
  onChanged,
}: {
  groupId: string
  person: PersonNode
  myEdges: Edge[]
  names: Record<string, string>
  candidates: PersonNode[]
  siblings: InferredSibling[]
  parentSuggestions: ParentSuggestion[]
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

  // One-tap add for a suggested other parent: the suggestion is a parent of this
  // person, i.e. a `child_of` edge with the default subtype.
  async function addSuggestedParent(nodeId: string) {
    setBusyId(nodeId)
    setError(null)
    try {
      await createEdge(groupId, buildEdgeInput('child_of', person.nodeId, nodeId, ''))
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setBusyId(null)
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

      {parentSuggestions.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border border-sky-900/60 bg-sky-950/30 p-2.5">
          <p className="text-xs uppercase tracking-wide text-sky-300/80">
            Likely other parent
          </p>
          <ul className="flex flex-col gap-1.5">
            {parentSuggestions.map((s) => (
              <li key={s.nodeId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-zinc-200">
                  {s.name}
                  <span className="ml-1.5 text-xs text-zinc-500">
                    partner of {s.viaParentName}
                  </span>
                </span>
                <button
                  onClick={() => addSuggestedParent(s.nodeId)}
                  disabled={busyId === s.nodeId}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-800 px-2 py-1 text-xs text-sky-200 hover:bg-sky-900/40 disabled:opacity-40"
                >
                  {busyId === s.nodeId && <Spinner />}
                  Add as parent
                </button>
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
