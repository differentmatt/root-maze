import { useEffect, useState } from 'react'
import AuthButton from '../components/AuthButton'
import { previewInvite, acceptInvite, type InvitePreview } from '../api'
import { APP_TITLE } from '../appTitle'

// The invitee's landing screen, reached via /?invite=<token>. It shows a
// minimal preview (group name only) to both signed-out and signed-in visitors;
// accepting requires signing in. On success we drop the invite param and reload
// into the app, where the newly-joined group appears.
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

  async function handleAccept() {
    setAccepting(true)
    setAcceptError('')
    try {
      await acceptInvite(token)
      // Fresh load without the invite param — the app re-fetches /me and the
      // new group shows up.
      window.location.href = window.location.origin + '/'
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not join')
      setAccepting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 px-5 py-10">
      <h1 className="text-xl font-semibold tracking-tight">{APP_TITLE}</h1>

      {loadError && <p className="text-red-400">Error: {loadError}</p>}

      {preview && !preview.valid && (
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

      {preview && preview.valid && (
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

      {!preview && !loadError && <p className="text-zinc-400">Loading invite…</p>}
    </main>
  )
}
