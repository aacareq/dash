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
| **This: GitHub App manifest + installation tokens** | **One click to create a private app owned by you, then one install screen.** |
| …and the connection file | **One file to carry it to any other browser, so the app is created once, ever.** |

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
token.

Because that key only exists in **one browser at one address**, clearing site
data (or opening the dashboard somewhere new) means this browser can no longer
prove it is your app. That does not mean you need a second app — see
**[Reconnecting without creating another app](#reconnecting-without-creating-another-app)**.

## Using it

1. Open **Scratchpad / Quick Notes** (pinned as the first card in
   **Favorites**, and also in **Working On**) → **Save these notes to GitHub**.
2. **Set up GitHub saving** → GitHub asks you to name the new app (a default is
   pre-filled) → **Create GitHub App**.
3. GitHub sends you straight to the install screen for that app → pick
   *Only select repositories* (recommended) or all → **Install**.
4. You land back on the dashboard, already connected. The repository
   dropdown lists only what the app can write to, and a private repo called
   **`scratch`** is created for you if you don't have one yet (see below).
   **Autosave** is already on — notes are committed a few seconds after you
   stop typing; uncheck it to commit only via **Save now**.
5. From now on, opening the dashboard needs no sign-in at all: the panel
   verifies the installation in the background and mints a fresh installation
   token whenever it needs one.
6. **Download the connection file** (see the next section) so this setup never
   has to be repeated — on this browser or any other.

## Reconnecting without creating another app

### Why the panel sometimes looks like a first visit

The private key GitHub hands over in step 3 **is** the app, and it is stored only
in this browser's storage for this exact address (scheme + host + port). Nothing
is kept on a server, so every row below looks exactly like a first visit — and
the old answer was always *Create GitHub App* again:

| What happened | Why the key is gone |
| --- | --- |
| A different address — a preview/sandbox link, a new `localhost:PORT`, `127.0.0.1` instead of `localhost`, `http` instead of `https` | Browser storage is per-origin |
| A different browser, profile or device, or a private window | Each has its own storage |
| "Clear cookies and site data", storage-cleanup extensions | That is the storage |
| iOS Safari: ~7 days without a visit (unless the site is added to the Home Screen) | Safari expires script-writable storage |
| Disk-pressure eviction | Mitigated by requesting `navigator.storage.persist()`, not eliminated |

The app you made is **not** gone: it is still under **GitHub → Settings →
Developer settings → GitHub Apps**. Only this browser's copy of its key is.

### The fix: save a copy of the key once

While connected, the panel shows **Download connection file**. It writes
`dash-github-connection-<app-slug>.json` containing the app's ID, slug, owner and
private key (never a short-lived token). Put it in your password manager. The
panel keeps a **Keep a copy of this connection** reminder until you have done it.

### Restoring it anywhere

Open **Save these notes to GitHub → Already have the app? Reconnect instead of
creating another**, then either:

- **Choose the connection file** you saved — it fills in the App ID and the key
  for you; or
- **Copy the App ID** from the top of the app's settings page and click
  **Generate a private key** there (GitHub downloads a `.pem`), then paste the
  key into the box.

Click **Reconnect with this app**. The page signs a JWT with the key you supplied
and asks GitHub to confirm it (`GET /app`), so a mismatched App ID is caught
immediately — and nothing is saved until GitHub agrees, so a typo can never
destroy a working connection. On success it finds the installation that is
already there and saving resumes. **No new app is created**: no name to invent,
no extra app to delete later.

What each piece is, in one line:

| Piece | Where it comes from | What it is used for |
| --- | --- | --- |
| **App ID** | Top of the app's settings page (`https://github.com/settings/apps/<slug>`) | The `iss` claim in the app JWT |
| **Private key** (`.pem`) | **Generate a private key** on the same page, or the connection file | Signs the JWT that mints installation tokens |
| **Connection file** (`.json`) | **Download connection file** in the panel | Both of the above, in one file |

Notes stay put while you do this: they live in the note database and are never
touched by disconnecting or reconnecting.

## The `scratch` repo and dated note files

- **`scratch` is created automatically.** The first time the app can't see a
  repo called `scratch`, it creates one — private, with an initial commit so
  there is a default branch to write to — and switches to it. **Use scratch
  repo** re-runs that on demand (for example after deleting it).
- **Each note gets its own file.** The **File path** box is prefilled with
  `notes-YYYY-MM-DD-HHMM.md`, e.g. `notes-2026-10-24-1142.md`, and **New dated
  file** mints a fresh name whenever you want another one. Because the name is
  what's saved, yesterday's notes are never overwritten by today's.

Creating a repo needs the app's **Repository creation: write** permission
(least privilege — it can create repositories but not delete or transfer them).
Apps registered from this dashboard's manifest already request it. If yours
predates that change, GitHub refuses with *"Resource not accessible by
integration"* and the panel offers two fixes: grant **Repository creation:
write** in the app's permissions and accept it on the installation, or create
`scratch` yourself and add it to the app. `Disconnect → Set up GitHub saving`
also re-registers the app with the new permission. Saving to any repo the app
can already write to keeps working either way.

## Writing markdown

The notes are markdown files, so the editor has the syntax built in:

| Tool | Result | Shortcut |
| --- | --- | --- |
| **B** / *I* / ~~S~~ | `**bold**`, `*italic*`, `~~strikethrough~~` | Ctrl/⌘+B, Ctrl/⌘+I, Ctrl/⌘+Shift+X |
| H1 / H2 / H3 | `#`, `##`, `###` — clicking another level replaces it, clicking the same one removes it | — |
| • List / 1. List | bulleted and numbered lists, applied to every selected line | Ctrl/⌘+E for a bulleted list |
| ☑ Task | `- [ ]` task lines | — |
| ❝ Quote / ― Divider | `> quote`, `---` | — |

Everything acts on the selection, or inserts at the caret when nothing is
selected, and toolbar edits count as typing — so local autosave and GitHub
autosave pick them up exactly like keyboard input.

**😊 Emoji** opens a small searchable picker (type `check`, `tada`, `fire`…,
or press Enter to take the first match). Clicking an emoji drops it in at the
caret or replaces the selection; Esc or a click outside closes it.

**👁 Preview** shows a live rendered version beside the editor. Its task
checkboxes are real: ticking one rewrites that `- [ ]` line to `- [x]` in the
source. The preview escapes note content before rendering, so pasted HTML is
shown as text rather than executed, and only `http(s)` links are turned into
links. The preview choice is remembered between visits.

## The editor header

Above the editor sits a one-line bar showing exactly where the note is going:

```
📄 octocat/scratch / notes-2026-10-24-1142.md      Synced to GitHub · 11:42
```

- The **repo** comes from the repository picker and the **file name** from the
  File path box; both update as you change them, and the full path is on the
  hover title.
- Before GitHub is set up the repo slot reads **Local only**, so it's obvious
  the note isn't leaving the browser yet.
- The right-hand **save state** says `Saved locally`, `Not saved to this file
  yet`, `Synced to GitHub · <time>`, `Loaded from GitHub · <time>`, or the
  last error — the same information as the status lines, without needing the
  GitHub panel open.

### `scratch` is always the default target

The notes repo isn't something the dashboard *discovers* — it's the default it
aims at. `<your-account>/scratch` is offered in the repository picker even when
GitHub's listing doesn't mention it, marked **_(default)_**, and it is selected
ahead of any previously used repo:

- If GitHub's listing has it → selected.
- If the listing lags behind a repo that was just created, or the app is
  installed on *selected* repositories so `scratch` isn't in the installation →
  it is still offered and selected, and saving writes to it.
- If it doesn't exist at all → it's created (see above) and then selected.
- If the app isn't allowed to create it → it stays selected and the panel says
  exactly which permission to grant; nothing silently writes elsewhere.
- Only an explicit pick in the dropdown changes the target for that session.

If a save fails because the app genuinely can't reach `<account>/scratch`
(e.g. the repo exists but was never added to the installation), the panel names
the repo and links to **GitHub → Settings → Installations** to add it, then
**Re-check connection** picks it up.

## Small screens

The notes tool is built to be usable at any width:

- **≥ 900px** — editor and preview sit side by side in the wide dialog.
- **641–900px** — the preview drops below the editor; the GitHub panel's
  fields go to a single column.
- **≤ 640px** — the dialog becomes a full-height sheet (safe-area aware, uses
  `dvh` so mobile browser chrome doesn't clip it), the toolbar wraps with
  36px tap targets, the preview shrinks, and buttons grow to fill the row.
- **≤ 380px** — the toolbar buttons that carry words (Quote, Divider) collapse
  to their symbols so nothing overflows.
- The card itself scrolls (`overscroll-behavior: contain`) so a long note plus
  the expanded GitHub panel never traps the page behind it.

Commits update the same file in place (the blob `sha` of the last sync is
remembered per `repo@branch:path`). Every save re-reads the file first: if it
changed on GitHub since the last sync — another device, another tab, a
teammate — the save pauses and offers **Pull latest** or **Overwrite anyway**
instead of silently clobbering it.

## What gets created on GitHub

- A **private** GitHub App you own, named `dash notes (<your host>)` by default.
  Private means only you can install it; it is not in the Marketplace.
- Permissions: **Contents: Read and write**, **Metadata: Read-only**, and
  **Repository creation: Read and write** (so it can make the private
  `scratch` repo — this is the narrow permission, not full repository
  administration, so it still can't delete or transfer anything). No webhooks,
  no events, no other scopes.
- An installation on the repository (or repositories) you picked.
- Commits authored by the app's bot identity in your repo.

You can inspect it under **GitHub → Settings → Developer settings → GitHub
Apps**, restrict it to other repos, or delete it at any time. Deleting it
locally is **Disconnect** (which forgets the key and cached tokens in this
browser); deleting it on GitHub is done in those settings — a browser page
can't authenticate as your GitHub account to do it for you.

The only thing that is ever *saved* is the optional connection file **you**
download: `dash-github-connection-<slug>.json`, downloaded by your browser and
never uploaded anywhere. Treat it like a password — it can write to the
repositories the app is installed on. If it leaks, delete the app on GitHub
(that revokes every copy of the key at once) and set up again.

Created before this feature existed? Nothing to migrate: **Download connection
file** appears for every app connection, including ones registered earlier, and
**Generate a private key** on the app's settings page always works as the
manual equivalent.

## Credentials in this browser

| Key (localStorage) | Contents |
| --- | --- |
| `dash-scratchpad` | the notes themselves (always, even with no GitHub) |
| `dash-scratchpad-gh-app-v2` | app id, slug, owner, **private key**, installation id, cached installation token + expiry, `connection_saved_at` (set when you download the connection file, so the reminder can retire), `adopted_at` (set when the connection came from Reconnect) |
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
- The connection file is the one exportable credential, and it exists only
  because you asked for it (downloaded to your device, never transmitted). It
  contains no OAuth secret, no installation token, and no repository access
  beyond what the app was installed on.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"GitHub setup needs the dashboard served over https://…"* | The manifest handshake needs a real http(s) origin. Use the hosted dashboard or `python3 -m http.server`; `file://` can't redirect back (use the token fallback there). |
| GitHub says the app name is taken | Change the name GitHub pre-fills on the "Create GitHub App" screen; any name works. |
| You created the app but closed the tab before the install screen | Reopen the dashboard, expand the panel, click **Install on a repository**. |
| *"Couldn't confirm the installation"* | Click **Re-check connection**. If the app was deleted on GitHub, **Disconnect** and set up again. |
| The panel asks for **Create GitHub App** again — with no error | This browser has no key for this address (new browser/device/port/preview link, or site data was cleared). Don't create another app: use **Already have the app? Reconnect** with your connection file, or the App ID + a key from **Generate a private key**. |
| *"GitHub rejected that App ID + private key"* | The ID and the key belong to different apps. Copy the App ID from the same page that generated the key. |
| *"GitHub doesn't know that app"* | The app was deleted in **Settings → Developer settings → GitHub Apps**. Set up a new one (this is the one case where you must). |
| *"That is a passphrase-protected key"* | Use **Generate a private key** on the app's page — that `.pem` has no passphrase. |
| Lost the connection file | GitHub can always mint a fresh key: app settings → **Generate a private key**, then Reconnect with the App ID. The old key stays valid until you delete it there. |
| Want to stop a browser having access | **Disconnect** forgets the key and cached tokens in this browser only. To revoke it for every device, delete the app on GitHub. |
| `Resource not accessible by integration` | The app isn't installed on that repository, or you removed **Contents: write**. Fix it in the app's installation settings. |
| *"couldn't create the `scratch` repo"* | The app lacks **Repository creation: write**. Grant it in the app's permissions and accept it on the installation, create `scratch` yourself and add it to the app, or `Disconnect → Set up GitHub saving`. Saving to another repo still works. |
| The repo dropdown has no `scratch` | It should always be there, marked *(default)*. If saving to it fails, add the repo to the app's installation and click **Re-check connection** — or click **Use scratch repo** to create it. |
| Notes keep landing in one file | The file path is fixed once you pick it — click **New dated file** for a fresh `notes-<date>-<time>.md`. |
| Notes land in a repo that isn't `scratch` | Only an explicit dropdown pick does that, and only for the session — reopen the panel and `scratch` is selected again. If `scratch` isn't listed, it will still be offered as *(default)*. |
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
tampered state being ignored, offline notes, the pasted-token fallback,
disconnect, and the reconnect kit (the downloaded file's contents, adopting an
app from that file, the App ID + key path, and a mismatched pair being refused
without touching a working connection).

`docs/scratchpad-pwa-reconnect.test.js` drives the standalone Scratchpad PWA
page in jsdom: the reconnect panel being offered on a first visit, adopting an
app from an App ID + private key, the installation being picked up, and the
connection file download that retires the "keep a copy" reminder. The pure
formatting/parsing helpers are unit-tested in `tests/scratchpad-pwa.test.mjs`.

```sh
npm install jsdom
node docs/scratchpad-github-sync.test.js
node docs/scratchpad-pwa-reconnect.test.js
```
