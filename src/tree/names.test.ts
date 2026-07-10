import { describe, expect, it } from 'vitest'
import type { PersonNode } from '../api'
import { fullName, shortName, bornSuffix, namePartsOf, labelFor } from './names'

function node(over: Partial<PersonNode>): PersonNode {
  return {
    nodeId: 'nod',
    groupId: 'grp',
    name: '',
    firstName: null,
    lastName: null,
    middleName: null,
    birthName: null,
    birthdate: null,
    deathdate: null,
    notes: null,
    accountId: null,
    createdAt: 't',
    updatedAt: 't',
    updatedBy: 'acc',
    ...over,
  }
}

describe('fullName', () => {
  it('joins the structured parts', () => {
    expect(fullName({ firstName: 'Ada', middleName: 'Byron', lastName: 'King' })).toBe(
      'Ada Byron King',
    )
  })
  it('falls back to a legacy single name', () => {
    expect(fullName({ name: 'Ada Lovelace' })).toBe('Ada Lovelace')
  })
})

describe('shortName', () => {
  it('is "First L." when a last name is known', () => {
    expect(shortName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada L.')
  })
  it('is just the first name without a last name', () => {
    expect(shortName({ firstName: 'Ada' })).toBe('Ada')
  })
  it('takes the surname initial by Unicode code point', () => {
    expect(shortName({ firstName: 'Aki', lastName: '𠮷田' })).toBe('Aki 𠮷.')
  })
  it('derives the first token from a legacy name', () => {
    expect(shortName({ name: 'Ada Lovelace' })).toBe('Ada')
  })
})

describe('bornSuffix', () => {
  it('shows a distinct birth name', () => {
    expect(bornSuffix({ lastName: 'King', birthName: 'Byron' })).toBe('born Byron')
  })
  it('is empty when the birth name matches the last name', () => {
    expect(bornSuffix({ lastName: 'Byron', birthName: 'Byron' })).toBe('')
  })
  it('is empty when there is no birth name', () => {
    expect(bornSuffix({ lastName: 'King' })).toBe('')
  })
})

describe('namePartsOf', () => {
  it('splits a legacy name into first + last', () => {
    expect(namePartsOf({ name: 'Ada Byron King' })).toEqual({
      firstName: 'Ada',
      lastName: 'Byron King',
      middleName: '',
      birthName: '',
    })
  })
  it('prefers existing structured parts over the legacy name', () => {
    expect(
      namePartsOf({ name: 'ignored', firstName: 'Ada', lastName: 'King' }),
    ).toEqual({ firstName: 'Ada', lastName: 'King', middleName: '', birthName: '' })
  })
})

describe('labelFor', () => {
  it('uses the compact form when unambiguous', () => {
    const ada = node({ nodeId: 'a', firstName: 'Ada', lastName: 'Lovelace' })
    const bo = node({ nodeId: 'b', firstName: 'Bo', lastName: 'Peep' })
    expect(labelFor(ada, [ada, bo])).toBe('Ada L.')
  })
  it('widens to the full name when two people share a compact form', () => {
    const j1 = node({ nodeId: '1', firstName: 'John', lastName: 'Smith' })
    const j2 = node({ nodeId: '2', firstName: 'John', lastName: 'Snow' })
    expect(labelFor(j1, [j1, j2])).toBe('John Smith')
  })
})
