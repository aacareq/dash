# dash — Command Center 2026

A personal, single-page dashboard for AI chat, inference services, coding
agents and everyday tools — with search, favorites, recently launched items,
custom tools, config import/export, a dark/light theme, one-click
bookmarklets that launch whole workflows, and a calendar-aware seasonal
particle layer for a bit of delight.

**Live dashboard:** https://aacareq.github.io/dash/

## Use it

Open the live link above, or open `index.html` locally in a browser. No build
step and no dependencies — everything is plain HTML, CSS and JavaScript.

- **Search** filters every card; section search boxes support query templates.
- **Favorites** are pinned with the star button, saved in `localStorage`, and
  also have their own menu entry (★ Favorites) alongside the full cluster list.
  The **Scratchpad / Quick Notes** card is permanently pinned as the very first
  Favorites card (ahead of the pinned bookmarklets and your saved list, on both
  the home view and the ★ Favorites menu view), so the notes pad is always one
  click away — it opens the same scratchpad dialog as the Working On cluster.
  **Gemini** and **Claude** are ensured favorites: fresh browsers get them from
  the defaults, and a browser whose saved list doesn't have them gets them
  added once as ordinary starred favorites (never duplicated, and a deliberate
  un-star afterwards sticks).
- **Custom Tools** lets you add your own links; export/import your config from
  the dashboard to move it between browsers.
- **Bookmarklets** — its own menu cluster (dashed cards, e.g. *GitHub + Arena
  Agent*, *Coding Agents*, *GitHub + Arena AI + Proton VPN*, and
  *Personal AI Agents — Always-On*) can be clicked
  to run, or dragged onto your bookmarks bar. Allow pop-ups the first time so
  every tab can open. The same cards are also pinned in Favorites, right after
  the Scratchpad.
- **Personal AI Agents — Always-On** — a menu cluster for standing agent
  sessions you keep checking back into (Muse.ai, Grok Bot, Claude Code). Its
  matching bookmarklet (in Bookmarklets and pinned in Favorites) opens every
  link in the cluster at once, and is built from the cluster's own list so the
  two can never drift apart.
- **Working On** (4th in the menu, right after Daily Core) — in-dashboard
  tools that open as wide dialogs instead of navigating away: a Google Tasks
  list, a GitHub-backed work list that can create **and edit** files in a
  chosen repo, a Google Calendar mini agenda, a Pomodoro/focus timer, an
  exportable scratchpad, a multi-item clipboard, and a multi-source
  news/headlines feed. The Google
  Tasks, GitHub, and Google Calendar tools need a token pasted in (kept only
  in this browser's `localStorage`) since the dashboard has no backend of its
  own. The GitHub work list has a "Load Existing File" button that fetches a
  file's current content and version (SHA) from a chosen repo/path into the
  editor; saving then updates that same file in place (via the GitHub
  Contents API's `sha` field) instead of only ever being able to create new
  files. Changing the repo or path after loading a file resets it back to
  "create" mode, so a slip of the keyboard can't accidentally overwrite the
  wrong file. It also stays in sync with GitHub: a "Check for Updates" button
  compares the loaded file's version against what's currently on GitHub
  without touching the editor, and every save re-checks GitHub first — if the
  file changed since it was loaded (someone else edited it, or you edited it
  from another tab/device), the save is paused with a clear warning instead
  of silently overwriting that change, and you either reload the latest
  version or explicitly click "Overwrite Anyway" to confirm pushing your
  edits over it. The **Scratchpad** is the exception: its *Save these notes to GitHub*
  panel needs nothing copied from GitHub. One click has GitHub register a
  private GitHub App owned by you (via GitHub's app-manifest flow, which hands
  the page the app's key through a CORS-enabled endpoint), one install screen
  scopes it to a repo, and from then on the page signs its own short-lived app
  JWTs to mint one-hour installation tokens — so returning visitors never sign
  in again, and no long-lived credential is ever stored. Notes are committed
  in place via the Contents API, pause with a warning instead of overwriting a
  version that changed on GitHub (offering *Pull latest* or *Overwrite
  anyway*), and can autosave a few seconds after you stop typing. A private
  repo called **`scratch`** is the default save target — offered and selected
  even when GitHub's repo listing omits it, and created automatically when it
  doesn't exist — and each note gets its own **`notes-YYYY-MM-DD-HHMM.md`** file (with a
  *New dated file* button for another). Because the notes are markdown, the
  editor carries markdown tools — bold/italic/strikethrough, H1–H3,
  bulleted/numbered/task lists, quotes and dividers (with keyboard shortcuts
  and Ctrl/⌘+B/I/X), a searchable **emoji picker**, a header bar showing the
  target `repo / file.md` and the last save, and a live **preview** whose task
  checkboxes tick the underlying `- [ ]` lines. The whole tool reflows for small screens: preview
  under the editor on tablets, and a full-height sheet with 36px tap targets
  on phones. A pasted token remains available as a fallback for `file://`
  pages. How it works:
  [`docs/scratchpad-github-saving.md`](docs/scratchpad-github-saving.md).
- **Clipboard History** — a clipboard that remembers more than one thing: it
  keeps a list of captured clips (pasted into the dialog, copied on the page, or
  read from the system clipboard with **Capture clipboard**), lets you pin,
  copy back and delete items, and saves the whole collection to
  `clips/clips-<date-time>.md` in the same **scratch** repo as the notes — no
  second setup. It also spells out the browser's limits: there is no
  clipboard-change event and no background read, so it can't watch what you copy
  in other apps; Safari/Firefox may block programmatic reads (pasting always
  works). See [`docs/clipboard-history.md`](docs/clipboard-history.md).
- **News / headlines feed** — tabs for Techmeme, Hacker News, Ars Technica,
  InfoWorld, and Lobste.rs. None of the plain-RSS sources (everything except
  Hacker News, which has its own CORS-enabled API) have a CORS header of
  their own, so their headlines go through a shared chain of free, no-signup
  CORS proxies (`rss2json` → `allorigins.win` → `proxy.cors.dev` →
  `cors.lol`), trying each in turn and showing progress ("trying source 2 of
  4") while it does. Free proxies occasionally disappear or add a paywall —
  if every one in the chain fails, the dashboard shows the last successfully
  loaded headlines for that feed from `localStorage` (clearly labeled as
  cached) instead of an empty modal, and only falls back to a plain "open the
  site directly" link if there's no cache yet either.
- **Seasonal layer** — a full-screen, click-through canvas drifts leaves,
  snow, blossom, or fireflies behind the dashboard depending on today's month.
  Move your pointer to stir a gust, click/tap to burst particles, and toggle
  it from the header's 🍂 Season button or the `S` key — your choice is
  remembered in `localStorage`. It's automatically skipped if your system
  requests reduced motion. The sidebar also gets a matching seasonal greeting
  and a small garland accent under the brand.

## Scratchpad PWA

[`scratchpad.html`](scratchpad.html) is the installable, offline-first version
of the dashboard's Scratchpad. Open it and use **Install app** (or Share → Add
to Home Screen on iOS) to run it in its own window.

- **Installable PWA** — [`manifest.webmanifest`](manifest.webmanifest) with
  192/512 px and maskable icons (generated by `scripts/generate-icons.mjs`),
  standalone display, a "New note" shortcut, and an iOS hint where the browser
  has no install prompt.
- **Offline-first** — [`sw.js`](sw.js) precaches the whole app shell; the
  editor opens and saves with no network. Authenticated GitHub traffic is never
  cached. A new deploy shows an update toast instead of interrupting a note.
- **IndexedDB storage** — notes, settings and the GitHub App record live in
  async IndexedDB stores (`assets/notes-store.js`), replacing the synchronous
  localStorage string; first launch migrates the existing
  `dash-scratchpad-*` localStorage data, including an already-registered GitHub
  App, so nothing is lost. A memory adapter keeps the app working where
  IndexedDB is unavailable.
- **Offline commit outbox** — saves made while disconnected queue locally and
  flush automatically on reconnect/focus (or via **Sync now**), with the same
  conflict protection (Pull latest / Overwrite anyway) as the online path. The
  queue logic lives in the DOM-free, unit-tested `assets/sync-engine.js`.
- **Same GitHub flow** — the zero-config GitHub App registration, self-signed
  RS256 JWTs and one-hour installation tokens are ported unchanged into
  `assets/github-app.js`; the PAT fallback remains for `file://` use.
- **Worker-rendered markdown preview** — note rendering runs in
  `assets/markdown-worker.js` off the main thread, with output verified
  byte-identical to the dashboard dialog's renderer.
- **File access** — File System Access save/open on Chromium desktop, with
  download/upload fallbacks elsewhere.

The dashboard's Scratchpad dialog now has an **Open app ↗** link to this page;
the dialog itself is unchanged.

### Using the app from inside the dashboard

- **Install button in the dashboard header** — `index.html` links the same
  web app manifest and registers the same service worker, so the
  **📲 Install Scratchpad** button appears on the dashboard itself whenever
  the browser offers installation (iOS shows an Add-to-Home-Screen hint
  instead).
- **Two views in the Scratchpad dialog** — a toggle at the top switches
  between *Quick notes (this page)*, the original inline pad, and
  *App view (offline)*, which embeds `scratchpad.html?embed=1` in a
  lazy-loaded same-origin iframe. The iframe shares the origin's IndexedDB,
  GitHub App registration and service worker, so notes and sync are the same
  in both surfaces. The iframe only loads on first switch, and the dialog
  reopens on the inline view. The one-time GitHub App setup opens in a new
  top-level tab because GitHub refuses to render its install screens inside
  an iframe; everything after setup works embedded.
- The service worker now precaches the dashboard shell as well, so the
  dashboard itself opens offline once cached.

## Layout

- `index.html` — the current dashboard (Command Center 2026)
- `scratchpad.html`, `manifest.webmanifest`, `sw.js` — the installable
  Scratchpad PWA, its manifest and service worker
- `assets/` — the PWA's ES modules (`editor`, `markdown`, `emoji`,
  `notes-store`, `github-app`, `sync-engine`, `markdown-worker`), stylesheet
  and generated icons
- `scripts/` — dependency-free build helpers (icon generator)
- `tests/` — Node test-runner suites for the PWA modules
  (`node --test tests/scratchpad-pwa.test.mjs`)
- `inference.html`, `zerocost.html`, `feeds.html` — the standalone topic pages
  linked from the current dashboard
- `archive/` — the 11 superseded dashboard versions, each kept exactly where
  it can be found (see `archive/README.md` for the list); there are no
  duplicate copies of these left in the repo root
  - `archive/standalone/` — older standalone topic pages (agents, coding,
    hosting, images, music, search, video and related) no longer linked from
    the dashboard; see `archive/standalone/README.md`
- `docs/` — design notes and the jsdom behavior tests for the dashboard
- Analysis docs: [`dashboard-improvements-102726.md`](dashboard-improvements-102726.md)
  (adversarial review of workflows, performance and redundancy) and
  [`scratch-pad-app.md`](scratch-pad-app.md) (the PWA/offline research this
  implementation follows)

## Tests

`npm install` once, then `npm test` — it runs the Node test-runner PWA suite
(`tests/`, no browser needed) and the four jsdom behavior suites for the
dashboard dialogs (`docs/*.test.js`).

Unreferenced legacy pages (the old `Inf-*`, `infer-*`, `0824-*`, `con-*`
generations and the `tools/` directory) were removed in the 2026-10-27 cleanup;
they remain available in the repository's git history.

## Contributing / changes

Edit the file you want to change and open a pull request against `main`.
A weekly link-check workflow is provided in `docs/link-check-workflow.yml` — move it to
`.github/workflows/link-check.yml` to enable it (adding workflow files via an app needs
GitHub's separate workflows permission).

## License

MIT — see `LICENSE`.
