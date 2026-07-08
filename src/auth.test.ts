import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCredential,
  setCredential,
  clearCredential,
  decodeEmail,
} from './auth'

describe('auth', () => {
  beforeEach(() => {
    clearCredential()
    localStorage.clear()
  })

  it('stores and clears the credential', () => {
    expect(getCredential()).toBeNull()
    setCredential('abc.def.ghi')
    expect(getCredential()).toBe('abc.def.ghi')
    expect(localStorage.getItem('rootmaze:credential')).toBe('abc.def.ghi')
    clearCredential()
    expect(getCredential()).toBeNull()
    expect(localStorage.getItem('rootmaze:credential')).toBeNull()
  })

  it('decodes the email from a JWT payload for display', () => {
    const payload = btoa(JSON.stringify({ email: 'a@b.com' }))
    expect(decodeEmail(`header.${payload}.sig`)).toBe('a@b.com')
    expect(decodeEmail(null)).toBeNull()
    expect(decodeEmail('not-a-jwt')).toBeNull()
  })
})
