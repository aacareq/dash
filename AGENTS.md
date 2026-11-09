# Agent instructions

## Project purpose

Dash is a personal, static dashboard for AI tools, links, bookmarklets and everyday utilities, with an offline-capable Scratchpad PWA. It runs directly in the browser and is deployed on GitHub Pages, including under the `/dash/` subpath. There is no application backend or required production build step. Preserve existing user data and offline behavior.

## Tech stack

- Plain HTML, CSS and browser JavaScript; the main dashboard is `index.html`.
- Scratchpad PWA: `scratchpad.html`, modules and styles in `assets/`, `manifest.webmanifest`, and `sw.js`.
- Browser storage and GitHub APIs for notes and optional synchronization.
- Node.js test runner and jsdom for automated tests; npm manages test dependencies.

## Development commands

Run from the repository root:

- Install test dependencies: `npm ci`
- Run all tests: `npm test`
- Run PWA tests: `npm run test:pwa`
- Run dashboard behavior tests: `npm run test:dashboard`
- Serve locally: `python3 -m http.server 8000` (open `http://localhost:8000/`)
- Lint: no lint command is configured.
- Build: no build command is required or configured; the static files are the deployable site. To regenerate PWA icons when needed, run `npm run generate-icons`.

## Versioning

Always update the semantic-versioned version number (`vMAJOR.MINOR.PATCH`) in the dashboard title-header at the top of `index.html` (`<div class="brand">🚀 <span>DashOS-vMAJOR.MINOR.PATCH</span></div>` inside `.brand-wrapper` in `<aside id="sidebar">`) **every time** you work on a task, bug fix, or feature — including documentation, tests, or instruction updates:

- **PATCH (`vX.Y.Z` → `vX.Y.(Z+1)`)**: Increment the patch number for bug fixes, minor refinements, documentation or `AGENTS.md` updates, test additions, and routine maintenance (for example, `DashOS-v1.5.7` → `DashOS-v1.5.8`).
- **MINOR (`vX.Y.Z` → `vX.(Y+1).0`)**: Increment the minor number and reset `PATCH` to `0` when adding a new feature, cluster/tool integration, or backward-compatible user-facing capability (for example, `DashOS-v1.5.7` → `DashOS-v1.6.0`).
- **MAJOR (`vX.Y.Z` → `v(X+1).0.0`)**: Increment the major number and reset `MINOR` and `PATCH` to `0` for major redesigns, breaking changes to user workflows or storage/config formats, or when explicitly requested (for example, `DashOS-v1.6.0` → `DashOS-v2.0.0`).
- **Keep the service worker cache in sync**: Because `index.html` is listed in `sw.js`'s `PRECACHE`, bumping the title-header version in `index.html` modifies a precached file, so also increment `CACHE_VERSION` in `sw.js` (for example, `dash-scratch-v12` → `dash-scratch-v13`) so offline and PWA clients receive the updated shell.
- **Leave unrelated version strings alone**: Do not alter `package.json`'s `"version"`, `exportConfig()`'s `"CommandOS-1.5"` format identifier, or `localStorage` keys (`*-v1`) unless an explicit migration is part of the task.

## Architecture rules

- Keep the dashboard's existing single-page structure in `index.html`; keep Scratchpad functionality in its existing `assets/` modules and use the corresponding tests in `tests/` and `docs/`.
- Preserve relative paths and GitHub Pages subpath compatibility; do not assume deployment at the domain root.
- Preserve existing localStorage keys and saved-data formats unless an explicit migration is provided; the old `commandos` keys are not merely branding.
- When changing any asset listed in `sw.js`'s `PRECACHE`, bump `CACHE_VERSION` so offline clients receive the updated shell.
- Always follow the `## Versioning` section above and bump the semantic version in `index.html`'s title-header on every change.

## Hard constraints

- Never commit secrets, tokens, private keys, or personal user data.
- Never cache authenticated GitHub API traffic or credentials in the service worker.
- Never add external dependencies without discussing them first.
- Never silently overwrite remotely changed notes; retain the existing conflict checks and explicit overwrite flow.
- Never commit `node_modules` or generated test output.
