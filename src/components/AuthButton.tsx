import { useEffect, useRef, useState } from 'react'
import { setCredential } from '../auth'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

// Renders the Google Sign-In button and stores the returned ID token. The GIS
// client (index.html) loads async, so on a cold load `google` is often still
// undefined when we mount — poll until it's ready rather than giving up after
// one try (which left the button missing until a manual reload).
//
// A Google ID token is only valid for ~1 hour and there's no refresh token, so
// after it expires (or is cleared) the app drops back to signed-out. To spare a
// returning user from having to click the button again on every refresh, we
// enable One Tap `auto_select` and fire `prompt()`: if they've signed in before
// and still have a Google session, One Tap silently re-issues a token and calls
// our callback, so they land straight back in the app.
export default function AuthButton() {
  const btnRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!CLIENT_ID) return
    let cancelled = false

    function tryRender(): boolean {
      if (cancelled || !btnRef.current) return false
      if (typeof google === 'undefined' || !google.accounts?.id) return false

      google.accounts.id.initialize({
        client_id: CLIENT_ID as string,
        callback: (response) => setCredential(response.credential),
        auto_select: true,
      })
      google.accounts.id.renderButton(btnRef.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
      })
      // Attempt a silent, automatic re-sign-in for a returning user. Harmless if
      // they've never signed in (One Tap simply doesn't appear).
      google.accounts.id.prompt()
      setReady(true)
      return true
    }

    if (tryRender()) return
    const timer = setInterval(() => {
      if (tryRender()) clearInterval(timer)
    }, 150)
    const giveUp = setTimeout(() => clearInterval(timer), 8000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearTimeout(giveUp)
    }
  }, [])

  if (!CLIENT_ID) {
    return (
      <p className="text-sm text-amber-400">
        VITE_GOOGLE_CLIENT_ID is not set — sign-in is unavailable.
      </p>
    )
  }

  return (
    <div>
      <div ref={btnRef} />
      {!ready && <p className="text-sm text-zinc-500">Loading sign-in…</p>}
    </div>
  )
}
