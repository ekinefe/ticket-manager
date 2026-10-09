# GitHub integration setup (GitHub App)

A GitHub App is registered on github.com in the browser, so it works the same on Linux, Mac and Windows.
You need it only once; after that each project just links one repo.

## 1. Create the App
GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**

- **Name:** anything unique (e.g. `my-ticket-manager`)
- **Homepage URL:** your app URL (e.g. `https://ticket-manager.gnrdigital.workers.dev`)
- **Webhook → Active:** on
- **Webhook URL:** `<your app URL>/api/github/webhook`
- **Webhook secret:** a long random string (`openssl rand -hex 32`) — keep it, you paste it below
- **Repository permissions:**
  - Contents: **Read and write** (needed only for "Create branch"; use Read-only if you won't use it)
  - Pull requests: **Read-only**
  - Metadata: Read-only (automatic)
- **Subscribe to events:** **Push**, **Pull request**
- **Where can this app be installed:** Only on this account

Create it, then note the **App ID**, and **Generate a private key** (downloads `*.pem`).

## 2. Convert the key (GitHub gives PKCS#1, the app needs PKCS#8)
    openssl pkcs8 -topk8 -nocrypt -in downloaded.pem -out app-pkcs8.pem

## 3. Install the App on your private repo(s)
App page → **Install App** → choose your account → **Only select repositories** → pick the repo(s).

## 4. Paste into Ticket Manager
Admin → **Settings** → GitHub section: App ID, contents of `app-pkcs8.pem`, webhook secret. Save.
Tick "Allow creating a branch from a ticket" only if you want that button (off by default).

## 5. Link each project
Admin → Projects → project → **GitHub repository** = `owner/name`.

## What you get
- Commits and PRs that mention a ticket id (e.g. `PLN-12`) in the commit message, PR title/description or branch name appear in the ticket's **Development** panel.
- PR opened → ticket moves to **Under Review** (only from To Do / In Progress). PR merged → **Done**. Draft PRs don't move anything.
- Dashboard **Repo Activity** lists recent commits/PRs of your projects.
- Optional **Create branch** button creates `feature/PLN-12` (or `hotfix/PLN-12` for bugs) from the default branch.

## Troubleshooting
- GitHub App page → **Advanced** → *Recent Deliveries* shows each webhook and our response (401 = secret mismatch, `repository is not linked` = repo not set on a project).
- "The GitHub App is not installed on this repository" → do step 3 for that repo.
