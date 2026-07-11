import { describe, expect, it } from 'vitest'
import {
  parseGedcom,
  gedcomToImport,
  gedcomTreeName,
  buildNotes,
  parseNotesMeta,
  graphToGedcom,
} from '../lib/gedcom.js'

const SAMPLE = `0 HEAD
1 SOUR ANCESTRY
2 NAME The Lovelaces
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ada Byron /King/
1 SEX F
1 BIRT
2 DATE 10 DEC 1815
2 PLAC London, England
1 DEAT
2 DATE 27 NOV 1852
1 NOTE Mathematician and writer.
0 @I2@ INDI
1 NAME William /King/
1 SEX M
0 @I3@ INDI
1 NAME Byron /King/
1 SEX M
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
1 CHIL @I3@
1 MARR
2 DATE 8 JUL 1835
0 TRLR
`

describe('parseGedcom', () => {
  it('builds a record forest and folds CONT/CONC continuations', () => {
    const records = parseGedcom(
      '0 @I1@ INDI\n1 NOTE first line\n2 CONT second line\n2 CONC  joined',
    )
    expect(records).toHaveLength(1)
    expect(records[0].tag).toBe('INDI')
    expect(records[0].xref).toBe('@I1@')
    const note = records[0].children.find((c) => c.tag === 'NOTE')
    expect(note.value).toBe('first line')
  })

  it('tolerates junk and blank lines instead of throwing', () => {
    const records = parseGedcom('\n\nnot a gedcom line\n0 @I1@ INDI\n')
    expect(records).toHaveLength(1)
  })
})

describe('gedcomToImport', () => {
  const { people, edges } = gedcomToImport(parseGedcom(SAMPLE))

  it('maps names into first/middle/last', () => {
    const ada = people.find((p) => p.xref === '@I1@')
    expect(ada.firstName).toBe('Ada')
    expect(ada.middleName).toBe('Byron')
    expect(ada.lastName).toBe('King')
  })

  it('keeps GEDCOM dates verbatim (free-form strings)', () => {
    const ada = people.find((p) => p.xref === '@I1@')
    expect(ada.birthdate).toBe('10 DEC 1815')
    expect(ada.deathdate).toBe('27 NOV 1852')
  })

  it('folds sex, places, and the note into the notes blob', () => {
    const ada = people.find((p) => p.xref === '@I1@')
    expect(ada.notes).toContain('Mathematician and writer.')
    expect(ada.notes).toContain('Sex: Female')
    expect(ada.notes).toContain('Birthplace: London, England')
  })

  it('derives a partner edge and parent_child edges from a FAM', () => {
    const partner = edges.find((e) => e.kind === 'partner')
    expect(partner).toMatchObject({ from: '@I2@', to: '@I1@', subtype: 'married' })
    expect(partner.startDate).toBe('8 JUL 1835')

    const parentChild = edges.filter((e) => e.kind === 'parent_child')
    expect(parentChild).toHaveLength(2) // both parents -> the child
    expect(parentChild.every((e) => e.to === '@I3@')).toBe(true)
  })

  it('drops duplicate and self relationships (one per pair)', () => {
    const dup = gedcomToImport(
      parseGedcom(
        '0 @I1@ INDI\n1 NAME A /X/\n0 @I2@ INDI\n1 NAME B /X/\n' +
          '0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n' +
          '0 @F2@ FAM\n1 HUSB @I2@\n1 WIFE @I1@\n',
      ),
    )
    expect(dup.edges).toHaveLength(1)
  })

  it('falls back to Unknown when a given name is missing', () => {
    const { people: p } = gedcomToImport(parseGedcom('0 @I1@ INDI\n1 NAME /Smith/'))
    expect(p[0].firstName).toBe('Unknown')
    expect(p[0].lastName).toBe('Smith')
  })
})

describe('gedcomTreeName', () => {
  it('reads the tree name from HEAD.SOUR.NAME', () => {
    expect(gedcomTreeName(parseGedcom(SAMPLE))).toBe('The Lovelaces')
  })
})

describe('notes convention round-trips', () => {
  it('buildNotes and parseNotesMeta are inverses', () => {
    const notes = buildNotes({
      note: 'A free note',
      sex: 'F',
      birthPlace: 'Boston, MA',
      deathPlace: 'Paris',
    })
    const meta = parseNotesMeta(notes)
    expect(meta).toEqual({
      note: 'A free note',
      sex: 'F',
      birthPlace: 'Boston, MA',
      deathPlace: 'Paris',
    })
  })

  it('returns null notes when there is nothing to store', () => {
    expect(buildNotes({})).toBeNull()
  })
})

describe('graphToGedcom', () => {
  it('serializes people and reconstructs a family from pairwise edges', () => {
    const graph = {
      nodes: [
        {
          nodeId: 'nod_h',
          firstName: 'William',
          middleName: null,
          lastName: 'King',
          birthdate: null,
          deathdate: null,
          notes: 'Sex: Male',
        },
        {
          nodeId: 'nod_w',
          firstName: 'Ada',
          middleName: 'Byron',
          lastName: 'King',
          birthdate: '10 DEC 1815',
          deathdate: null,
          notes: 'Sex: Female\nBirthplace: London',
        },
        {
          nodeId: 'nod_c',
          firstName: 'Byron',
          middleName: null,
          lastName: 'King',
          birthdate: null,
          deathdate: null,
          notes: null,
        },
      ],
      edges: [
        { edgeKind: 'partner', fromPerson: 'nod_h', toPerson: 'nod_w', subtype: 'married', startDate: '1835', endDate: null },
        { edgeKind: 'parent_child', fromPerson: 'nod_h', toPerson: 'nod_c', subtype: 'biological' },
        { edgeKind: 'parent_child', fromPerson: 'nod_w', toPerson: 'nod_c', subtype: 'biological' },
      ],
    }
    const out = graphToGedcom(graph)
    expect(out).toContain('1 NAME Ada Byron /King/')
    expect(out).toContain('1 SEX F')
    expect(out).toContain('2 PLAC London')
    // Sex drives HUSB/WIFE assignment: William (M) is HUSB, Ada (F) is WIFE.
    expect(out).toMatch(/0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@/)
    expect(out.trim().endsWith('0 TRLR')).toBe(true)
  })

  it('round-trips import -> export -> import with stable counts', () => {
    const first = gedcomToImport(parseGedcom(SAMPLE))
    // Fake a committed group by giving each imported person a node id.
    const nodes = first.people.map((p, i) => ({ ...p, nodeId: `nod_${i}` }))
    const idByXref = new Map(first.people.map((p, i) => [p.xref, `nod_${i}`]))
    const edges = first.edges.map((e) => ({
      edgeKind: e.kind,
      fromPerson: idByXref.get(e.from),
      toPerson: idByXref.get(e.to),
      subtype: e.subtype,
      startDate: e.startDate,
      endDate: e.endDate,
    }))

    const exported = graphToGedcom({ nodes, edges })
    const second = gedcomToImport(parseGedcom(exported))

    expect(second.people).toHaveLength(first.people.length)
    expect(second.edges).toHaveLength(first.edges.length)
    // Sex and places survive the trip via the notes convention.
    const ada = second.people.find((p) => p.firstName === 'Ada')
    expect(ada.notes).toContain('Sex: Female')
    expect(ada.notes).toContain('Birthplace: London, England')
  })
})
