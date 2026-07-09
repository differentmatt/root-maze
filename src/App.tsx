import { useEffect, useState, type ReactNode } from 'react'
import AuthButton from './components/AuthButton'
import {
  getCredential,
  onCredentialChange,
  clearCredential,
  decodeEmail,
} from './auth'
import { getMe, createGroup, ApiError, type Me, type Group } from './api'
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
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
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

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    try {
      await createGroup(name.trim())
      const me = await getMe()
      setLoad({ status: 'ready', me })
      setName('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed'
      setLoad({ status: 'error', message })
    } finally {
      setCreating(false)
    }
  }

  if (inviteToken) {
    return <JoinScreen token={inviteToken} signedIn={!!credential} />
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 px-5 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{APP_TITLE}</h1>
        {credential && (
          <button
            onClick={clearCredential}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            Sign out
          </button>
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
          <p className="text-sm text-zinc-500">
            Signed in as {decodeEmail(credential) ?? 'your account'}
          </p>

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
            />
          )}

          {load.status === 'ready' && load.me.groups.length === 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-zinc-400">
                You're not in a group yet. Create one to get started.
              </p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Group name (e.g. The Lotts)"
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
              <button
                onClick={handleCreate}
                disabled={creating || !name.trim()}
                className="rounded-md bg-zinc-100 px-3 py-2 font-medium text-zinc-900 disabled:opacity-40"
              >
                {creating ? 'Creating…' : 'Create group'}
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  )
}

// Once the caller is in at least one group, this is the workspace: an optional
// switcher (only when they belong to more than one group) over the Phase 1
// tree view. A person can belong to multiple groups, each an isolated graph.
function GroupWorkspace({
  groups,
  activeGroupId,
  onSelect,
}: {
  groups: Group[]
  activeGroupId: string | null
  onSelect: (groupId: string) => void
}) {
  const active =
    groups.find((g) => g.groupId === activeGroupId) ?? groups[0]
  const [tab, setTab] = useState<'tree' | 'members'>('tree')

  return (
    <div className="flex flex-col gap-4">
      {groups.length > 1 && (
        <select
          value={active.groupId}
          onChange={(e) => onSelect(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        >
          {groups.map((g) => (
            <option key={g.groupId} value={g.groupId}>
              {g.name}
            </option>
          ))}
        </select>
      )}

      <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1 text-sm">
        <TabButton active={tab === 'tree'} onClick={() => setTab('tree')}>
          Tree
        </TabButton>
        <TabButton active={tab === 'members'} onClick={() => setTab('members')}>
          Members
        </TabButton>
      </div>

      {tab === 'tree' ? (
        <TreeView group={active} />
      ) : (
        <MembersPanel key={active.groupId} group={active} />
      )}
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
