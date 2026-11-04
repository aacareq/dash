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

## Architecture rules

- Keep the dashboard's existing single-page structure in `index.html`; keep Scratchpad functionality in its existing `assets/` modules and use the corresponding tests in `tests/` and `docs/`.
- Preserve relative paths and GitHub Pages subpath compatibility; do not assume deployment at the domain root.
- Preserve existing localStorage keys and saved-data formats unless an explicit migration is provided; the old `commandos` keys are not merely branding.
- When changing any asset listed in `sw.js`'s `PRECACHE`, bump `CACHE_VERSION` so offline clients receive the updated shell.
- Every project change must bump the version displayed in the brand at the top of `index.html`. For example, `DashOS-v1.5` becomes `DashOS-v1.5.1`; increment the patch version for subsequent changes unless a larger version change is requested.

## Hard constraints

- Never commit secrets, tokens, private keys, or personal user data.
- Never cache authenticated GitHub API traffic or credentials in the service worker.
- Never add external dependencies without discussing them first.
- Never silently overwrite remotely changed notes; retain the existing conflict checks and explicit overwrite flow.
- Never commit `node_modules` or generated test output.
