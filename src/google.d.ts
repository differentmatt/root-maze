// Minimal typings for the Google Identity Services client loaded via <script>.
declare namespace google.accounts.id {
  interface CredentialResponse {
    credential: string
  }
  interface InitializeConfig {
    client_id: string
    callback: (response: CredentialResponse) => void
    // When true, One Tap automatically re-issues a token for a returning user
    // (one who previously signed in) without a click, so a page refresh doesn't
    // force them to sign in again.
    auto_select?: boolean
  }
  interface ButtonConfig {
    theme?: 'outline' | 'filled_blue' | 'filled_black'
    size?: 'small' | 'medium' | 'large'
    shape?: 'rectangular' | 'pill' | 'circle' | 'square'
  }
  function initialize(config: InitializeConfig): void
  function renderButton(parent: HTMLElement, options: ButtonConfig): void
  function prompt(): void
  // Prevents One Tap from automatically re-issuing a token on the next page
  // load; call this before clearing the credential on an explicit sign-out so
  // the user is not immediately signed back in.
  function disableAutoSelect(): void
}
