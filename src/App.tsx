import { useEffect, useState, type ReactNode } from 'react'
import AuthButton from './components/AuthButton'
import {
  getCredential,
  onCredentialChange,
  clearCredential,
  decodeEmail,
} from './auth'
import {
  getMe,
  createGroup,
  renameGroup,
  ApiError,
  type Me,
  type Group,
} from './api'
import TreeView from './tree/TreeView'
import MembersPanel from './members/MembersPanel'
import JoinScreen from './members/JoinScreen'
import { APP_TITLE } from './appTitle'

type Load =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; me: Me }
  | { status: 'error'; message: string }

export default function App() {
  const [credential, setCred] = useState<string | null>(getCredential())
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  // An invite link is /?invite=<token>. When present, the join flow takes over
  // the whole screen for both signed-out and signed-in visitors.
  const inviteToken = new URLSearchParams(window.location.search).get('invite')

  // Track sign-in/out.
  useEffect(() => onCredentialChange(setCred), [])

  // Whenever we have a credential, load "who am I / what groups am I in".
  useEffect(() => {
    if (!credential) {
      setLoad({ status: 'idle' })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    getMe()
      .then((me) => !cancelled && setLoad({ status: 'ready', me }))
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) return
        const message = err instanceof Error ? err.message : 'Request failed'
        setLoad({ status: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [credential])

  // After creating a group, re-fetch /me so the new group shows up, and switch
  // to it.
  async function handleCreated(group: Group) {
    try {
      const me = await getMe()
      setLoad({ status: 'ready', me })
      setActiveGroupId(group.groupId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed'
      setLoad({ status: 'error', message })
    }
  }

  // Re-fetch /me after a group change (e.g. a rename) so the switcher and titles
  // pick up the new name, without disturbing the active selection.
  async function refreshMe() {
    try {
      const me = await getMe()
      setLoad({ status: 'ready', me })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed'
      setLoad({ status: 'error', message })
    }
  }

  if (inviteToken) {
    return <JoinScreen token={inviteToken} signedIn={!!credential} />
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 px-5 py-10">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{APP_TITLE}</h1>
        {credential && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-[8.5rem] truncate text-xs text-zinc-500">
              {decodeEmail(credential) ?? 'your account'}
            </span>
            <button
              onClick={clearCredential}
              className="shrink-0 text-sm text-zinc-400 hover:text-zinc-200"
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      {!credential && (
        <section className="flex flex-col items-start gap-3">
          <p className="text-zinc-400">Sign in to see your family group.</p>
          <AuthButton />
        </section>
      )}

      {credential && (
        <section className="flex flex-col gap-4">
          {load.status === 'loading' && (
            <p className="text-zinc-400">Loading…</p>
          )}

          {load.status === 'error' && (
            <p className="text-red-400">Error: {load.message}</p>
          )}

          {load.status === 'ready' && load.me.groups.length > 0 && (
            <GroupWorkspace
              groups={load.me.groups}
              activeGroupId={activeGroupId}
              onSelect={setActiveGroupId}
              onCreated={handleCreated}
              onRenamed={refreshMe}
            />
          )}

          {load.status === 'ready' && load.me.groups.length === 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-zinc-400">
                You're not in a group yet. Create one to get started.
              </p>
              <CreateGroupForm onCreated={handleCreated} />
            </div>
          )}
        </section>
      )}
    </main>
  )
}

// Once the caller is in at least one group, this is the workspace. Two tabs:
// "Group" (switch between groups, rename, start a new one, and manage members)
// and "Tree" (the Phase 1 graph). Group leads because that's where you pick
// which family you're looking at. A person can belong to multiple groups, each
// an isolated graph.
function GroupWorkspace({
  groups,
  activeGroupId,
  onSelect,
  onCreated,
  onRenamed,
}: {
  groups: Group[]
  activeGroupId: string | null
  onSelect: (groupId: string) => void
  onCreated: (group: Group) => Promise<void> | void
  onRenamed: () => Promise<void> | void
}) {
  const active =
    groups.find((g) => g.groupId === activeGroupId) ?? groups[0]
  const [tab, setTab] = useState<'group' | 'tree'>('group')

  return (
    <div className="flex flex-col gap-4">
      <p className="truncate text-lg font-medium">{active.name}</p>

      <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1 text-sm">
        <TabButton active={tab === 'group'} onClick={() => setTab('group')}>
          Group
        </TabButton>
        <TabButton active={tab === 'tree'} onClick={() => setTab('tree')}>
          Tree
        </TabButton>
      </div>

      {tab === 'group' ? (
        <GroupPanel
          key={active.groupId}
          groups={groups}
          active={active}
          onSelect={onSelect}
          onCreated={onCreated}
          onRenamed={onRenamed}
        />
      ) : (
        <TreeView group={active} />
      )}
    </div>
  )
}

// The "Group" tab: pick which group you're in, rename it, start a new one, then
// manage its members and invites (the old Members panel, now nested here).
function GroupPanel({
  groups,
  active,
  onSelect,
  onCreated,
  onRenamed,
}: {
  groups: Group[]
  active: Group
  onSelect: (groupId: string) => void
  onCreated: (group: Group) => Promise<void> | void
  onRenamed: () => Promise<void> | void
}) {
  const [creatingGroup, setCreatingGroup] = useState(false)

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        {groups.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Current group
            <div className="relative">
              <select
                aria-label="Switch group"
                value={active.groupId}
                onChange={(e) => onSelect(e.target.value)}
                className="w-full appearance-none rounded-md border border-zinc-700 bg-zinc-950 py-2 pl-3 pr-9 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
              >
                {groups.map((g) => (
                  <option key={g.groupId} value={g.groupId}>
                    {g.name}
                  </option>
                ))}
              </select>
              <span
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400"
              >
                ▼
              </span>
            </div>
          </label>
        )}

        <RenameGroupForm group={active} onRenamed={onRenamed} />

        {!creatingGroup ? (
          <button
            onClick={() => setCreatingGroup(true)}
            className="self-start text-sm text-zinc-400 hover:text-zinc-200"
          >
            + New group
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-300">New group</p>
              <button
                onClick={() => setCreatingGroup(false)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
            <CreateGroupForm
              onCreated={async (group) => {
                setCreatingGroup(false)
                await onCreated(group)
              }}
            />
          </div>
        )}
      </section>

      <div className="border-t border-zinc-800" />

      <MembersPanel key={active.groupId} group={active} />
    </div>
  )
}

// Rename the active group. Any member may rename (enforced server-side); the
// field seeds from the current name and saves on submit.
function RenameGroupForm({
  group,
  onRenamed,
}: {
  group: Group
  onRenamed: () => Promise<void> | void
}) {
  // Seeded fresh per group: GroupPanel is keyed on groupId, so switching groups
  // remounts this form with the new name rather than needing a reseed effect.
  const [name, setName] = useState(group.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const trimmed = name.trim()
  const dirty = trimmed !== group.name && trimmed.length > 0

  async function submit() {
    if (!dirty) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await renameGroup(group.groupId, trimmed)
      await onRenamed()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
      Group name
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setSaved(false)
          }}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={saving || !dirty}
          className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Rename'}
        </button>
      </div>
      {error && <p className="text-xs normal-case text-red-400">{error}</p>}
      {saved && !dirty && (
        <p className="text-xs normal-case text-emerald-500">Group renamed</p>
      )}
    </label>
  )
}

// Reusable "name a new group and create it" form. Used both for a member's
// first group and the "New group" affordance in the workspace.
function CreateGroupForm({
  onCreated,
}: {
  onCreated: (group: Group) => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!name.trim()) return
    setCreating(true)
    setError('')
    try {
      const group = await createGroup(name.trim())
      setName('')
      await onCreated(group)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Group name (e.g. The Lotts)"
        className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        onClick={submit}
        disabled={creating || !name.trim()}
        className="rounded-md bg-zinc-100 px-3 py-2 font-medium text-zinc-900 disabled:opacity-40"
      >
        {creating ? 'Creating…' : 'Create group'}
      </button>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${
        active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}
