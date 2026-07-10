import { useEffect, useState } from 'react'
import AuthButton from '../components/AuthButton'
import {
  previewInvite,
  acceptInvite,
  getMe,
  getGraph,
  linkPersonNode,
  type InvitePreview,
  type PersonNode,
} from '../api'
import { APP_TITLE } from '../appTitle'

// The invitee's landing screen, reached via /?invite=<token>. It shows a
// minimal preview (group name only) to both signed-out and signed-in visitors;
// accepting requires signing in. After joining we offer an optional "which
// person in the tree are you?" step (linking on join), then drop the invite
// param and reload into the app.

// After a successful accept, what we need to offer the optional link step.
type Joined = {
  groupId: string
  groupName: string
  accountId: string
  people: PersonNode[]
}

export default function JoinScreen({
  token,
  signedIn,
}: {
  token: string
  signedIn: boolean
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState('')
  const [joined, setJoined] = useState<Joined | null>(null)

  useEffect(() => {
    let cancelled = false
    previewInvite(token)
      .then((p) => !cancelled && setPreview(p))
      .catch(
        (err: unknown) =>
          !cancelled &&
          setLoadError(err instanceof Error ? err.message : 'Failed to load invite'),
      )
    return () => {
      cancelled = true
    }
  }, [token])

  function goToApp() {
    window.location.href = window.location.origin + '/'
  }

  async function handleAccept() {
    setAccepting(true)
    setAcceptError('')
    try {
      const result = await acceptInvite(token)
      // Offer to link on join. If we can't figure out the people (or there are
      // no unclaimed ones), just fall through to the app.
      const details = await Promise.all([getMe(), getGraph(result.groupId)]).catch(() => null)
      if (!details) {
        goToApp()
        return
      }
      const [me, graph] = details
      const unclaimed = graph.nodes.filter((n) => !n.accountId)
      if (unclaimed.length === 0) {
        goToApp()
        return
      }
      setJoined({
        groupId: result.groupId,
        groupName: result.name,
        accountId: me.accountId,
        people: unclaimed,
      })
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not join')
      setAccepting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 px-5 py-10">
      <h1 className="text-xl font-semibold tracking-tight">{APP_TITLE}</h1>

      {loadError && <p className="text-red-400">Error: {loadError}</p>}

      {/* Post-join: optional "this is me" step. */}
      {joined && (
        <ClaimSelf
          joined={joined}
          onDone={goToApp}
        />
      )}

      {!joined && preview && !preview.valid && (
        <section className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-zinc-300">This invite link is no longer valid.</p>
          <p className="text-sm text-zinc-500">
            It may have expired or been revoked. Ask whoever shared it for a new link.
          </p>
          <a href="/" className="text-sm text-zinc-400 underline hover:text-zinc-200">
            Go to Root Maze
          </a>
        </section>
      )}

      {!joined && preview && preview.valid && (
        <section className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-zinc-200">
            You've been invited to join{' '}
            <span className="font-semibold text-zinc-100">{preview.groupName}</span>.
          </p>

          {!signedIn && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-zinc-500">Sign in to join.</p>
              <AuthButton />
            </div>
          )}

          {signedIn && (
            <button
              onClick={handleAccept}
              disabled={accepting}
              className="rounded-md bg-zinc-100 px-3 py-2 font-medium text-zinc-900 disabled:opacity-40"
            >
              {accepting ? 'Joining…' : `Join ${preview.groupName}`}
            </button>
          )}

          {acceptError && <p className="text-sm text-red-400">{acceptError}</p>}
        </section>
      )}

      {!joined && !preview && !loadError && (
        <p className="text-zinc-400">Loading invite…</p>
      )}
    </main>
  )
}

// Optional link-on-join: after accepting, let the new member say which person in
// the tree they are. Entirely skippable — they can always do it later from the
// tree or members screen.
function ClaimSelf({
  joined,
  onDone,
}: {
  joined: Joined
  onDone: () => void
}) {
  const [nodeId, setNodeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function claim() {
    if (!nodeId) return
    setBusy(true)
    setError('')
    try {
      await linkPersonNode(joined.groupId, joined.accountId, nodeId)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link')
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <p className="text-zinc-200">
          You've joined{' '}
          <span className="font-semibold text-zinc-100">{joined.groupName}</span>.
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Which person in the tree are you? (Optional — you can set this later.)
        </p>
      </div>

      <select
        aria-label="Which person are you?"
        value={nodeId}
        onChange={(e) => setNodeId(e.target.value)}
        className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
      >
        <option value="">Select yourself…</option>
        {joined.people.map((p) => (
          <option key={p.nodeId} value={p.nodeId}>
            {p.name}
          </option>
        ))}
      </select>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={claim}
          disabled={busy || !nodeId}
          className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40"
        >
          {busy && (
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-900/60 border-t-transparent"
            />
          )}
          {busy ? 'Linking…' : "That's me"}
        </button>
        <button
          onClick={onDone}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Skip
        </button>
      </div>
    </section>
  )
}
