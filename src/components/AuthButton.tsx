import { useEffect, useRef } from 'react'
import { setCredential } from '../auth'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

// Renders the Google Sign-In button and stores the returned ID token.
export default function AuthButton() {
  const btnRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!CLIENT_ID || !btnRef.current || typeof google === 'undefined') return

    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response: { credential: string }) => {
        setCredential(response.credential)
      },
    })
    google.accounts.id.renderButton(btnRef.current, {
      theme: 'filled_black',
      size: 'large',
      shape: 'pill',
    })
  }, [])

  if (!CLIENT_ID) {
    return (
      <p className="text-sm text-amber-400">
        VITE_GOOGLE_CLIENT_ID is not set — sign-in is unavailable.
      </p>
    )
  }

  return <div ref={btnRef} />
}
