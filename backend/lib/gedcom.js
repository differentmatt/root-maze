// GEDCOM 5.5.1 parsing, mapping, and serialization — all pure, no DynamoDB.
//
// GEDCOM is the lingua franca every genealogy tool exports (Ancestry,
// FamilySearch, MyHeritage, Gramps). A file is a flat list of lines, each
//
//     <level> [@xref@] <TAG> [value]
//
// nested by the leading level number. Two record types carry everything we
// care about:
//   INDI — an individual (NAME, SEX, BIRT/DEAT with DATE + PLAC, NOTE)
//   FAM  — a family unit (HUSB, WIFE, CHIL*, MARR, DIV) — this is where GEDCOM
//          keeps relationships, as pointers between individuals.
//
// Our data model is narrower than GEDCOM: a person has structured names, a
// free-form birth/death date, and a notes blob; there is no field for sex or
// for places. So on import we fold SEX and birth/death PLAC into `notes` using
// a small "Label: value" convention (see buildNotes / parseNotesMeta), which
// export reads back to reconstruct the structured tags. It's a deliberately
// lossy-but-legible round trip — the tradeoff of not widening the schema.

// --- Parsing -------------------------------------------------------------

// One GEDCOM line. The optional xref only appears on record heads (`0 @I1@
// INDI`); pointer *values* like `1 HUSB @I1@` keep the @..@ in `value`.
const LINE = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$/

/**
 * Parse GEDCOM text into a forest of level-0 records. Each node is
 * `{ tag, xref, value, children }`. CONT/CONC continuation lines are kept as
 * children and folded back together by fullText() when a value is read, so a
 * multi-line NOTE survives intact.
 * @param {string} text
 * @returns {Array<{tag:string, xref:string|null, value:string, children:Array}>}
 */
export function parseGedcom(text) {
  const records = []
  // stack[i] is the most recent node seen at level i; a new line at level L
  // attaches to stack[L-1].
  const stack = []

  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    if (!raw.trim()) continue
    const m = LINE.exec(raw)
    if (!m) continue // tolerate junk lines rather than failing the whole import
    const level = Number(m[1])
    const node = {
      tag: m[3].toUpperCase(),
      xref: m[2] ?? null,
      value: m[4] ?? '',
      children: [],
    }
    if (level === 0) {
      records.push(node)
      stack.length = 0
      stack[0] = node
    } else {
      const parent = stack[level - 1]
      if (!parent) continue // orphaned line (bad levels); skip defensively
      parent.children.push(node)
      stack.length = level
      stack[level] = node
    }
  }
  return records
}

const child = (node, tag) => node?.children.find((c) => c.tag === tag)
const children = (node, tag) => node?.children.filter((c) => c.tag === tag) ?? []

// A node's full text value, folding GEDCOM CONT (line break) and CONC
// (concatenate, no break) continuation children back into one string.
function fullText(node) {
  if (!node) return ''
  let out = node.value
  for (const c of node.children) {
    if (c.tag === 'CONT') out += '\n' + c.value
    else if (c.tag === 'CONC') out += c.value
  }
  return out
}

// --- Mapping GEDCOM -> our model ----------------------------------------

// GEDCOM NAME is "Given /Surname/ Suffix". Sub-tags GIVN/SURN, when present,
// are authoritative and override the slash form.
function parseName(nameNode) {
  let given = ''
  let surname = ''
  if (nameNode) {
    const raw = fullText(nameNode)
    const slash = raw.match(/^([^/]*)\/([^/]*)\/(.*)$/)
    if (slash) {
      given = slash[1].trim()
      surname = slash[2].trim()
    } else {
      given = raw.trim()
    }
    const givn = child(nameNode, 'GIVN')
    const surn = child(nameNode, 'SURN')
    if (givn && givn.value.trim()) given = givn.value.trim()
    if (surn && surn.value.trim()) surname = surn.value.trim()
  }
  // firstName is required by the model, so a name that is surname-only (or
  // empty) still has to yield something — "Unknown" flags the gap plainly.
  const tokens = given.split(/\s+/).filter(Boolean)
  const firstName = tokens[0] || 'Unknown'
  const middleName = tokens.slice(1).join(' ') || null
  const lastName = surname || null
  return { firstName, middleName, lastName }
}

const SEX_LABELS = { M: 'Male', F: 'Female' }

// Compose the notes blob from the free-form NOTE plus the GEDCOM fields that
// have no column of their own. The free note leads; the structured lines
// follow in a fixed order so parseNotesMeta (used by export) can find them.
export function buildNotes({ note, sex, birthPlace, deathPlace }) {
  const lines = []
  if (note && note.trim()) lines.push(note.trim())
  if (sex) lines.push(`Sex: ${SEX_LABELS[sex] || sex}`)
  if (birthPlace && birthPlace.trim()) lines.push(`Birthplace: ${birthPlace.trim()}`)
  if (deathPlace && deathPlace.trim()) lines.push(`Deathplace: ${deathPlace.trim()}`)
  return lines.length ? lines.join('\n') : null
}

// The inverse of buildNotes: pull the structured lines back out of a notes
// blob so export can rebuild SEX / BIRT.PLAC / DEAT.PLAC tags. Anything that
// isn't one of our labelled lines is returned as `note` (the free text).
export function parseNotesMeta(notes) {
  const meta = { sex: null, birthPlace: null, deathPlace: null, note: null }
  if (!notes) return meta
  const kept = []
  for (const line of String(notes).split('\n')) {
    const m = line.match(/^(Sex|Birthplace|Deathplace):\s*(.*)$/)
    if (!m) {
      kept.push(line)
      continue
    }
    const value = m[2].trim()
    if (m[1] === 'Sex') {
      meta.sex = value === 'Male' ? 'M' : value === 'Female' ? 'F' : value
    } else if (m[1] === 'Birthplace') meta.birthPlace = value
    else meta.deathPlace = value
  }
  const note = kept.join('\n').trim()
  meta.note = note || null
  return meta
}

// A BIRT/DEAT event's date + place (both optional, both free-form strings).
function eventDetail(indi, tag) {
  const ev = child(indi, tag)
  if (!ev) return { date: null, place: null }
  return {
    date: fullText(child(ev, 'DATE')).trim() || null,
    place: fullText(child(ev, 'PLAC')).trim() || null,
  }
}

/**
 * Turn parsed GEDCOM records into the shape the importer applies: a list of
 * people (keyed by their GEDCOM xref) and a deduped list of relationship
 * descriptors that reference those xrefs. Nothing here touches the database —
 * the importer resolves xrefs to real node ids at commit time.
 * @param {ReturnType<typeof parseGedcom>} records
 */
export function gedcomToImport(records) {
  const people = []
  const seenXref = new Set()

  for (const rec of records) {
    if (rec.tag !== 'INDI' || !rec.xref) continue
    if (seenXref.has(rec.xref)) continue
    seenXref.add(rec.xref)

    const { firstName, middleName, lastName } = parseName(child(rec, 'NAME'))
    const birth = eventDetail(rec, 'BIRT')
    const death = eventDetail(rec, 'DEAT')
    const note = children(rec, 'NOTE').map(fullText).join('\n\n').trim() || null

    people.push({
      xref: rec.xref,
      firstName,
      middleName,
      lastName,
      birthdate: birth.date,
      deathdate: death.date,
      notes: buildNotes({
        note,
        sex: (child(rec, 'SEX')?.value || '').trim().toUpperCase()[0] || null,
        birthPlace: birth.place,
        deathPlace: death.place,
      }),
    })
  }

  const validXref = seenXref
  const edges = []
  // One relationship per unordered pair (mirrors the edge handler's rule); the
  // first descriptor for a pair wins, later duplicates are dropped.
  const pairSeen = new Set()
  const pairKey = (a, b) => [a, b].sort().join('|')
  const addEdge = (e) => {
    if (e.from === e.to) return
    if (!validXref.has(e.from) || !validXref.has(e.to)) return
    const key = pairKey(e.from, e.to)
    if (pairSeen.has(key)) return
    pairSeen.add(key)
    edges.push(e)
  }

  for (const rec of records) {
    if (rec.tag !== 'FAM') continue
    const husb = child(rec, 'HUSB')?.value || null
    const wife = child(rec, 'WIFE')?.value || null
    const parents = [husb, wife].filter(Boolean)
    const marr = child(rec, 'MARR')
    const div = child(rec, 'DIV')

    if (husb && wife) {
      addEdge({
        kind: 'partner',
        from: husb,
        to: wife,
        subtype: div ? 'ex' : marr ? 'married' : 'partner',
        startDate: fullText(child(marr, 'DATE')).trim() || null,
        endDate: fullText(child(div, 'DATE')).trim() || null,
      })
    }

    for (const chil of children(rec, 'CHIL')) {
      const kid = chil.value
      for (const parent of parents) {
        addEdge({
          kind: 'parent_child',
          from: parent,
          to: kid,
          subtype: 'biological',
          startDate: null,
          endDate: null,
        })
      }
    }
  }

  return { people, edges }
}

// The submitter/tree name a file advertises in its HEAD, used to pre-fill the
// group name when importing into a brand-new group. Best-effort only.
export function gedcomTreeName(records) {
  const head = records.find((r) => r.tag === 'HEAD')
  if (!head) return null
  // Some tools put a tree name under HEAD.SOUR.NAME or HEAD._TREE.
  const sourName = fullText(child(child(head, 'SOUR'), 'NAME')).trim()
  if (sourName) return sourName
  return null
}

// --- Serialization: our model -> GEDCOM 5.5.1 ---------------------------

function line(level, tag, value) {
  return value ? `${level} ${tag} ${value}` : `${level} ${tag}`
}

// Emit a possibly multi-line value as TAG + CONT children, so newlines in a
// notes blob stay valid GEDCOM instead of producing malformed extra lines.
function textLines(level, tag, value) {
  const parts = String(value).split('\n')
  const out = [line(level, tag, parts[0])]
  for (const p of parts.slice(1)) out.push(line(level + 1, 'CONT', p))
  return out
}

function givenName(node) {
  return [node.firstName, node.middleName].filter(Boolean).join(' ')
}

/**
 * Assemble FAM records from our pairwise edges. GEDCOM groups relationships
 * into family units (a couple and their children); our edges are flat, so we
 * regroup: every partner edge is a family, and each child is attached to the
 * family of its parent set (falling back to a parents-only family when the
 * parents aren't a recorded couple). Returns families keyed by a stable id.
 */
function buildFamilies(edges) {
  const families = new Map() // key -> { parents:Set, children:Set, subtype, startDate, endDate }
  const coupleKey = (a, b) => 'C:' + [a, b].sort().join('|')

  const ensure = (key) => {
    if (!families.has(key)) {
      families.set(key, {
        parents: new Set(),
        children: new Set(),
        subtype: null,
        startDate: null,
        endDate: null,
      })
    }
    return families.get(key)
  }

  // Couples first, so a child with two partnered parents lands in their family.
  const partnerOf = new Map() // person -> Set(partners)
  for (const e of edges) {
    if (e.edgeKind !== 'partner') continue
    const key = coupleKey(e.fromPerson, e.toPerson)
    const fam = ensure(key)
    fam.parents.add(e.fromPerson).add(e.toPerson)
    fam.subtype = e.subtype
    fam.startDate = e.startDate
    fam.endDate = e.endDate
    if (!partnerOf.has(e.fromPerson)) partnerOf.set(e.fromPerson, new Set())
    if (!partnerOf.has(e.toPerson)) partnerOf.set(e.toPerson, new Set())
    partnerOf.get(e.fromPerson).add(e.toPerson)
    partnerOf.get(e.toPerson).add(e.fromPerson)
  }

  // Group each child by its full set of parents.
  const childParents = new Map()
  for (const e of edges) {
    if (e.edgeKind !== 'parent_child') continue
    if (!childParents.has(e.toPerson)) childParents.set(e.toPerson, new Set())
    childParents.get(e.toPerson).add(e.fromPerson)
  }

  for (const [kid, parents] of childParents) {
    const list = [...parents]
    // Two parents who are a recorded couple -> their existing family.
    let key
    if (list.length === 2 && partnerOf.get(list[0])?.has(list[1])) {
      key = coupleKey(list[0], list[1])
    } else {
      key = 'P:' + list.sort().join('|')
    }
    const fam = ensure(key)
    for (const p of list) fam.parents.add(p)
    fam.children.add(kid)
  }

  return [...families.values()].filter(
    (f) => f.parents.size || f.children.size,
  )
}

/**
 * Serialize a group's graph ({ nodes, edges }) into a GEDCOM 5.5.1 document.
 * Notes are parsed back into SEX / BIRT.PLAC / DEAT.PLAC where they follow the
 * import convention; leftover note text stays as a NOTE. HUSB/WIFE roles are
 * assigned from a person's recovered sex when known, else arbitrarily (the
 * model doesn't track gender), which GEDCOM readers tolerate.
 * @param {{nodes:Array, edges:Array}} graph
 * @param {{treeName?:string}} [opts]
 */
export function graphToGedcom(graph, opts = {}) {
  const { nodes, edges } = graph
  const idFor = new Map() // nodeId -> @I{n}@
  nodes.forEach((n, i) => idFor.set(n.nodeId, `@I${i + 1}@`))

  const meta = new Map() // nodeId -> parsed notes meta (incl. recovered sex)
  const lines = []

  lines.push('0 HEAD')
  lines.push('1 SOUR ROOT_MAZE')
  if (opts.treeName) lines.push(...textLines(2, 'NAME', opts.treeName))
  lines.push('1 GEDC')
  lines.push('2 VERS 5.5.1')
  lines.push('2 FORM LINEAGE-LINKED')
  lines.push('1 CHAR UTF-8')

  for (const n of nodes) {
    const m = parseNotesMeta(n.notes)
    meta.set(n.nodeId, m)
    const xref = idFor.get(n.nodeId)
    lines.push(`0 ${xref} INDI`)
    const given = givenName(n)
    const surname = n.lastName || ''
    lines.push(line(1, 'NAME', `${given} /${surname}/`.trim()))
    if (m.sex) lines.push(line(1, 'SEX', m.sex))
    if (n.birthdate || m.birthPlace) {
      lines.push('1 BIRT')
      if (n.birthdate) lines.push(line(2, 'DATE', n.birthdate))
      if (m.birthPlace) lines.push(...textLines(2, 'PLAC', m.birthPlace))
    }
    if (n.deathdate || m.deathPlace) {
      lines.push('1 DEAT')
      if (n.deathdate) lines.push(line(2, 'DATE', n.deathdate))
      if (m.deathPlace) lines.push(...textLines(2, 'PLAC', m.deathPlace))
    }
    if (m.note) lines.push(...textLines(1, 'NOTE', m.note))
  }

  const families = buildFamilies(edges)
  families.forEach((fam, i) => {
    const parents = [...fam.parents].filter((p) => idFor.has(p))
    const kids = [...fam.children].filter((c) => idFor.has(c))
    if (!parents.length && !kids.length) return
    lines.push(`0 @F${i + 1}@ FAM`)

    // Split parents into HUSB/WIFE by recovered sex, then fill remaining slots.
    let husb = parents.find((p) => meta.get(p)?.sex === 'M')
    let wife = parents.find((p) => meta.get(p)?.sex === 'F')
    for (const p of parents) {
      if (p === husb || p === wife) continue
      if (!husb) husb = p
      else if (!wife) wife = p
    }
    if (husb) lines.push(line(1, 'HUSB', idFor.get(husb)))
    if (wife) lines.push(line(1, 'WIFE', idFor.get(wife)))
    for (const c of kids) lines.push(line(1, 'CHIL', idFor.get(c)))
    if (fam.subtype) {
      lines.push('1 MARR')
      if (fam.startDate) lines.push(line(2, 'DATE', fam.startDate))
      if (fam.subtype === 'ex') {
        lines.push('1 DIV')
        if (fam.endDate) lines.push(line(2, 'DATE', fam.endDate))
      }
    }
  })

  lines.push('0 TRLR')
  return lines.join('\n') + '\n'
}
