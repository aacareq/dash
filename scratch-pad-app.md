# Scratchpad → Installable PWA: Research & Plan

**Date:** 2026-10-27
**Goal:** (1) make the Scratchpad an installable PWA that runs in its own window, fully
offline, and can be packaged beyond the browser; (2) make it faster.

---

## Implementation status (updated 2026-10-27)

Phases 0-5 and most of the performance table below are now built, on the no-framework,
no-bundler stack the plan called for.

| Plan item | Shipped as |
| --- | --- |
| Phase 0 — standalone entry + extracted modules | `scratchpad.html` + `assets/` (`markdown`, `emoji`, `editor`, `github-app`, `notes-store`, `sync-engine`, `markdown-worker`, `styles.css`); the dashboard dialog keeps working and gains an **Open app ↗** link |
| Phase 1 — web app manifest | `manifest.webmanifest` (192/512 + maskable icons, `standalone`, relative `/dash/` paths, "New note" shortcut); icons generated dependency-free by `scripts/generate-icons.mjs` |
| Phase 2 — service worker | `sw.js`: versioned precache of the shell, network-first navigations, cache-first assets, `updateViaCache: "none"`, update toast with a manual reload, and a hard rule that `api.github.com` is never cached |
| Phase 3 — IndexedDB + migration | `assets/notes-store.js` (`notes`/`kv`/`outbox` stores, MemoryStore fallback, one-time idempotent migration of the `dash-scratchpad-*` localStorage keys, `navigator.storage.persist()`) |
| Phase 4 — offline outbox | `assets/sync-engine.js`: offline saves queue and merge per file, flush on `online`/visibility/manual **Sync now**, conflict pauses; Background Sync deliberately not required (Chromium-only) |
| Phase 5 — install UX + file access | `beforeinstallprompt` install button, iOS Add-to-Home-Screen hint, File System Access save/open with download/upload fallback |
| S1-S5, S7-S9 (perf) | lazy standalone shell, worker-rendered preview with sequence-guarded messages, async storage, lazy emoji build, versioned cached assets, Lighthouse-ready manifest; `tests/scratchpad-pwa.test.mjs` (26 checks) plus a byte-level renderer-parity check against the dialog |
| Phase 6 — Bubblewrap TWA | **not built** — blocked on the origin-root `.well-known/assetlinks.json` decision (GitHub Pages subpath; see §7) |
| Phase 7 — Capacitor/iOS store | **not built** — deferred until an App Store presence is actually wanted |

The original research and full plan follow unchanged.

---

---

## 1. Where the Scratchpad stands today

Evidence from the current repo:

- It is **not a standalone app**. It is a `<dialog>` (`#modal-scratchpad`,
  `index.html:856`) embedded in the 300 KB / 4,994-line `index.html`, opened from a
  Favorites card or the Working On cluster (`openModal("modal-scratchpad")`,
  `index.html:3917`, `4104`, `4506`).
- Notes live in a single localStorage string, key `dash-scratchpad`
  (`index.html:3388`, `3395-3400`). localStorage is synchronous, string-only, and capped
  at roughly 5 MB **for the whole origin** — shared with ~20 other keys.
- GitHub sync is genuinely good: one-click GitHub App registration, self-signed RS256
  JWTs, one-hour installation tokens, conflict detection, autosave
  (`index.html:2766-3026`, `3430-4150`; design doc `docs/scratchpad-github-saving.md`).
  The app private key is stored in localStorage (`dash-scratchpad-gh-app-v2`).
- There is **no web app manifest, no service worker, no icons** (verified: no
  `manifest*`, `sw.js`, or `serviceWorker` registration exists).
- The site is served over HTTPS from GitHub Pages at a **project subpath**,
  `https://aacareq.github.io/dash/` — HTTPS is already satisfied, but every PWA path must
  be relative to `/dash/`.

Consequence: today the Scratchpad cannot be installed, has no offline guarantee beyond
the browser's heuristic HTTP cache, cannot run after the tab is closed, and cannot be put
in an app store. None of these are fundamental — all are addressed below without
abandoning the no-framework, no-build approach.

---

## 2. Target architecture

```
dash/
├── index.html                  # dashboard (unchanged role, slimmer after extraction)
├── scratchpad.html             # NEW: standalone PWA entry, own window when installed
├── manifest.webmanifest        # NEW: installability metadata
├── sw.js                       # NEW: app-shell cache, offline fallback, update flow
├── assets/
│   ├── styles.css              # shared design tokens (also used by index.html)
│   ├── scratchpad.js           # editor, markdown toolbar, emoji picker (ES module)
│   ├── markdown.js             # renderScratchpadMarkdown, extracted & worker-ready
│   ├── github-app.js           # JWT minting, installation tokens, Contents API
│   ├── notes-store.js          # IndexedDB notes + outbox (replaces localStorage body)
│   └── icons/                  # 192, 512, maskable SVG/PNG
└── docs/…
```

The Scratchpad becomes a real page (`scratchpad.html`) that the dashboard opens instead
of (or in addition to) the dialog, reusing the same modules. The dialog can remain as a
lightweight in-dashboard surface, but the PWA owns the standalone experience. This also
fixes dashboard finding P1/P2: the JWT/crypto and markdown code stop loading for every
dashboard visitor.

---

## 3. Phase 1 — Web App Manifest (installability)

Chromium browsers require a manifest with `name`/`short_name`, icons including **192 px
and 512 px**, an in-scope `start_url`, and `display` of `standalone`, `minimal-ui`, or
`fullscreen`, served over HTTPS [1][3]. Chrome relaxed the *service-worker fetch handler*
requirement for menu-based installation (Chrome 108 mobile / 112 desktop), but a service
worker remains necessary for offline use and for the richer automatic install prompt
[5][12], so Phase 2 is not optional for this use case.

```json
{
  "name": "Dash Scratchpad",
  "short_name": "Scratchpad",
  "description": "Offline-first markdown notes with GitHub sync.",
  "start_url": "./scratchpad.html",
  "scope": "./",
  "display": "standalone",
  "theme_color": "#0b0914",
  "background_color": "#0b0914",
  "icons": [
    { "src": "assets/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "assets/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "assets/icons/maskable-512.png", "sizes": "512x512",
      "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "New note", "url": "./scratchpad.html?new=1" }
  ]
}
```

Subpath notes specific to this repo:
- `start_url` and icon URLs are **relative** so they resolve under `/dash/`; an absolute
  `/scratchpad.html` would break on GitHub Pages.
- Link it from both pages: `<link rel="manifest" href="manifest.webmanifest">`.
- Validate in Chrome DevTools → Application → Manifest; a missing 512 px icon or an
  out-of-scope `start_url` silently suppresses the install prompt with no visible error
  [4].
- Safari never fires an install prompt: iOS users install via Share → **Add to Home
  Screen**; include an in-app hint gated on iOS [11]. `apple-touch-icon` and
  `apple-mobile-web-app-capable` meta tags are still worth adding for Safari.

---

## 4. Phase 2 — Service worker (offline shell + updates)

A small, hand-written `sw.js` fits the no-build philosophy. Register it from
`scratchpad.html` (and optionally `index.html`) with the default project scope:

```js
// scratchpad.html
if ("serviceWorker" in location.protocol.startsWith("http") ? navigator : {}) {
  navigator.serviceWorker.register(new URL("./sw.js", location.href));
}
```

Caching strategy:
- **App shell, cache-first with versioned cache names** — precache `scratchpad.html`,
  `assets/*.css`, `assets/*.js`, icons. Bump `CACHE = "dash-scratch-v2"` on change; on
  `install`, pre-cache; on `activate`, delete old caches.
- **Never cache authenticated traffic.** GitHub API responses, tokens, and the app PEM
  must never enter the Cache API. Route only same-origin GET requests through the cache;
  let `api.github.com` pass straight through.
- **Offline fallback:** a cached offline page for navigations; the editor itself stays
  fully usable because its shell is cached and notes live locally (Phase 3).
- **Updates without losing a note:** use `skipWaiting` + `clients.claim`, but surface a
  "New version ready — reload" toast instead of force-reloading, so an in-progress note
  is never interrupted.
- Add a `fetch` handler even though modern Chrome no longer requires one for
  installation — Firefox/Safari offline behavior and Lighthouse still expect it [12].

Service workers **cannot access localStorage**, only IndexedDB and the Cache API. This is
a hard constraint that drives the next phase: the GitHub App key and note bodies must
move to IndexedDB before any SW-based background work is possible.

---

## 5. Phase 3 — Storage: localStorage → IndexedDB (with OPFS as a future option)

localStorage is synchronous (blocks the main thread on every read/write), string-only,
limited to about 5 MB per origin, and unavailable in workers and service workers.
IndexedDB is asynchronous, stores structured data and blobs, scales to a large fraction
of available disk, and is usable from both the page and the service worker [9][17].

Proposed `notes-store.js` (tiny promise wrapper, no library):

- Object store `notes`: `{ id, title, body, updatedAt, githubPath, sha, dirty }` keyed by
  `id`; index on `updatedAt`.
- Object store `kv`: replacement for the settings/credential keys currently in
  localStorage (theme, GitHub App record, installation id, prefs).
- One-time migration on first launch of the new build: read the existing
  `dash-scratchpad` string and seed note #1; keep localStorage as a fallback until the
  migration is confirmed, so no notes are lost.
- `navigator.storage.persist()` request after install to prevent eviction under disk
  pressure.

For heavy multi-note use later, the **Origin Private File System (OPFS)** is supported
across all modern browsers (Chrome/Edge 102+, Firefox 111+, Safari 15.2/16.4) and offers
fast, worker-based synchronous file handles; it is overkill for a single textarea today
but is the natural home if the scratchpad grows into a multi-file note workspace [7][18].

---

## 6. Phase 4 — Offline writes: an outbox, not blind autosave

Today autosave commits directly to the GitHub Contents API
(`saveNotes`, `index.html:3742+`). Offline, that fails. Add a commit outbox:

1. On save, write the note to IndexedDB immediately (works offline, instant UI).
2. If a commit succeeds, clear the entry; if it fails (offline, 5xx, conflict), enqueue
   `{ repo, path, contentBase64, sha, attempts }` in an `outbox` store with `dirty: 1`.
3. Flush the queue on the `online` event, on app focus, and via a manual "Sync now"
   button with a visible pending count.
4. Keep the existing conflict UX (Pull latest / Overwrite anyway) — the outbox stores the
   base SHA, so the same sha-mismatch logic still applies when the queue drains.

Do **not** make Background Sync API the primary mechanism: as of 2026 it is Chromium-only
and remains unimplemented in Firefox and Safari [11][17]. Register a `sync` event when
available as a bonus, but rely on the universal `online`-event + manual flush path.

---

## 7. Phase 5 — Running outside the browser: four levels, pick by need

### Level A — Installed PWA (do this first; zero extra tooling)
Once Phases 1-2 ship, Chrome/Edge/Android install the app into its own standalone window
with a launcher icon; iOS uses Add to Home Screen. It runs offline, in its own task,
without browser chrome. This covers "runs outside the browser" for almost every personal
use case at zero maintenance cost.

### Level B — Google Play via Trusted Web Activity (Bubblewrap)
Google's official packaging wraps the hosted PWA in a Chrome-powered Trusted Web Activity;
the resulting app is roughly 800 KB and is accepted on Google Play, with web deployments
updating the app instantly [2][16].

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest=https://aacareq.github.io/dash/manifest.webmanifest
bubblewrap build
```

Two repo-specific gotchas:
- A TWA requires a service worker and a Digital Asset Link file at
  **`https://aacareq.github.io/.well-known/assetlinks.json`** — the origin root, not the
  `/dash/` subpath. A project repository cannot write there; it has to live in the
  special `aacareq/aacareq.github.io` repository (or a custom domain has to be added)
  [8].
- New Play apps and updates must target Android 16 (API 36) since August 31, 2026 — use a
  current Bubblewrap release [9].

### Level C — iOS App Store and cross-platform native via Capacitor
Capacitor wraps the web assets in real Xcode/Android Studio projects with a plugin
ecosystem, and does not require a service worker or PWA manifest. It is the practical
route to the Apple App Store; plain PWAs cannot be listed there [2][5]. Caveat: App Store
Guideline 4.2 rejects thin website re-packagings — the offline IndexedDB note store,
outbox, and native share/keyboard integrations are the justification that gets it
through [5]. Maintenance cost is real: native toolchains and store review cycles.

### Level D — Desktop native via Electron (only if OS integration is needed)
Electron earns its place only for things a PWA cannot do: launch-at-login, a system tray,
global hotkeys, native menus, and unscoped filesystem access [6]. None of those are
required for note-taking, so prefer the installed PWA on desktop.

### Local files without Electron — File System Access API
For "save this note as a real `.md` file in my Documents folder", the File System Access
API (`showSaveFilePicker`/`showOpenFilePicker`) works on Chromium desktop browsers;
Firefox and Safari do not support the pickers (Safari/Firefox support only OPFS), so ship
it as progressive enhancement with the existing download/upload fallback for other
browsers [3][5]. File handles can be persisted in IndexedDB so a folder only has to be
authorized once.

---

## 8. Security considerations specific to this app

- The GitHub App **private key in localStorage is readable by any script on the origin**
  — one XSS in a card description or rendered markdown compromises it. The markdown
  renderer already escapes before decorating (`index.html:3036-3037`); keep that invariant
  and add a Content-Security-Policy. GitHub Pages cannot set HTTP headers, so use a
  `<meta http-equiv="Content-Security-Policy">` allowing same-origin scripts/styles plus
  the known API hosts, and banning inline handlers. (In-line `<script>` currently used
  everywhere would need `'unsafe-inline'` or a nonce — another reason the module
  extraction in Phase 0 matters.)
- After the IndexedDB move, consider `CryptoKey` non-extractable storage via the Web
  Crypto key store for future hardening; the current PEM-in-storage model should be
  documented as the remaining weak point.
- The service worker is a high-value target: keep it dependency-free, and include an
  explicit `updateViaCache: "none"` registration so a cached SW can never pin a stale
  security fix.
- Scoped permissions: the GitHub App manifest already requests least privilege (Contents
  write + repo creation). Re-verify after any new feature.

---

## 9. Scratchpad performance improvements

| # | Issue (current code) | Change | Expected gain |
| --- | --- | --- | --- |
| S1 | Scratchpad code ships inside the 300 KB dashboard and initializes on every dashboard load (`initScratchpadTool`, `index.html:3384`, called at `4748`) | Extract to `scratchpad.html` + ES modules; dynamic-`import()` the GitHub/JWT module only when the sync panel opens | Dashboard payload and startup work drop; PWA shell is small and cacheable |
| S2 | Markdown preview rebuilds the whole `innerHTML` on each keystroke (180 ms debounce, `index.html:3336-3340`) | Move `renderScratchpadMarkdown` into a Web Worker; post the source string, receive sanitized HTML; skip renders when text is unchanged | Typing latency on long notes becomes near-zero; no layout work on main thread |
| S3 | Synchronous localStorage write on every input debounce (`index.html:3395-3400`) | Async IndexedDB write (Phase 3), coalesced per tick | No main-thread I/O blocking; quota headroom from ~5 MB to GB-scale [9] |
| S4 | Emoji picker builds a flattened list of every emoji at editor init (`index.html:3141`) | Lazy-build on first picker open; keep the static data in its own module | Removes needless startup cost |
| S5 | Each save can mint tokens and re-fetch serially; stale saves aren't cancellable | Keep the existing token cache (`ghMintInstallationToken`, `index.html:2967`); add `AbortController` per save so a newer keystroke cancels an in-flight stale PUT | No wasted requests; no out-of-order commits |
| S6 | No offline story — failed saves just show an error | Outbox queue (Phase 4) | Reliability; also removes error-state rendering on flaky networks |
| S7 | Static assets inlined → re-downloaded on every edit; no long-lived caching | Versioned external assets + service worker precache | Repeat visits served from cache, instant offline launch |
| S8 | No measured baseline | Add Lighthouse runs (PWA + Performance categories) and a `PerformanceObserver` for long tasks in dev | Makes every later change measurable |
| S9 | `feeds.html`-style duplicated standalone pages each restate CSS/JS | Shared `assets/styles.css` and modules (also tracked in `dashboard-improvements-102726.md` R2) | One fix instead of N; better compression across cached assets |

Worker rendering note: the worker must produce **already-escaped** HTML (the current
escape-then-decorate order in `renderScratchpadMarkdown` is the security boundary), and
the preview's task-checkbox feature (`index.html:3343-3353`) stays on the main thread —
only string→HTML rendering moves.

---

## 10. Validation plan

1. **Unit/behavior tests:** the existing jsdom suites
   (`docs/scratchpad-github-sync.test.js`, `docs/favorites-scratchpad.test.js`,
   `docs/clipboard-history.test.js`) currently pass and pin the sync/favorites behavior —
   keep them green while extracting modules; add tests for the IndexedDB migration
   (localStorage note → IDB) and the outbox (offline enqueue → online flush → conflict
   path).
2. **PWA checks:** Lighthouse PWA category at 100%; DevTools Application panel showing
   manifest, SW "activated and running", and cached offline shell; airplane-mode reload
   opens and edits notes; kill the tab, reopen from the launcher icon, note is present.
3. **Cross-browser:** Chrome/Edge install prompt; iOS Safari Add to Home Screen +
  standalone appearance; Firefox offline via cache (no Background Sync dependency).
4. **Security:** CSP meta tag enforced (no console violations), authenticated GitHub
   responses absent from Cache Storage in DevTools.
5. **Subpath audit:** every URL in the manifest, SW precache list, and module imports
   resolves under `/dash/` on the GitHub Pages deployment.

---

## 11. Roadmap and effort

| Phase | Deliverable | Rough effort | Dependency |
| --- | --- | --- | --- |
| 0 | Extract Scratchpad into `scratchpad.html` + modules; dashboard opens it | M | none |
| 1 | Manifest + icons; installable (online) | S | Phase 0 |
| 2 | Service worker; offline app shell; update toast | M | Phase 1 |
| 3 | IndexedDB store + migration from localStorage | M | Phase 0 |
| 4 | Commit outbox + online/manual flush | M | Phase 3 |
| 5 | Install UX, iOS hints, File System Access (Chromium) | S | Phases 1-3 |
| 6 | Bubblewrap TWA for Play (needs `.well-known` placement decision) | M | Phases 1-2 |
| 7 | Capacitor for iOS App Store (only if store presence is wanted) | L | Phase 4 |

Phases 0-5 stay within the current plain-HTML/JS, no-build approach and need no new
runtime dependencies. Phases 6-7 are packaging exercises decided by whether an app-store
presence is actually wanted — the installed PWA from Phases 1-3 already "runs outside the
browser" for daily use.

---

## Sources

1. [Making PWAs installable — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
2. [TWA vs Capacitor: Which Android Wrapper Wins in 2026? — SaaStoStore](https://saastostore.com/blog/twa-vs-capacitor)
3. [Offline data (File System Access support table) — web.dev](https://web.dev/learn/pwa/offline-data)
4. [Web app manifest does not meet installability requirements — Chrome for Developers](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest)
5. [PWA in 2026: what an installable web app actually requires — MSLogic](https://mslogic.gr/en/blog/pwa-pote-axizei/)
6. [PWA vs Electron: Which Should You Actually Ship? — Deskifier](https://www.deskifier.com/blog/pwa-vs-electron-which-should-you-ship)
7. [OPFS: The Browser's Built-in Filesystem Explained — DEV Community](https://dev.to/helloashish99/opfs-the-browsers-built-in-filesystem-explained-o5i)
8. [Adding your PWA to Google Play — Google for Developers](https://developers.google.com/codelabs/pwa-in-play)
9. [Can You Publish a PWA to the App Store and Google Play? (2026) — MobiLoud](https://www.mobiloud.com/blog/publishing-pwa-app-store/)
10. [Trusted Web Activity quick start — Chrome for Developers](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start/)
11. [PWA Mobile Testing Checklist 2026 — MobileViewer](https://mobileviewer.github.io/pwa-mobile-testing-checklist-2026)
12. [Testing Your PWA: 2026 Progressive Web App Guide — CloudQA](https://cloudqa.io/testing-your-pwa-progressive-web-application/)
13. [IndexedDB vs localStorage: Limits, Speed, When to Use — We.Inc](https://we.inc/guides/indexeddb-vs-localstorage)
14. [File System Access API: Browser Support, Methods, Limits — Testmuai](https://www.testmuai.com/learning-hub/file-system-access-api-browser-support/)
15. [PWA vs Native App vs Hybrid: Complete Comparison Guide for 2026 — Testmuai](https://www.testmuai.com/learning-hub/pwa-vs-native/)
16. [Persistent file handling with the File System Access API — Transloadit](https://transloadit.com/devtips/persistent-file-handling-with-file-system-access-api/)
17. [Offline Support and Progressive Web Apps (Background Sync support table) — DEV Community](https://dev.to/zeeshanali0704/frontend-system-design-offline-support-and-progressive-web-apps-pwas-4k8m)
18. [File System Access And Persistent Storage For Web Apps — Modern Web Weekly](https://modernwebweekly.substack.com/p/file-system-access-and-persistent)
