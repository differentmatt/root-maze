# Root Maze

A casual, **shared** family-tree mobile web app. Multiple family members edit
one graph (people + relationships). Graph display, not a strict hierarchy.
Push to a branch and GitHub Actions deploys.

Stack and cloud approach are deliberately reused from the `log-doom` repo.

## Phase

**Phase 0 (done): prove the loop.** Sign in with Google → land on a page that
shows either "create a group" or "you're in group X". This exercised auth +
group membership + DynamoDB + deploy end-to-end.

**Phase 1 (done): people + relationships.** `person_node` and `edge`
(`edgeKind: parent_child | partner`) handlers, gated by the same
`requireMember` group-isolation check, plus a minimal force-directed graph UI
to add and view people and relationships. Soft-delete, `updatedAt`/`updatedBy`,
and the nullable `accountId` on nodes are all preserved; deleting a person
cascade-soft-deletes the edges that touch it.

**Phase 2 (done): membership & invites.** A group can now have more than its
creator. Members are `owner` or `editor` (a group always keeps ≥1 owner — the
last owner can't be removed or demoted). Sharing is via **invite links**: a
member mints an `INVITE#<token>` item (256-bit CSPRNG token, default 7-day
expiry, multi-use with an optional max-use cap, revocable via soft-delete). The
token also carries GSI1 keys (`GSI1PK=INVITE#<token>`) so a bare token resolves
to its group without leaking the `groupId` in the link. An unauthenticated
invitee sees only the group name (`GET /api/invites/{token}`); accepting
requires signing in and always grants `editor` (never owner). Any member may
manage membership and invites — deliberately low-friction for a casual family
app. Every write keeps soft-delete, `updatedAt`/`updatedBy`, and the append-only
edit log.

**Phase 3 (done): identity linking.** Connect a signed-in account to a person
in the tree. The link lives on `person_node.accountId` — a member claims a node
as themselves ("This is me"), and the members + tree UI surface who's who (the
caller's own node gets an emerald ring; claimed nodes get a dot). Integrity is
enforced server-side in `lib/links.js`: a node links to at most one account
(claiming an already-claimed node is a `409`), and an account to at most one node
per group (re-linking *moves* the link, clearing the old node). `accountId` is no
longer directly writable via a plain node write — all linking goes through
`PUT`/`DELETE /api/groups/{groupId}/members/{accountId}/link` (backed by the
`links` handler). **Permissions:** a member links/unlinks their *own* account
freely; linking/unlinking *another* member's is owner-only. Accepting an invite
optionally offers a "which person are you?" link-on-join step (skippable). Also
adds the "New group" affordance — create a second group you own from the
workspace (the backend already allowed it). Every link/unlink preserves
soft-delete, `updatedAt`/`updatedBy`, and appends `link`/`unlink` edit-log rows.

**Phase 4 (current): GEDCOM import/export.** Bring a family tree in from (or send
it out to) any genealogy tool via GEDCOM 5.5.1 (`INDI`/`FAM` core). Any member
may import/export. Parsing + mapping + serialization are pure in
`lib/gedcom.js`; person matching is a pure weighted-scoring model in
`lib/gedcom-match.js` (name via exact/nickname/typo/initial, birth/death by
exact-or-year with a conflicting-year penalty, tiered strong/possible); the
DynamoDB-facing matching/writing is in `lib/gedcom-import.js`.
Our model is narrower than GEDCOM, so `SEX` and birth/death `PLAC` are folded
into `notes` with a `Label: value` convention that export reads back to rebuild
the tags (a deliberately lossy-but-legible round trip). Import is **two-phase**:
`POST .../import/preview` diffs a file against the tree (no writes) and, per
imported person, returns ranked match **candidates** — scored on name + dates and
then boosted when they share a relative already in the tree (a two-pass
structural signal) — each with a per-field diff (`same`/`fill`/`conflict`/
`treeOnly`) and the relationships the person brings; `POST .../import/commit`
applies the caller's per-person resolutions (`create`/`merge` into a chosen
candidate with chosen `fields`/`skip`, keyed by GEDCOM xref)
then wires relationships via `createEdge` (reusing its referential-integrity +
one-relationship-per-pair rules; a duplicate/self-loop is skipped, not fatal).
The client re-sends the same GEDCOM text on commit, so nothing is staged
server-side. Export (`GET .../export`) serializes the whole group, reconstructing
`FAM` records from our pairwise edges. "New group from a file" is just create +
commit into the empty group (every person is new, so no review). Every write
keeps soft-delete, `updatedAt`/`updatedBy`, and the edit log.

## Commands

- `npm run dev` — Vite dev server (frontend only)
- `npm run build` — type-check + build to `dist/`
- `npm run lint` — ESLint
- `npm run test:run` — frontend tests (Vitest)
- `cd backend && npm test` — backend tests (Vitest)

## Architecture

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4, PWA-ready
  (`vite-plugin-pwa`). Mobile-first, dark zinc theme. Same-origin API calls to
  `/api/*` (no CORS).
- **Auth**: Google Sign-In on the client; the ID token (JWT) is sent as a
  `Bearer` header and re-verified server-side with `jose` against Google's
  JWKS. We never trust the client beyond the verified token.
- **Identity**: the Google `sub` is never used as an id. `lib/accounts.js`
  maps `AUTH#GOOGLE#<sub> -> ACCOUNT#<ulid>`, so login providers are swappable
  and a person can be referenced before they ever sign in.
- **Backend**: AWS Lambda (Node 20, arm64) behind API Gateway v2, data in
  **DynamoDB** (single table + `GSI1`).
- **Group isolation**: all tree data lives under a `GROUP#<id>` partition.
  `lib/groups.js#requireMember` gates every group-scoped request — this is the
  server-side enforcement of "family A can't see family B".
- **Hosting**: S3 + CloudFront (default `*.cloudfront.net`, no custom domain
  yet). Two stacks: `root-maze-staging` and `root-maze-prod`.
- **Deploy**: GitHub Actions, OIDC (no stored AWS keys). Push to any
  `claude/**` branch → **staging**; merge to `main` → **prod**.

## DynamoDB single-table schema

| Entity        | PK                    | SK                | Notes |
|---------------|-----------------------|-------------------|-------|
| Account       | `ACCOUNT#<accountId>` | `META`            | accountId is our ULID |
| Google link   | `AUTH#GOOGLE#<sub>`   | `META`            | `{ accountId }` |
| Group         | `GROUP#<groupId>`     | `META`            | soft-delete via `deletedAt` |
| Membership    | `GROUP#<groupId>`     | `MEMBER#<acct>`   | `role: owner \| editor`; `GSI1PK=ACCOUNT#<acct>`, `GSI1SK=GROUP#<groupId>` |
| invite        | `GROUP#<groupId>`     | `INVITE#<token>`  | `role`, `expiresAt`, `maxUses`, `useCount`; `GSI1PK=INVITE#<token>`, `GSI1SK=GROUP#<groupId>` (token → group) |
| person_node   | `GROUP#<groupId>`     | `NODE#<nodeId>`   | structured name: `firstName` (required) + optional `lastName`/`middleName`/`birthName`; the API also returns a derived full `name`. Legacy rows carry only `name` and are tolerated (migrated on next edit). nullable `accountId` = the linked member (Phase 3); set only via the link endpoint, not a plain node write |
| edge          | `GROUP#<groupId>`     | `EDGE#<edgeId>`   | `edgeKind: parent_child \| partner` |
| edit_log      | `GROUP#<groupId>`     | `LOG#<ulid>`      | append-only, never mutated |

All mutable rows carry `updatedAt` / `updatedBy` and soft-delete `deletedAt`.
`person_node` and `edge` handlers landed in Phase 1: reads via
`GET /api/groups/{groupId}/graph`, writes via `POST/PATCH/DELETE` on
`.../nodes[/{nodeId}]` and `.../edges[/{edgeId}]`.

Group create + rename routes (backed by the `groups` handler):
`POST /api/groups` (create), `PATCH /api/groups/{groupId}` (rename — any member
may rename; ≤100 chars). The workspace surfaces this under a "Group" tab (first,
default) that also holds the group switcher, the "New group" affordance, and the
members/invites panel.

Phase 2 membership & invite routes:
`GET/DELETE/PATCH /api/groups/{groupId}/members[/{accountId}]`,
`GET/POST /api/groups/{groupId}/invites`,
`DELETE /api/groups/{groupId}/invites/{token}`, and the token-addressed
`GET /api/invites/{token}` (public preview) + `POST /api/invites/{token}/accept`.

Phase 3 identity-linking routes (backed by the `links` handler):
`PUT/DELETE /api/groups/{groupId}/members/{accountId}/link` (`PUT` body
`{ nodeId }`). The members list (`GET .../members`) is enriched with each
member's `linkedNodeId`/`linkedNodeName`.

Phase 4 GEDCOM routes (backed by the `gedcom` handler; any member):
`POST /api/groups/{groupId}/import/preview` (body `{ gedcom }` → diff),
`POST /api/groups/{groupId}/import/commit` (body `{ gedcom, resolutions }`),
`GET /api/groups/{groupId}/export` (→ `{ gedcom, filename }`).

## Key files

- `src/App.tsx` — sign-in → group state → Group/Tree workspace (Group tab first:
  switch, rename, new group, members); also the `/?invite=<token>` join route
- `src/tree/` — `TreeView` (group screen), `GraphCanvas` + `layout` (SVG graph),
  `siblings` + `suggestions` (derived relationships, incl. likely other parent)
- `src/members/` — `MembersPanel` (members + invite links + who's-who linking),
  `JoinScreen` (accept + optional link-on-join)
- `src/gedcom/` — `ImportExport` (Group-tab panel: export download, import →
  preview → review conflicts → commit, and new-group-from-file)
- `src/components/PersonPicker` — searchable person combobox (replaces long
  `<select>` lists in the tree + members UIs)
- `src/auth.ts`, `src/api.ts` — client auth state + fetch wrapper
- `backend/lib/` — `auth`, `dynamo`, `accounts`, `groups` (incl. membership
  management), `invites`, `links` (identity linking), `nodes`, `edges`, `graph`,
  `gedcom` (pure parse/map/serialize), `gedcom-match` (pure person-scoring),
  `gedcom-import` (preview/commit),
  `http` (auth+membership gate; returns the caller's membership row), `ids`,
  `errors`, `response`
- `backend/handlers/` — `me`, `groups`, `graph`, `nodes`, `edges`, `members`,
  `invites`, `links`, `gedcom`
- `infra/template.yaml` — one CloudFormation template, two stacks
- `scripts/setup.sh` — one-time bootstrap (run in AWS CloudShell)
- `.github/workflows/deploy.yml` — branch-routed deploy

## First-time setup

See `README.md` for deployment and first-time infrastructure setup.
