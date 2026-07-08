// Minimal typings for the Google Identity Services client loaded via <script>.
declare namespace google.accounts.id {
  interface CredentialResponse {
    credential: string
  }
  interface InitializeConfig {
    client_id: string
    callback: (response: CredentialResponse) => void
  }
  interface ButtonConfig {
    theme?: 'outline' | 'filled_blue' | 'filled_black'
    size?: 'small' | 'medium' | 'large'
    shape?: 'rectangular' | 'pill' | 'circle' | 'square'
  }
  function initialize(config: InitializeConfig): void
  function renderButton(parent: HTMLElement, options: ButtonConfig): void
  function prompt(): void
}
