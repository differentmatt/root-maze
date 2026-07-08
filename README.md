# Root Maze — setup (all from your phone)

A shared family tree. Phase 0 proves the full loop: **sign in with Google →
see "you're in group X"**, deployed to AWS via GitHub Actions.

You never need a laptop. Everything below is a browser + the GitHub mobile app.
Do the three sections in order. **~15 minutes, once.**

---

## 1. Google OAuth client (Google Cloud Console)

1. Go to **console.cloud.google.com** → create a project (or reuse one).
2. **APIs & Services → OAuth consent screen** → choose **External** → fill in
   app name + your email → Save. Add yourself under **Test users**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: leave empty for now — you'll add the
     two CloudFront URLs after step 2 (they don't exist yet).
4. Copy the **Client ID** (looks like `1234-abcd.apps.googleusercontent.com`).
   You'll paste it in the next two sections.

## 2. AWS bootstrap (AWS CloudShell — a terminal in the browser)

1. Sign in to the **AWS Console**, top-right region **N. Virginia
   (us-east-1)**.
2. Click the **CloudShell** icon in the top toolbar (a `>_` prompt).
3. Paste and run (swap in your Client ID):

   ```bash
   git clone https://github.com/differentmatt/root-maze
   cd root-maze
   GOOGLE_CLIENT_ID=YOUR_ID.apps.googleusercontent.com bash scripts/setup.sh
   ```

   > If this is a **fresh AWS account** with no GitHub OIDC provider yet,
   > add `CREATE_OIDC=true` before `bash`. (If you also run log-doom in this
   > account, leave it off — the provider already exists.)

4. When it finishes it prints a block with **role ARNs** and **your two
   URLs**. Keep that open for the next section.
5. Back in the **Google Console** (step 1.3), edit the OAuth client and add
   both printed URLs as **Authorized JavaScript origins**:
   - `https://<something>.cloudfront.net` (staging)
   - `https://<something>.cloudfront.net` (prod)

## 3. GitHub secrets (GitHub mobile app or github.com)

Repo → **Settings → Secrets and variables → Actions**:

- **Secrets** tab → New repository secret:
  - `AWS_DEPLOY_ROLE_STAGING` = the staging role ARN from step 2.4
  - `AWS_DEPLOY_ROLE_PROD` = the prod role ARN from step 2.4
- **Variables** tab → New repository variable:
  - `VITE_GOOGLE_CLIENT_ID` = your Google Client ID

---

## The loop, from now on

- I push to **`claude/root-maze`** → GitHub Actions deploys to the **staging**
  URL. Open it on your phone, sign in, tap **Create group**, reload → *"You're
  in group: …"*.
- Happy? In the GitHub app, **merge** the branch into `main` → Actions deploys
  the same thing to the **prod** URL.

Watch a run under the repo's **Actions** tab. The final log line prints the
deployed URL.

## Later phases

Phase 1 adds `person_node` / `edge` handlers and the graph UI. The schema and
group-isolation checks are already in place for it — see `CLAUDE.md`.
