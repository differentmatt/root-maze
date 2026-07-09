# Root Maze

A casual, shared family-tree web app. Multiple family members edit one graph
(people + relationships); graph display, not a strict hierarchy. Mobile-first.

## Phase

**Phase 0 (current): prove the loop.** No tree UI yet — sign in with Google and
land on a page that shows either "create a group" or "you're in group X". This
exercises auth + group membership + DynamoDB + deploy end to end.

## Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4, PWA-ready.
  Dark theme; same-origin API calls under `/api/*`.
- **Auth**: Google Sign-In; the ID token is re-verified server-side with `jose`.
- **Backend**: AWS Lambda (Node 20, arm64) + API Gateway v2; data in DynamoDB
  (single table + `GSI1`).
- **Group isolation**: a server-side membership check gates every
  group-scoped request.
- **Hosting**: S3 + CloudFront. **Deploy**: GitHub Actions via OIDC.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — type-check + build to `dist/`
- `npm run lint` — ESLint
- `npm run test:run` — frontend tests
- `cd backend && npm test` — backend tests

## Deployment

Branch-routed by GitHub Actions:

- push to any non-`main` branch → **staging** (`root-maze-staging`)
- merge to `main` → **prod** (`root-maze-prod`)

Both stacks come from one template, `infra/template.yaml`.

### First-time infrastructure

`scripts/setup.sh` provisions both stacks. Run it once against the target AWS
account (any environment with AWS credentials, e.g. AWS CloudShell):

```bash
GOOGLE_CLIENT_ID=<oauth-web-client-id> bash scripts/setup.sh
```

It prints the deploy-role ARNs and the site URLs. Then, in the GitHub repo
(Settings → Secrets and variables → Actions):

- Secrets: `AWS_DEPLOY_ROLE_STAGING`, `AWS_DEPLOY_ROLE_PROD`
- Variable: `VITE_GOOGLE_CLIENT_ID`

Add each site URL as an Authorized JavaScript origin on the Google OAuth
client. Subsequent pushes deploy automatically.

### Custom domain (prod, optional)

`scripts/request-cert.sh <domain>` requests an ACM certificate and prints the
DNS validation records. Once the cert is issued, set repo **variables**
`PROD_DOMAIN` and `PROD_CERT_ARN`, redeploy prod, and point the domain (and its
`www` host) at the prod CloudFront distribution. Staging always stays on its
default CloudFront domain.

## Architecture, schema, and key files

See [`CLAUDE.md`](./CLAUDE.md).
