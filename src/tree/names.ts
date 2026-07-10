// Name helpers shared by the tree UI. Names are structured (firstName plus
// optional lastName/middleName/maidenName), but legacy nodes carry only a single
// `name` string, so every helper tolerates both shapes.

import type { PersonNode } from '../api'

// A minimal shape so these work on anything name-ish (real nodes, the sibling
// summaries, test fixtures) without dragging the whole PersonNode along.
export type NameParts = {
  name?: string
  firstName?: string | null
  lastName?: string | null
  middleName?: string | null
  maidenName?: string | null
}

// Best-effort first token when a node has no structured firstName (legacy rows).
function firstOf(n: NameParts): string {
  if (n.firstName && n.firstName.trim()) return n.firstName.trim()
  return (n.name ?? '').trim().split(/\s+/)[0] ?? ''
}

// The structured parts to seed an edit form, filling first/last from a legacy
// single name (first token → firstName, the rest → lastName) so editing a legacy
// person starts from something sensible and migrates it on save.
export function namePartsOf(n: NameParts): {
  firstName: string
  lastName: string
  middleName: string
  maidenName: string
} {
  if (n.firstName || n.lastName || n.middleName || n.maidenName) {
    return {
      firstName: n.firstName ?? '',
      lastName: n.lastName ?? '',
      middleName: n.middleName ?? '',
      maidenName: n.maidenName ?? '',
    }
  }
  const tokens = (n.name ?? '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: tokens[0] ?? '',
    lastName: tokens.slice(1).join(' '),
    middleName: '',
    maidenName: '',
  }
}

// Full name: "First Middle Last", falling back to the legacy string.
export function fullName(n: NameParts): string {
  const parts = [n.firstName, n.middleName, n.lastName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
  if (parts.length) return parts.join(' ')
  return (n.name ?? '').trim()
}

// Compact form for graph labels: "First L." when we know a last name, else just
// the first name. Empty only for a truly nameless node.
export function shortName(n: NameParts): string {
  const first = firstOf(n)
  const last = (n.lastName ?? '').trim()
  if (first && last) return `${first} ${last[0]}.`
  return first || (n.name ?? '').trim()
}

// "née Byron" suffix for someone whose maiden/birth name differs from their
// current last name. Empty when there's nothing distinct to show.
export function neeSuffix(n: NameParts): string {
  const maiden = (n.maidenName ?? '').trim()
  if (!maiden) return ''
  if (maiden === (n.lastName ?? '').trim()) return ''
  return `née ${maiden}`
}

// Label for a node within a set of nodes: the compact form, widened to the full
// name only when another visible person shares the same compact form (two
// "John S." cousins), so labels stay clean but never ambiguous.
export function labelFor(n: PersonNode, all: PersonNode[]): string {
  const short = shortName(n)
  const collides = all.some(
    (o) => o.nodeId !== n.nodeId && shortName(o) === short,
  )
  return collides ? fullName(n) || short : short
}
