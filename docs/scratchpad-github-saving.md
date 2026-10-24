# Scratchpad → GitHub saving (zero-config)

The **Scratchpad / Quick Notes** tool always autosaves to `localStorage`. The
collapsible **Save these notes to GitHub** panel adds real commits to a repo —
and it asks you for nothing. No client ID, no personal access token, no OAuth
app to create by hand.

## Why the obvious approaches need setup (and what this does instead)

| Approach | What it costs you |
| --- | --- |
| Paste a personal access token | You create the token, pick scopes, and redo it when it expires. |
| OAuth app + `client_id` | You register an app, copy its client ID, and match a callback URL exactly. |
| Authorization code exchange in the page | GitHub's token endpoint sends **no CORS headers**, so a static page can't complete it (and it would need the client secret anyway). |
| **This: GitHub App manifest + installation tokens** | **One click to create a private app owned by you, then one install screen. Never again.** |

The page registers its own GitHub App through GitHub's [app from a
manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
flow: GitHub builds the app (permissions, callback URL, keys) from a JSON
manifest the page submits, then hands the app's **ID and private key** back to
the page at `POST /app-manifests/{code}/conversions` — an endpoint that is
CORS-enabled, so no server is needed. With that key the page can sign **RS256
app JWTs** itself and mint **one-hour installation tokens** on demand, forever.

```
  dashboard                    github.com                       api.github.com
      │                            │                                  │
 1    │── POST manifest ──────────▶│ /settings/apps/new               │
      │   (+ state)                │  "Create GitHub App"             │
 2    │◀── redirect_url?code=… ────│                                  │
 3    │── POST /app-manifests/{code}/conversions ───────────────────▶│
      │◀── id + pem + slug ───────────────────────────────────────────│   (once per browser)
 4    │── install screen ─────────▶│ /apps/{slug}/installations/new   │
      │◀── back to the page ───────│                                  │
 5    │── GET /app/installations (JWT) ──────────────────────────────▶│
      │◀── installation id ───────────────────────────────────────────│   (remembered)
 6    │── POST /app/installations/{id}/access_tokens (JWT) ──────────▶│
      │◀── ghs_… token, valid 1 hour ─────────────────────────────────│   (every ~50 min)
 7    │── PUT /repos/{owner}/{repo}/contents/{path} ─────────────────▶│
      │◀── commit + blob sha ─────────────────────────────────────────│
```

Everything in steps 3–7 happens in the page. There is no long-lived credential:
the private key stays in your browser's `localStorage`, and the only thing that
travels to GitHub as authority is a 10-minute app JWT plus a 1-hour installation
token. If the browser storage is cleared you click **Set up GitHub saving**
again — one click, one install screen.

## Using it

1. Open **Scratchpad / Quick Notes** → **Save these notes to GitHub**.
2. **Set up GitHub saving** → GitHub asks you to name the new app (a default is
   pre-filled) → **Create GitHub App**.
3. GitHub sends you straight to the install screen for that app → pick
   *Only select repositories* (recommended) or all → **Install**.
4. You land back on the dashboard, already connected. Choose a **file path**
   (default `notes/scratchpad.md`); the repository dropdown lists only what the
   app can write to. **Autosave** is already on — notes are committed a few
   seconds after you stop typing; uncheck it to commit only via **Save now**.
5. From now on, opening the dashboard needs no sign-in at all: the panel
   verifies the installation in the background and mints a fresh installation
   token whenever it needs one.

Commits update the same file in place (the blob `sha` of the last sync is
remembered per `repo@branch:path`). Every save re-reads the file first: if it
changed on GitHub since the last sync — another device, another tab, a
teammate — the save pauses and offers **Pull latest** or **Overwrite anyway**
instead of silently clobbering it.

## What gets created on GitHub

- A **private** GitHub App you own, named `dash notes (<your host>)` by default.
  Private means only you can install it; it is not in the Marketplace.
- Permissions: **Contents: Read and write**, **Metadata: Read-only**. No
  webhooks, no events, no other scopes.
- An installation on the repository (or repositories) you picked.
- Commits authored by the app's bot identity in your repo.

You can inspect it under **GitHub → Settings → Developer settings → GitHub
Apps**, restrict it to other repos, or delete it at any time. Deleting it
locally is **Disconnect** (which forgets the key and cached tokens in this
browser); deleting it on GitHub is done in those settings — a browser page
can't authenticate as your GitHub account to do it for you.

## Credentials in this browser

| Key (localStorage) | Contents |
| --- | --- |
| `dash-scratchpad` | the notes themselves (always, even with no GitHub) |
| `dash-scratchpad-gh-app-v2` | app id, slug, owner, **private key**, installation id, cached installation token + expiry |
| `dash-scratchpad-gh-repo`, `-path`, `-branch`, `-autosave` | sync target + preference |
| `dash-scratchpad-gh-file-shas-v1` | last synced blob SHA per `repo@branch:path` |
| `dash-scratchpad-gh-token-v1` | only if you used the pasted-token fallback |
| sessionStorage `dash-scratchpad-gh-app-pending-v2` | CSRF `state` for the manifest handshake, deleted on return |

## Fallback: pasted token

Under **Advanced: use a personal access token instead** you can paste a
fine-grained token with **Contents: Read and write**. That path exists for
pages that can't receive GitHub's redirect — most notably a dashboard opened
from a `file://` URL, where the manifest flow can't come back. For the hosted
page you should never need it.

## Security notes

- The private key never leaves your browser (it is stored in `localStorage` and
  used locally with WebCrypto to sign JWTs). Nothing is sent to any server
  except GitHub.
- The key can only act as that one private app, with only the permissions and
  repositories you installed it on — unlike a `repo`-scoped token, it cannot
  read your other repos, your gists, or your profile.
- `localStorage` is readable by any script on the page. The dashboard ships no
  third-party scripts, but avoid opening it from an origin where you run
  untrusted code.
- Tokens are minted on demand and expire in an hour; there is no long-lived
  credential to leak.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"GitHub setup needs the dashboard served over https://…"* | The manifest handshake needs a real http(s) origin. Use the hosted dashboard or `python3 -m http.server`; `file://` can't redirect back (use the token fallback there). |
| GitHub says the app name is taken | Change the name GitHub pre-fills on the "Create GitHub App" screen; any name works. |
| You created the app but closed the tab before the install screen | Reopen the dashboard, expand the panel, click **Install on a repository**. |
| *"Couldn't confirm the installation"* | Click **Re-check connection**. If the app was deleted on GitHub, **Disconnect** and set up again. |
| `Resource not accessible by integration` | The app isn't installed on that repository, or you removed **Contents: write**. Fix it in the app's installation settings. |
| Repo dropdown is empty | The app isn't installed anywhere yet → **Install on a repository**. |
| First save says the file already exists | Expected — it never guesses. **Pull latest** to adopt it, or **Overwrite anyway**. |
| `409` / *"sha … does not match"* | The file changed at the same moment; save again or pull first. |
| Nothing commits when typing | Autosave was unchecked, or it's paused after a conflict until you pull or overwrite. |

## Tests

`docs/scratchpad-github-sync.test.js` loads `index.html` in [jsdom](https://github.com/jsdom/jsdom)
against a stubbed GitHub and covers: the manifest that is posted (and its
redirect/permission fields), the CSRF state on the callback, the conversion
response being stored without the client secret, the redirect to the install
screen, installation discovery, RS256 JWT signing verified against the app's
public key, installation-token minting and reuse, create → update commits,
conflict → overwrite, pull, autosave, the no-interaction return visit, a
tampered state being ignored, offline notes, the pasted-token fallback, and
disconnect.

```sh
npm install jsdom
node docs/scratchpad-github-sync.test.js
```
