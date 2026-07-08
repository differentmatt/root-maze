import { useEffect, useState } from 'react'
import AuthButton from './components/AuthButton'
import {
  getCredential,
  onCredentialChange,
  clearCredential,
  decodeEmail,
} from './auth'
import { getMe, createGroup, ApiError, type Me } from './api'

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

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 px-5 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Root Maze</h1>
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
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-zinc-400">You're in group:</p>
              <p className="mt-1 text-lg font-medium">
                {load.me.groups[0].name}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                role: {load.me.groups[0].role}
              </p>
            </div>
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
