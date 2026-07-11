// Person matching for GEDCOM import — a pure, transparent scoring model.
//
// Deciding whether an imported individual is someone already in the tree is
// fuzzy: the same person shows up as "Matt Lott" here and "Matthew James Lott"
// there, with a birth year in one file and a full date in the other. Rather
// than a single yes/no rule, we score every (imported, existing) pair on a few
// weighted signals, each carrying a human-readable reason so the review UI can
// explain *why* something is a suggested match. Structural signals (shared
// relatives) are added by the orchestrator, which has the graph context; this
// module owns the name/date scoring and the tier thresholds.

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === ''

// Signal weights. Tuned so a plausible match needs real name agreement, not
// just a shared surname (everyone in a family tree shares surnames).
export const WEIGHTS = {
  lastExact: 4,
  lastTypo: 2,
  firstExact: 4,
  firstNickname: 3,
  firstTypo: 2,
  firstInitial: 1,
  middleExact: 1,
  middleInitial: 0.5,
  birthExact: 3,
  birthYear: 2,
  birthYearConflict: -5,
  deathExact: 2,
  deathYear: 1,
  deathYearConflict: -2,
  sharedRelative: 3, // added per shared relative by the orchestrator
  sharedRelativeCap: 6,
}

// Score at/above which we default a suggestion to "merge"; between POSSIBLE and
// STRONG we surface it but leave it for the user to opt into.
export const TIERS = { STRONG: 7, POSSIBLE: 4 }

export function tierOf(score) {
  if (score >= TIERS.STRONG) return 'strong'
  if (score >= TIERS.POSSIBLE) return 'possible'
  return null
}

// Common English nickname groups. Every name in a group is treated as an alias
// of the others, so Matt↔Matthew and Bob↔Robert score as first-name agreement.
// Deliberately a curated common set, not exhaustive — recall we can't cover is
// caught by the typo (edit-distance) and initial signals instead.
const NICKNAME_GROUPS = [
  ['abigail', 'abby'],
  ['alexander', 'alex', 'xander', 'sasha'],
  ['alexandra', 'alex', 'sandra', 'sasha'],
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony'],
  ['benjamin', 'ben', 'benny'],
  ['catherine', 'katherine', 'kathryn', 'kate', 'katie', 'kathy', 'cathy', 'kat'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['christopher', 'chris', 'kit'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davy'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['edward', 'ed', 'eddie', 'ned', 'ted'],
  ['elizabeth', 'liz', 'beth', 'betty', 'betsy', 'eliza', 'lizzie', 'libby'],
  ['frederick', 'fred', 'freddie'],
  ['gregory', 'greg'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['jennifer', 'jen', 'jenny'],
  ['joseph', 'joe', 'joey'],
  ['john', 'jack', 'johnny', 'jon'],
  ['jonathan', 'jon', 'jonny'],
  ['katherine', 'kathleen', 'kate', 'katie', 'kathy'],
  ['kenneth', 'ken', 'kenny'],
  ['lawrence', 'larry', 'laurence'],
  ['leonard', 'leo', 'len', 'lenny'],
  ['margaret', 'maggie', 'meg', 'peggy', 'marge', 'greta'],
  ['matthew', 'matt', 'matty'],
  ['michael', 'mike', 'mikey', 'mick'],
  ['nicholas', 'nick', 'nicky'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['patrick', 'pat', 'paddy'],
  ['peter', 'pete'],
  ['philip', 'phillip', 'phil'],
  ['rebecca', 'becca', 'becky'],
  ['richard', 'rich', 'rick', 'ricky', 'dick', 'dickie'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie', 'bert'],
  ['ronald', 'ron', 'ronnie'],
  ['samuel', 'sam', 'sammy'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['susan', 'sue', 'susie', 'suzy'],
  ['theodore', 'theo', 'ted', 'teddy'],
  ['thomas', 'tom', 'tommy'],
  ['timothy', 'tim', 'timmy'],
  ['victoria', 'vicky', 'tori'],
  ['william', 'will', 'bill', 'billy', 'willy', 'liam'],
  ['zachary', 'zach', 'zack'],
]

// name -> Set of group ids it belongs to (a nickname like "alex" or "ted" can
// belong to more than one group, so membership is a set).
const NICK_INDEX = new Map()
NICKNAME_GROUPS.forEach((group, id) => {
  for (const name of group) {
    if (!NICK_INDEX.has(name)) NICK_INDEX.set(name, new Set())
    NICK_INDEX.get(name).add(id)
  }
})

function shareNicknameGroup(a, b) {
  const ga = NICK_INDEX.get(a)
  const gb = NICK_INDEX.get(b)
  if (!ga || !gb) return false
  for (const id of ga) if (gb.has(id)) return true
  return false
}

// Levenshtein edit distance, capped: we only care whether it's ≤ max, so we can
// bail out early. Returns the true distance when ≤ max, otherwise max + 1.
export function levenshtein(a, b, max = 2) {
  a = String(a)
  b = String(b)
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length] <= max ? prev[b.length] : max + 1
}

// Classify how two first names relate. Order of preference:
// exact > nickname > typo (edit-distance ≤1 on names long enough to be safe) >
// initial (same first letter). Returns null when there's no meaningful link.
export function firstNameRelation(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return null
  if (x === y) return 'exact'
  if (shareNicknameGroup(x, y)) return 'nickname'
  if (x.length >= 4 && y.length >= 4 && levenshtein(x, y, 1) <= 1) return 'typo'
  if (x[0] === y[0]) return 'initial'
  return null
}

// The four-digit year inside a free-form date, or null.
function yearOf(date) {
  const m = String(date || '').match(/\d{4}/)
  return m ? m[0] : null
}

function firstInitial(s) {
  const t = norm(s)
  return t ? t[0] : ''
}

/**
 * Score a single (imported, existing) pair on name + date signals. Returns the
 * numeric score, the reasons behind it (for the UI), and `firstSignal`: whether
 * the first names are linked at all. A surname-only coincidence is deliberately
 * NOT enough to be a candidate — the orchestrator uses `firstSignal` (or a
 * structural tie) to gate that out, since relatives share surnames constantly.
 * Both arguments are `{ firstName, middleName, lastName, birthdate, deathdate }`.
 */
export function scorePair(imported, existing) {
  let score = 0
  const reasons = []
  let birthExact = false

  // --- surname ---
  const il = norm(imported.lastName)
  const el = norm(existing.lastName)
  if (il && el) {
    if (il === el) {
      score += WEIGHTS.lastExact
      reasons.push('same surname')
    } else if (levenshtein(il, el, 1) <= 1) {
      score += WEIGHTS.lastTypo
      reasons.push('similar surname')
    }
  }

  // --- first name ---
  const firstRel = firstNameRelation(imported.firstName, existing.firstName)
  if (firstRel === 'exact') {
    score += WEIGHTS.firstExact
    reasons.push('same first name')
  } else if (firstRel === 'nickname') {
    score += WEIGHTS.firstNickname
    reasons.push(`${imported.firstName} is a nickname of ${existing.firstName}`)
  } else if (firstRel === 'typo') {
    score += WEIGHTS.firstTypo
    reasons.push('similar first name')
  } else if (firstRel === 'initial') {
    score += WEIGHTS.firstInitial
    reasons.push('same first initial')
  }

  // --- middle name ---
  const im = norm(imported.middleName)
  const em = norm(existing.middleName)
  if (im && em) {
    if (im === em) {
      score += WEIGHTS.middleExact
      reasons.push('same middle name')
    } else if (im[0] === em[0]) {
      score += WEIGHTS.middleInitial
    }
  }

  // --- birth ---
  if (!isEmpty(imported.birthdate) && !isEmpty(existing.birthdate)) {
    const iy = yearOf(imported.birthdate)
    const ey = yearOf(existing.birthdate)
    if (norm(imported.birthdate) === norm(existing.birthdate)) {
      score += WEIGHTS.birthExact
      birthExact = true
      reasons.push('same birth date')
    } else if (iy && ey && iy === ey) {
      score += WEIGHTS.birthYear
      reasons.push(`both born ${iy}`)
    } else if (iy && ey && iy !== ey) {
      score += WEIGHTS.birthYearConflict
      reasons.push(`born ${iy} vs ${ey}`)
    }
  }

  // --- death ---
  if (!isEmpty(imported.deathdate) && !isEmpty(existing.deathdate)) {
    const iy = yearOf(imported.deathdate)
    const ey = yearOf(existing.deathdate)
    if (norm(imported.deathdate) === norm(existing.deathdate)) {
      score += WEIGHTS.deathExact
      reasons.push('same death date')
    } else if (iy && ey && iy === ey) {
      score += WEIGHTS.deathYear
      reasons.push(`both died ${iy}`)
    } else if (iy && ey && iy !== ey) {
      score += WEIGHTS.deathYearConflict
      reasons.push(`died ${iy} vs ${ey}`)
    }
  }

  return { score, reasons, firstSignal: firstRel, birthExact }
}

export { norm, isEmpty, yearOf, firstInitial }
