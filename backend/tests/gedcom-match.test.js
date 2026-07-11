import { describe, expect, it } from 'vitest'
import {
  scorePair,
  firstNameRelation,
  levenshtein,
  tierOf,
  TIERS,
} from '../lib/gedcom-match.js'

const p = (firstName, lastName, extra = {}) => ({
  firstName,
  middleName: null,
  lastName,
  birthdate: null,
  deathdate: null,
  ...extra,
})

describe('levenshtein', () => {
  it('measures small edit distances and caps large ones', () => {
    expect(levenshtein('lott', 'lott')).toBe(0)
    expect(levenshtein('lott', 'lott')).toBe(0)
    expect(levenshtein('smith', 'smyth', 1)).toBe(1)
    expect(levenshtein('smith', 'jones', 1)).toBe(2) // exceeds max -> max+1
  })
})

describe('firstNameRelation', () => {
  it('recognizes exact, nickname, typo, and initial links', () => {
    expect(firstNameRelation('Matt', 'Matt')).toBe('exact')
    expect(firstNameRelation('Matt', 'Matthew')).toBe('nickname')
    expect(firstNameRelation('Bob', 'Robert')).toBe('nickname')
    expect(firstNameRelation('Jon', 'John')).toBe('nickname')
    expect(firstNameRelation('Alan', 'Alen')).toBe('typo') // near-match, not in table
    expect(firstNameRelation('Michael', 'Margaret')).toBe('initial')
    expect(firstNameRelation('Ada', 'Zelda')).toBeNull()
  })
})

describe('scorePair', () => {
  it('scores the real report case (Matt Lott vs Matt McCabe Lott) as strong', () => {
    const imported = p('Matt', 'Lott', { birthdate: '1979' })
    const existing = p('Matt', 'Lott', { middleName: 'McCabe', birthdate: '1979-05-01' })
    const { score, firstSignal } = scorePair(imported, existing)
    expect(firstSignal).toBe('exact')
    expect(tierOf(score)).toBe('strong')
  })

  it('matches a fuller name to a nickname (Matthew James Lott vs Matt Lott)', () => {
    const imported = p('Matthew', 'Lott', { middleName: 'James', birthdate: '1979' })
    const existing = p('Matt', 'Lott', { birthdate: '1979' })
    const { score, reasons } = scorePair(imported, existing)
    expect(tierOf(score)).toBe('strong')
    expect(reasons.join(' ')).toMatch(/nickname/)
  })

  it('penalizes a conflicting birth year even with the same name', () => {
    const a = p('Ada', 'King', { birthdate: '1815' })
    const b = p('Ada', 'King', { birthdate: '1900' })
    const { score } = scorePair(a, b)
    // same first + last (8) minus the year conflict (5) = 3 -> below POSSIBLE.
    expect(score).toBeLessThan(TIERS.POSSIBLE)
    expect(tierOf(score)).toBeNull()
  })

  it('gives no first-name signal on surname alone (the orchestrator gates on it)', () => {
    // Surname alone scores POSSIBLE, but firstSignal===null is what stops
    // every same-surname relative from being surfaced as a candidate.
    const { firstSignal } = scorePair(p('Robert', 'Lott'), p('Ari', 'Lott'))
    expect(firstSignal).toBeNull()
  })

  it('rewards an exact birth date more than a year-only agreement', () => {
    const exact = scorePair(
      p('Jane', 'Doe', { birthdate: '1 JAN 1950' }),
      p('Jane', 'Doe', { birthdate: '1 JAN 1950' }),
    ).score
    const yearOnly = scorePair(
      p('Jane', 'Doe', { birthdate: '1950' }),
      p('Jane', 'Doe', { birthdate: '3 MAR 1950' }),
    ).score
    expect(exact).toBeGreaterThan(yearOnly)
  })
})
