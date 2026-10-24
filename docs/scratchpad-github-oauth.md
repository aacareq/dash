# Scratchpad → GitHub: OAuth2 user-authorization setup

The **Scratchpad / Quick Notes** tool normally autosaves to this browser's
`localStorage`. The collapsible **Back up these notes to GitHub** panel adds an
optional sync so the same note can live in a real repository as a file.

Everything happens in the browser. The dashboard is a static page with no
backend, so it authenticates as a **public OAuth client**:

```
  dashboard                     github.com                     api.github.com
      │                             │                                │
 1    │── random state + PKCE ─────▶│  /login/oauth/authorize        │
      │   code_challenge (S256)     │  (user signs in + consents)    │
 2    │◀── redirect_uri?code=… ─────│                                │
      │                             │                                │
 3    │── code + code_verifier ────▶│  /login/oauth/access_token     │
      │   (no client secret)        │                                │
 4    │◀── access_token ────────────│  (+ refresh_token if offered)  │
      │                                                              │
 5    │── PUT /repos/{owner}/{repo}/contents/{path} ────────────────▶ │
      │◀── commit + blob sha ──────────────────────────────────────── │
```

1. **Authorize.** The dashboard generates a random `state` (CSRF) and a PKCE
   `code_verifier`, sends only `SHA-256(verifier)` as `code_challenge`, then
   redirects to `https://github.com/login/oauth/authorize`.
2. **Callback.** GitHub redirects back to this page with a one-time `code`
   (and the same `state`).
3. **Exchange.** The page verifies `state`, then POSTs `code` +
   `code_verifier` + `client_id` to `https://github.com/login/oauth/access_token`.
   No `client_secret` is used or stored — PKCE is what makes that safe for a
   public client. The verifier lives in `sessionStorage` only for the length
   of the redirect and is deleted immediately afterwards; the `code`/`state`
   query params are stripped from the URL with `history.replaceState`.
4. **Token.** The user token is kept in `localStorage` under
   `dash-scratchpad-gh-token-v1`. If GitHub returns `expires_in` and a
   `refresh_token` (GitHub Apps, or OAuth Apps with expiring tokens enabled),
   the dashboard refreshes automatically a minute before expiry and on any
   `401`, storing the rotated pair.
5. **Commit.** Notes are written with the Contents API. The blob `sha` of the
   last sync is remembered per `repo@branch:path`, so subsequent saves update
   the file in place. Every save re-reads the file first: if it changed on
   GitHub (another device, another tab, a teammate), the save pauses and
   offers **Pull Latest** or **Overwrite Anyway** instead of silently
   clobbering it.

## One-time app registration

You only need to do this once. Either app type works.

### Option A — GitHub OAuth App (simplest)

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (<https://github.com/settings/applications/new>).
2. Fill in:
   - **Application name** — anything, e.g. `dash scratchpad`.
   - **Homepage URL** — where you open the dashboard, e.g.
     `https://aacareq.github.io/dash/`.
   - **Authorization callback URL** — must match the dashboard URL *exactly*
     (see below).
3. Click **Register application**, copy the **Client ID** (it looks like
   `Iv1.0123456789abcdef`). There is no secret to copy — this flow doesn't use
   one.
4. In the dashboard, open **Scratchpad → Back up these notes to GitHub**, pick
   **OAuth App (repo scope)**, paste the Client ID, and click **Connect GitHub**.

The requested scope is `repo`, which is what allows reading and writing
repository contents (including private repos).

### Option B — GitHub App

1. **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
   (<https://github.com/settings/apps/new>).
2. Set the **Callback URL** to the same value as in Option A.
3. Under **Permissions → Repository permissions**, grant **Contents:
   Read and write** (and **Metadata: Read-only**, which GitHub adds
   automatically).
4. Leave webhooks off; create the app and copy its **Client ID**.
5. **Install** the app on the repos you want to write to.
6. In the dashboard pick **GitHub App (offline_access / refresh tokens)**,
   paste the Client ID, and connect. The `offline_access` scope is what asks
   GitHub for an expiring 8-hour user token plus a 6-month refresh token; the
   dashboard rotates them for you.

GitHub Apps are scoped to the repositories they're installed on, which is the
tighter option if you'd rather not hand out a `repo`-wide token.

### Authorization callback URL

Register the exact URL the dashboard is loaded from. It is shown read-only in
the panel as **Authorization callback URL** — copy it from there. Typically:

| Where you open the dashboard | Callback URL to register |
| --- | --- |
| `https://aacareq.github.io/dash/` | `https://aacareq.github.io/dash/` |
| `https://aacareq.github.io/dash/index.html` | `https://aacareq.github.io/dash/index.html` |
| `http://localhost:8000/index.html` | `http://localhost:8000/index.html` |

GitHub matches this string **exactly** — no trailing-slash guessing, no
wildcards (unless you use the multiple-callback-URLs feature on newer
accounts). Trailing slash and `/index.html` are different URLs, so if you use
both, register both.

To serve the checkout locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000/index.html
```

The redirect flow needs a **secure context**: `https://` or
`http://localhost`. Opening `index.html` straight from disk (`file://`) can't
use `crypto.subtle`, so the panel explains that instead of failing silently.

## Using it

1. Open **Scratchpad / Quick Notes** and expand **Back up these notes to
   GitHub**.
2. Connect GitHub (above). The badge should read *Connected as @you*.
3. Choose a **Repository** (`owner/repo` — **Load My Repos** fills a picker
   from your GitHub account) and a **File path**, e.g. `notes/scratchpad.md`.
   Leave **Branch** blank to use the repo's default branch, or name one to
   commit to (or create) that branch.
4. **Save to GitHub** commits the note. If the file already exists, the first
   save asks you to **Pull Latest** or **Overwrite Anyway** rather than
   guessing.
5. Optionally tick **Autosave to GitHub** to commit ~3 seconds after you stop
   typing. Local `localStorage` autosave keeps working either way, so losing
   the network never loses the note.
6. **Pull Latest** replaces the editor with the repo's copy (it asks first if
   the editor differs). **Disconnect** deletes the token from this browser.

Repository, path, branch and the autosave preference are remembered between
visits.

## Where the data lives

| Key (localStorage unless noted) | Contents |
| --- | --- |
| `dash-scratchpad` | the notes themselves (always, even without GitHub) |
| `dash-scratchpad-gh-client-id` | the OAuth/GitHub App Client ID (not secret) |
| `dash-scratchpad-gh-app-type` | `oauth_app` or `github_app` |
| `dash-scratchpad-gh-token-v1` | access token, refresh token, expiry, `@login` |
| `dash-scratchpad-gh-repo`, `-path`, `-branch`, `-autosave` | sync target + preference |
| `dash-scratchpad-gh-file-shas-v1` | last synced blob SHA per `repo@branch:path` |
| sessionStorage `dash-scratchpad-gh-oauth-pending` | PKCE verifier + state, deleted on callback |

## Security notes

- No client secret exists anywhere in this repo or in the browser; PKCE plus
  exact redirect-URI matching protects the code exchange.
- The access token is a real credential in `localStorage`, readable by any
  script on the page. Use the narrowest app type you can (a GitHub App
  installed on one repo, rather than a `repo`-scoped OAuth App), and avoid
  pasting this dashboard into a page that also runs untrusted third-party
  scripts.
- **Disconnect** removes the token locally. To invalidate it on GitHub's side
  as well, revoke the authorization under **GitHub → Settings → Applications
  → Authorized OAuth Apps / Installed GitHub Apps**. (Revoking an app token
  server-side requires the client secret, so the page can't do it for you.)
- Anything committed is a normal commit, so it's in the repo's history and
  visible to whoever can read that repo. Don't put secrets in the scratchpad
  and sync it to a public repo.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `redirect_uri mismatch` / `The redirect_uri MUST match…` | The callback URL registered on the app doesn't exactly match the page URL (see table above). Open the dashboard at a URL you've registered. |
| *"GitHub sign-in needs a secure page…"* | Open over `https://` or `http://localhost`, not `file://` (or an `http://` LAN address, which isn't a secure context). |
| *"Sign-in couldn't be verified because the state value didn't match…"* | The callback landed in a different browser/tab than the one that started it, or session storage was cleared. Click **Connect GitHub** again. |
| `Bad credentials` / *"GitHub rejected this token"* | The token was revoked or expired and can't be refreshed. Reconnect; check the app is still installed/authorized. |
| `Resource not accessible by integration` | GitHub App isn't installed on that repo, or lacks **Contents: Read and write**. |
| `Not Found` when saving to a private repo | OAuth App token lacks the `repo` scope, or the GitHub App isn't installed there. |
| File already exists warning on first save | Expected — the panel never guesses. **Pull Latest** to adopt it or **Overwrite Anyway**. |
| `409` / *"sha … does not match"* on save | Someone changed the file at the same moment. Save again, or **Pull Latest** first. |
| Autosave seems idle | It only fires when connected, with a repo + path filled in, and stays paused after a conflict until you pull or overwrite. |

## Tests

`docs/scratchpad-github-sync.test.js` drives `index.html` in [jsdom](https://github.com/jsdom/jsdom)
with a stubbed GitHub, covering the PKCE challenge, the authorization request,
the code exchange (asserting no client secret is sent), the CSRF `state` check,
create-then-update saves, conflict/overwrite, pull, autosave, and token refresh.

```sh
npm install jsdom
node docs/scratchpad-github-sync.test.js
```
