# Why "Create GitHub App" keeps coming back — and the options

_Status: **Option 1 (reconnect kit) is implemented** — see
[`scratchpad-github-saving.md#reconnecting-without-creating-another-app`](scratchpad-github-saving.md#reconnecting-without-creating-another-app).
Options 2–4 are not built yet; this file is kept as the decision record._

## The mechanism (why it happens at all)

Today's flow registers a **private GitHub App owned by you** through the
app-from-manifest handshake. GitHub hands the page the app's **ID + private
key** exactly once, and that key *is* the credential. There is no server in
this project, so the key can only live in **this browser, on this exact
address** (`localStorage` + IndexedDB, key `dash-scratchpad-gh-app-v2`).

So the app keeps existing on GitHub forever, but the page's ability to *prove*
it is that app lives in one storage bucket. Lose the bucket and the panel has
nothing to show except "Set up GitHub saving" → GitHub's "Create GitHub App"
screen. Because app names are unique per account, it also forces you to invent
a new name every round.

Storage is scoped to **scheme + host + port**, and it is disposable:

| What wipes it | Looks like |
| --- | --- |
| A different address (new sandbox/preview subdomain, a new `localhost:PORT`, `127.0.0.1` vs `localhost`, `http` vs `https`, a `file://` copy) | Empty panel, no app, no notes-in-IndexedDB |
| Different browser / profile / device, private window | Same |
| "Clear cookies and site data", a storage/cleanup extension, ITP-style purge (iOS Safari drops script-writable storage after ~7 days without a visit unless the site is added to the Home Screen) | Same, plus the dashboard's other settings are also back to defaults |
| Storage eviction under disk pressure (mitigated by `navigator.storage.persist()`, already requested) | Same |

That is the whole story: **the credential is not portable, so every new
storage bucket is a new app.** Nothing is wrong with the app you made — it is
sitting in GitHub → Settings → Developer settings → GitHub Apps, unused.

## Options

### Option 1 — Reconnect kit ("connect an existing app", never create one again) — **shipped**

- **At setup:** the panel offers **Download connection file**
  (`dash-github-connection.json` — app id, slug, owner, private key).
- **On recovery:** a new **"I already have the app — reconnect"** section accepts
  that file (drag/drop) *or* two fields: **App ID** + **private key**, which
  GitHub lets you mint any time from your app's page (**Generate a private key**
  → downloads a `.pem`). The panel signs a JWT with it, lists installations,
  and you're back — **no app creation**.
- **Pros:** no new infrastructure, no third-party in the trust path, works
  offline, keeps the least-privilege app model, ~1 drag or 2 pastes to recover.
- **Cons:** still a manual step after a wipe; only helps if you kept the file
  (or can click *Generate a private key*).
- **Effort:** small–medium (both surfaces: `assets/github-app.js` + the inline
  GitHub block in `index.html`).
- **As shipped:** the panel offers **Download connection file** (and keeps a
  "keep a copy" reminder until one is saved) and an **Already have the app?
  Reconnect** section that takes the file, or `App ID` + `.pem`. The pair is
  verified with `GET /app` before anything is stored, so a bad ID can't clobber
  a working connection. Implemented in `assets/github-app.js`
  (`adoptApp`, `connectionFileFor`, `parseConnectionInput`,
  `markConnectionSaved`) and mirrored in the dashboard's inline block; covered by
  `docs/scratchpad-github-sync.test.js`, `docs/scratchpad-pwa-reconnect.test.js`
  and `tests/scratchpad-pwa.test.mjs`.

### Option 2 — One shared app + a tiny relay (true one-click, forever)

- Register **one** GitHub App owned by the project (once, by you), and deploy a
  ~60-line **Cloudflare Worker** (free tier) that does the one thing a static
  page can't: exchange the OAuth `code` for a user token while holding the
  `client_secret`. The page then shows a single **Connect GitHub** button →
  GitHub's authorize screen → back to the dashboard, connected.
- **Pros:** zero app creation ever; reconnect after any wipe is **one click**;
  no PEM, no key files, no bot apps piling up; permissions stay narrow
  (Contents: write on selected repos).
- **Cons:** adds a hosted component to the trust path (the Worker sees one
  OAuth code exchange; the secret lives in its env, never in the repo); the
  free-tier service has to stay up — if it dies, GitHub saving stops (notes
  still autosave locally); the OAuth token still lives in the browser, so a
  wipe means one re-click, not nothing.
- **Effort:** medium — plus a one-time setup (register app, deploy Worker, put
  the client ID in the page). Device flow and the plain code exchange are
  **not** options from a static page: both GitHub endpoints are CORS-blocked,
  which is exactly what the Worker exists to solve.

### Option 3 — PAT-first with a prefilled creation link

- Make the pasted token the primary path. The button opens GitHub's token page
  **prefilled**: `github.com/settings/personal-access-tokens/new?name=dash+notes&contents=write&expires_in=none`,
  then you pick the repo and paste the token back.
- **Pros:** cheapest possible change, no infra, no app at all, and a
  fine-grained token can be scoped to a single repo and set to never expire.
- **Cons:** tokens are shown once — if the browser forgets and you didn't save
  it, you *create a token* instead of an app (same loop, cheaper); wider blast
  radius than a per-repo GitHub App installation;
  it's a copy/paste flow, not a button.
- **Effort:** small.

### Option 4 — Stop the amnesia (diagnose + harden persistence)

No new auth model; fix the loop instead:

1. **Explain it in the panel.** When there is no credential, say *why*:
   "No app key in this browser at `<origin>`. The key lives only here — it
   doesn't follow you to other addresses, browsers or private windows."
2. **Canonical-address guard.** Record the address the app was registered on
   (already partly stored in the manifest) and warn when the page is opened
   somewhere else — temporary preview/sandbox hosts, `file://`, a different
   port — with a link to the stable address (`https://aacareq.github.io/dash/`).
3. **iOS guidance.** Nudge "Add to Home Screen" on iOS, which exempts the
   origin from the ~7-day purge, instead of discovering it after the fact.
4. **Belt and braces on storage.** Keep the existing localStorage+IndexedDB
   dual write, keep `navigator.storage.persist()`, and add **Export/Import all
   settings** so the dashboard's other state comes back too.
5. **Reconnect without losing notes** — separate "forget the credential" from
   "delete my notes".

- **Pros:** small, honest, and if the cause is address churn (preview URLs,
  changing dev ports) it removes the trigger entirely.
- **Cons:** doesn't make the credential portable — if the bucket is genuinely
  gone, you still set up again (Options 1/2 are what shorten that).

## Comparison

| | Creates a GitHub App again? | Recovery after storage loss | New infra | Trust surface | Effort |
| --- | --- | --- | --- | --- | --- |
| Today | **yes, every time** | create app + install | none | browser → GitHub only | — |
| 1. Reconnect kit | **no** | drag key file / paste App ID + PEM | none | unchanged | S–M |
| 2. Shared app + relay | **no, ever** | **one click** | Worker (~60 lines) | + your Worker | M |
| 3. PAT-first | **no** | create a token + paste | none | PAT in browser | S |
| 4. Diagnose + harden | yes (but rarer) | same as today, with an explanation | none | unchanged | S |

## Recommendation

**Ship 4 + 1 now, add 2 later if you want it to be one click forever.**

4 makes it obvious when and why storage was lost (and prevents it if the cause
is a changing address); 1 turns every recovery into a file drop or two pastes
with **no new app**, which is the thing you actually asked to stop. Both are
dependency-free and keep the current security story intact. Option 2 is the
only design that is genuinely one click, but it trades a free-tier hosted
component and a one-time Worker deploy for that — worth doing once 1 and 4
have made the current flow bearable.

## Notes for implementation

- The GitHub logic exists **twice**: `assets/github-app.js` (Scratchpad PWA)
  and the inline `GH`/`gh…` block in `index.html` (dashboard dialog, ~720
  lines). Any option must land in both, or the inline block should be reduced
  to a thin wrapper over the shared module — worth deciding before starting
  Option 1 or 2.
- Storage keys are shared through `assets/notes-store.js`
  (`LEGACY_KEYS` / `withLocalStorageMirror`), so a new `…-connection` artifact
  should follow the same mirroring rules.
- Tests to extend: `docs/scratchpad-github-sync.test.js` (jsdom + stubbed
  GitHub) — add cases for key import/verification and for the "no credential
  here" explanation.
