# Root Maze

A casual, **shared** family-tree mobile web app. Multiple family members edit
one graph (people + relationships). Graph display, not a strict hierarchy.
Developed entirely from a phone — push to a branch, GitHub Actions deploys.

Stack and cloud approach are deliberately reused from the `log-doom` repo.

## Phase

**Phase 0 (current): prove the loop.** No tree UI yet. Sign in with Google →
land on a page that shows either "create a group" or "you're in group X".
This exercises auth + group membership + DynamoDB + deploy end-to-end.

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
| Membership    | `GROUP#<groupId>`     | `MEMBER#<acct>`   | `role`; `GSI1PK=ACCOUNT#<acct>`, `GSI1SK=GROUP#<groupId>` |
| person_node   | `GROUP#<groupId>`     | `NODE#<nodeId>`   | nullable `accountId` (later identity linking) |
| edge          | `GROUP#<groupId>`     | `EDGE#<edgeId>`   | `edgeKind: parent_child \| partner` |
| edit_log      | `GROUP#<groupId>`     | `LOG#<ulid>`      | append-only, never mutated |

All mutable rows carry `updatedAt` / `updatedBy` and soft-delete `deletedAt`.
`person_node` and `edge` are stubbed in the schema but have no handlers yet
(Phase 1).

## Key files

- `src/App.tsx` — Phase 0 page (sign-in → group state)
- `src/auth.ts`, `src/api.ts` — client auth state + fetch wrapper
- `backend/lib/` — `auth`, `dynamo`, `accounts`, `groups`, `ids`, `response`
- `backend/handlers/` — `me` (GET /api/me), `groups` (POST /api/groups)
- `infra/template.yaml` — one CloudFormation template, two stacks
- `scripts/setup.sh` — one-time bootstrap (run in AWS CloudShell)
- `.github/workflows/deploy.yml` — branch-routed deploy

## First-time setup

See `README.md` for the click-by-click dashboard steps (Google OAuth client,
AWS CloudShell bootstrap, GitHub secrets).
