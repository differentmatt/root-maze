/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
  // Deploy environment ('staging' | 'prod'), injected at build time by the
  // deploy workflow. Undefined in local dev.
  readonly VITE_APP_ENV?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
