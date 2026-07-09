// The app's top-level title. Staging gets a "(staging)" suffix so it's obvious
// at a glance which environment you're looking at; prod (and local dev) show the
// plain name. VITE_APP_ENV is injected at build time by the deploy workflow.
export const APP_TITLE =
  import.meta.env.VITE_APP_ENV === 'staging' ? 'Root Maze (staging)' : 'Root Maze'
