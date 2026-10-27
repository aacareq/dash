# Dashboard — Adversarial Analysis & Improvement Plan

**Date:** 2026-10-27
**Scope:** the live dashboard (`index.html`, "Command Center 2026" / CommandOS-v1.5) and the
repository around it. This is an *adversarial* review: it assumes nothing is fine until
proven otherwise, and ranks findings by user-visible impact.

**Baseline facts established during the review**

- The entire application is one file: `index.html` is **4,994 lines / ~300 KB**, containing
  ~619 lines of inline CSS (`index.html:9-627`) and ~3,935 lines of inline JS
  (`index.html:1057-4992`). No build step, no external assets, no dependencies.
- It renders **~128 cards across 19 clusters** plus **8 `<dialog>` modals**
  (`index.html:690-1055`) on every load.
- It holds **173 unique external URLs** — a large link-rot surface — and the link-check
  workflow that could catch rot is **not enabled** (it sits in `docs/link-check-workflow.yml`;
  there is no `.github/workflows/` directory).
- All four jsdom test suites in `docs/` currently pass (verified 2026-10-27), but there is
  **no `package.json`**, so the `jsdom` dependency is undeclared and nothing runs them
  automatically.
- A static reachability scan (every `.html` filename reference in the repo) shows the live
  dashboard can only reach **four HTML pages**: `index.html`, `inference.html`,
  `zerocost.html`, `feeds.html`, plus the intentionally linked
  `archive/index-previous.html`. Everything else in the repo root and `tools/` is
  unreachable from the running product.

---

## 1. Streamlining workflows

### W1 — Three different credential stories for what is effectively one GitHub backend
The GitHub Work tool requires a manually created personal access token
(`initGithubWorkTool`, `index.html:2430-2436`, key `dash-github-token`), while the
Scratchpad and Clipboard use the zero-config GitHub App flow
(`GH` config at `index.html:2772-2781`; manifest flow at `index.html:3854+`). Google Tasks
and Google Calendar share a token pasted from the OAuth playground
(`dash-google-token`, `index.html:2357`, `2639`).

**Friction:** a new user must understand PAT scopes, create a token, and re-paste it when it
expires — for a tool sitting next to another tool that already solved one-click auth.
**Recommendation:**
1. Migrate the GitHub Work tool onto the existing GitHub App installation-token path
   (reuse `ghAuthorizedFetch`, `index.html:2995`) and delete the PAT input. The app manifest
   already requests Contents write, which is all the Work tool needs.
2. For Google, replace the playground-token instruction with Google Identity Services
   (`gsi/client` token model) or document a fixed refresh path; at minimum, surface token
   expiry inline instead of failing inside a fetch.
3. Consolidate the four token inputs in the UI into one "Connections" dialog with status
   badges (connected / expired / not set up).

### W2 — Starring a card rebuilds the entire dashboard
`toggleFavorite()` calls `renderDashboard()` + `applyFilters()` on every click
(`index.html:1753-1757`), and `renderDashboard()` does `feed.replaceChildren()` and
recreates every card from scratch (`index.html:2085-2133`).

**Friction:** every star click throws away all open `<details>` panels, scroll position,
and focus, and re-runs card construction for ~128 cards the user isn't looking at. It feels
janky and is disorienting for keyboard users.
**Recommendation:** make favorite state a class toggle on the existing card element
(`card.classList.toggle("is-favorite")`) plus an update of the Favorites count; only
rebuild the Favorites *cluster* when it is the active view. The same applies to adding a
custom tool (`index.html:2316-2320`) — insert one card instead of rebuilding everything.

### W3 — No keyboard path to the tools people use most
Global shortcuts cover only `/` (search), `Esc`, and `S` (seasonal layer)
(`index.html:2240-2250`, `4977-4982`). The Scratchpad is "one click away" but never one
keystroke away; there is no shortcut for any Working On dialog.
**Recommendation:** add a small shortcut map, e.g. `Ctrl/Cmd+Alt+N` → Scratchpad,
`Ctrl/Cmd+Alt+T` → Tasks, `Ctrl/Cmd+Alt+F` → focus search, and list them in a `?` overlay.
All dialogs already use native `showModal()` (`index.html:2333-2336`), so focus trapping
and `Esc` come for free.

### W4 — News feed can make the user wait up to ~28 seconds
RSS feeds try four CORS proxies **sequentially**, each with a 7-second timeout
(`fetchWithTimeout` + `loadRssFeed`, `index.html:4572-4660`). If the first three proxies
hang, the user stares at "trying source 4 of 4" for ~21-28 s before the cached fallback
appears.
**Recommendation:**
- Race providers with `Promise.any`-style hedging (fire two at a time, fall through on
  failure) instead of a strict serial chain, and cut the per-proxy timeout to ~4 s.
- Show the localStorage cache immediately (labeled "stale") while the live fetch runs,
  rather than only after every provider fails.
- Consider one self-hosted proxy (Cloudflare Worker / GitHub Actions-generated JSON) to
  retire dependence on four free services that the code comments themselves note "come and
  go" (`index.html:4610-4613`).

### W5 — Sidebar navigation has grown past scan-ability
There are 21 sidebar buttons (`index.html:645-665`) for 19 clusters, including a Custom
Tools cluster that renders empty until the user adds something
(`items: []`, `index.html:1429`). The cluster names also drift from the README vocabulary
("Vibe Dev" vs "Vibe Coding & Prototyping", "Free Tier Ops" vs "Generous Infrastructure
Free Tiers").
**Recommendation:** group clusters into collapsible sections (Daily / Tools / Reference),
hide empty clusters until populated, and make the nav labels the single source of truth
that the README is generated from (or vice-versa).

### W6 — Bookmarklets are a fragile workflow primitive
The "open N tabs at once" bookmarklets (`index.html:1071-1130`) depend on popup
permission, are silently blocked in some embedded browsers, and can't be triggered from
the installed-app / PWA context the scratchpad doc proposes.
**Recommendation:** keep them, but add an in-page "Open session" button that uses the same
shared `personalAgentItems` / `bookmarkletItems` arrays (the single-source pattern already
used at `index.html:1064-1071`) so the workflow works without a bookmarks bar at all.

### W7 — Import/export is a manual JSON file ritual
Config portability means exporting a file, moving it, importing it elsewhere
(`exportConfig`/`importConfig`, `index.html:1553-1594`). The repo already has a
authenticated GitHub client in the page.
**Recommendation:** offer "back up config to your `scratch` repo" (a single small JSON file
via the existing Contents API path) alongside the file download. This also gives
cross-device sync with no new infrastructure.

---

## 2. Performance

### P1 — One monolithic, uncacheable, unminified 300 KB payload
CSS and JS are inline, so *any* edit — even fixing a typo in a card description —
invalidates the entire payload. There is no way for the browser to cache styles or logic
independently of markup, and nothing is minified.
**Recommendation (preserving the no-build philosophy where possible):**
- Split into `assets/styles.css`, `assets/app.js`, `assets/data.js` (the card database,
  `index.html:1133-1468`, is pure data and a natural first extraction). Plain ES modules
  need no bundler.
- Let GitHub Pages' default caching hold the static assets; add hash suffixes only if a
  minimal build (esbuild/terser, one npm script) is later accepted.
- Expected effect: the dashboard shell becomes cacheable across content edits, and the
  initial parse cost drops because modules can be `defer`red.

### P2 — All seven tool modules are initialized on every visit, used on almost none
`initWorkingOnTools()` eagerly runs seven initializers
(`index.html:4742-4751`, invoked at `4989`), each querying hidden DOM and attaching
listeners inside dialogs the user may never open. The news feed is the one bright spot: it
defers fetching with a `MutationObserver` on the dialog (`index.html:4727-4738`).
**Recommendation:** generalize that pattern — initialize each tool lazily on its first
`open` event (`dialog.addEventListener("open", …)` / `showModal` wrapper). The JWT/PKCS
cryptography for GitHub App auth (`index.html:2883-3026`) is an especially good lazy-load
candidate via dynamic `import()`.

### P3 — All 128 cards for all 19 clusters exist in the DOM at once
Even when a single cluster is selected, every section is rendered up front
(`renderDashboard` loops the whole `database`, `index.html:2092-2129`) and hidden with
classes. Initial render creates hundreds of nodes; `applyFilters` then walks them all.
**Recommendation:** render the active cluster on demand (the data is already in memory),
or render the home view first and `requestIdleCallback` the rest. Keep the markup stable
so the existing jsdom tests need only small selectors updates.

### P4 — Search filtering is O(all cards) on every keystroke, undebounced
The global search input calls `applyFilters()` directly on every `input` event
(`index.html:2234-2235`), and `applyFilters` iterates every section and every card twice
(home sections + dashboard sections, `index.html:2136-2163`), toggling classes on each.
**Recommendation:** debounce (~80-120 ms) or use `requestAnimationFrame` coalescing;
precompute a lowercase search string per card at render time (the `data-search` attribute
already exists — extend it rather than re-reading `dataset` each pass); early-out when the
query hasn't changed.

### P5 — The seasonal particle canvas runs a perpetual rAF loop with expensive paints
When enabled, `requestAnimationFrame(step)` redraws a full-viewport canvas forever
(`index.html:4884-4923`), including `shadowBlur` glow for fireflies
(`index.html:4876-4880`) — one of the most expensive canvas operations — with up to 260
particles (`index.html:4851`). It honors `prefers-reduced-motion` (good), but has no
visibility/energy budget otherwise.
**Recommendation:**
- Pause the loop when the document is hidden (`visibilitychange`) and when the canvas is
  off-screen; rAF already pauses in background tabs, but an explicit gate avoids work on
  foreground tab switches.
- Drop `shadowBlur` for a radial-gradient sprite drawn once to an offscreen canvas and
  `drawImage`'d per particle — typically a large frame-time win.
- Cap devicePixelRatio at 2 and consider reducing particle counts on small screens.

### P6 — Two full GitHub integrations ship twice the code and failure surface
The Work tool and the Scratchpad each implement Contents-API URL building, UTF-8 base64,
SHA conflict handling, and save flows independently. The base64 helpers are literally
duplicated verbatim:
`encodeUtf8Base64`/`decodeUtf8Base64` (`index.html:2436-2437`) and
`ghEncodeBase64`/`ghDecodeBase64` (`index.html:2794-2795`). `contentsUrl` is likewise
implemented twice (`index.html:2451` and `3721`).
**Recommendation:** extract one `github-contents.js` module (read, write, conflict
detection, base64) used by both tools; see R2.

### P7 — Preview and storage work on the typing path
The markdown preview re-renders the **entire** preview via `innerHTML` on every input
(debounced 180 ms, `index.html:3336-3340`), and the scratchpad writes localStorage
synchronously on every input debounce (`index.html:3395-3400`). Fine for short notes;
degrading for long ones.
**Recommendation:** move markdown rendering to a Web Worker (or `requestIdleCallback`),
skip re-render when text is unchanged, and move note bodies to async IndexedDB storage
(detailed in `scratch-pad-app.md`). localStorage writes block the main thread and share a
~5 MB origin quota with all the other keys.

### P8 — No performance measurement exists
There are no Lighthouse budgets, no Performance Observer usage, no recorded baselines, and
no CI. Every claim above about cost is currently unmeasured in production.
**Recommendation:** add a Lighthouse CI step (or a manual budget documented in the README):
targets such as TBT < 200 ms, no long tasks > 50 ms during typing, and a < 150 KB cached
shell after the P1 split.

---

## 3. Redundancy and keeping track of what is not being used

### R1 — 35 HTML files are unreachable from the live product (~572 KB)
The reference graph below was built by scanning every filename reference in every HTML,
MD, and JS file. "Inbound from live" means reachable starting at `index.html` and following
internal links.

| Group | Files | Inbound references | Verdict |
| --- | --- | --- | --- |
| Live pages | `index.html`, `inference.html`, `zerocost.html`, `feeds.html` | dashboard links | **keep** |
| Linked archive | `archive/index-previous.html` | "Previous dashboard" link (`index.html:664`) | **keep** |
| `tools/` (5 files) | `xai-to.html`, `xai-tool-1.html`, `xt-1001.html`, `xt-1002.html`, `xt-1003.html` | **none — not referenced by any file in the repo** | **delete** |
| Dated/versioned legacy inference pages (19 files) | `0824-001-inference.html`, `0824-01-inference-examples.html`, `Inf-1001.html` … `Inf-1009.html`, `infer-001.html` … `infer-006.html`, `infer.html`, `infer-ext.html` | only archived dashboards (`archive/index*.html`) and each other | superseded by `inference.html` ("AI Intelligence Dashboard 2026") |
| Legacy topic pages (11 files) | `agents.html`, `coding.html`, `coding-sec.html`, `con-1.html`, `con-2.html`, `hosting.html`, `images.html`, `music.html`, `search.html`, `video.html`, `video-ext.html` | only archived dashboards; each links *back* to `index.html` | their topics now exist as clusters/dialogs inside the dashboard |

The five `tools/` files are an obvious version graveyard (`xai-to` → `xai-tool-1` →
`xt-1001` → `xt-1002` → `xt-1003`). The root contains at least three parallel generations
of inference page (`Inf-*` July 2025, `infer-*`, and the current `inference.html`).
**Action:** this PR deletes the provably-dead material; see the cleanup section of the PR
description. Anything uncertain should move into `archive/` rather than stay in the root,
because the root currently presents no way to tell live pages from dead ones.

### R2 — Duplicated code inside `index.html`
- Two identical UTF-8 base64 pairs (P6 above; `index.html:2436-2437` vs `2794-2795`).
- Two Contents-API URL builders (`index.html:2451`, `3721`) and two SHA-conflict state
  machines (`pendingOverwriteSha` at `2446+` vs the scratchpad's `rememberSha`/overwrite
  flow at `3513-3524`).
- Two token-storage conventions: `dash-*` keys and `commandos-*` keys, with ad-hoc version
  suffixes (`-v1`, `-v2`) and no migration layer.
- The news reader is implemented **twice in the repo**: the modal in `index.html`
  (`initNewsFeedTool`, `index.html:4569+`) and the standalone `feeds.html` — same five
  feeds, same four-proxy chain, same XML parsing. When a proxy dies, two files need the
  fix. Extract one `news-feeds.js` shared by both, or make `feeds.html` a thin shell over
  the shared module.
- Every standalone page ships its own inline `<style>` block (e.g. 364 lines in
  `feeds.html`, 172 in `hosting.html`) restating the design system instead of sharing one
  stylesheet.

### R3 — `archive/` is intentionally retained but internally untracked
The archive README (`archive/README.md`) documents eleven snapshots archived 2026-10-20,
so they should not be deleted casually. However, six of the eleven have **no inbound link
from anywhere, including other archive files**: `index-1.html`, `index-old-001.html`,
`index-test-001.html`, `index3.html`, `index4.html`, `index5.html`.
**Recommendation:** keep them (documented intent), but add a "review on" date to
`archive/README.md` and a policy: snapshots older than two releases either get tagged in
git and deleted, or move to a separate `dash-archive` repo. Git history already preserves
everything, which is the argument against keeping frozen copies in the working tree at
all.

### R4 — Tests exist but are invisible to tooling
Four test files (`docs/*.test.js`) encode real behavioral coverage — favorites pinning,
GitHub sync conflict handling, clipboard, bookmarklets — but:
- there is no `package.json`, so `jsdom` is an undeclared dependency installed by hand;
- there is no `npm test` and no CI workflow running them;
- they live in `docs/` alongside prose, so contributors don't expect them.

**Recommendation:** add a minimal `package.json` (`devDependencies: jsdom`,
`"test": "node docs/…test.js` glob), move tests to `tests/`, and add a GitHub Actions
workflow that runs them on every PR. The link-check workflow should be activated in the
same change (move `docs/link-check-workflow.yml` to `.github/workflows/link-check.yml`,
which its own header already instructs).

### R5 — localStorage sprawl with no inventory or schema
There are ~20 keys across two naming prefixes (`commandos-*`, `dash-*`, plus the
`dash-scratchpad-gh-*` family listed at `index.html:2773-2780` and clipboard family at
`4138-4143`). Nothing documents which keys exist, their versions, or who may delete them.
**Recommendation:**
1. Define one `STORAGE_KEYS` registry (the `GH.keys`/`CLIPBOARD.keys` pattern already in
   use — generalize it) and reference keys only through it.
2. Add a "Storage" panel to the Connections dialog showing per-key size and a "reset"
   button — this directly answers "keeping track of what is not being used" at runtime.
3. Adopt one prefix (`dash.*`) with explicit schema versions and a tiny migration table.

### R6 — Smaller hygiene items
- Branding is inconsistent across surfaces: `<title>` says "Command Center 2026"
  (`index.html:7`), the sidebar says "CommandOS-v1.5" (`index.html:638`), the archived
  link says v1.3, the README says "Command Center 2026". Pick one name/version scheme.
- `.gitignore` lacks `node_modules/`, `lychee/`, and typical editor entries — adding the
  test tooling from R4 will otherwise risk committing `node_modules`.
- No fully dead JavaScript functions were found (a static "defined but never referenced"
  scan came back clean) — credit where due; the redundancy is duplicated *logic*, not
  orphaned functions.

---

## Recommended sequencing

| Phase | Items | Theme |
| --- | --- | --- |
| 1 (this PR) | R1 cleanup, `.gitignore` hardening, README/layout updates | delete unused, shrink clutter |
| 2 | W2, P4, R4 (package.json + CI tests), enable link checker | high-frequency UX wins with test protection |
| 3 | W1 + P6 + R2 (one GitHub module, one news module, one stylesheet) | kill duplication |
| 4 | P1-P3 (split/extract modules, lazy tool init, on-demand render) | structural performance |
| 5 | P5, P8, R5, W3, W7 | energy, observability, storage discipline |
| Parallel track | see `scratch-pad-app.md` | PWA packaging for the Scratchpad |
