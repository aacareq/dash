# Repository improvement review — 2026-11-20

**Status:** Open backlog from a review of the active dashboard and its test setup.  
**Scope:** Current root-level app and maintained `assets/`, `tests/`, and `docs/`; archived snapshots were not treated as active code.  
**Order:** Highest impact first. These are follow-up items, not claims that the behavior is already fixed.

## 1. Prevent DOM XSS in Google Tasks and Calendar results — P1 security

**Files:** `index.html` — `initGoogleTasksTool()` and `initGoogleCalendarTool()`.

The Tasks renderer interpolates API-provided `task.title` and `task.notes` into `row.innerHTML`; the Calendar renderer interpolates `event.summary` the same way. These are remote account contents, not trusted HTML. A malicious task or event can therefore inject markup/event handlers into the dashboard. This is especially serious because the same origin also keeps OAuth/PAT credentials and a GitHub App connection in browser storage.

**Improvement:** Build rows with DOM nodes and assign all provider text through `textContent`; keep checkbox state and date formatting as typed DOM properties. Do not add a general-purpose HTML sanitizer for these fields.

**Acceptance checks:** Mock task/event responses containing `<img onerror>`, SVG/event handlers, and markup-like text; verify the content remains visible as text, no element is created, and no handler runs.

## 2. Validate custom-tool URLs at every import/load boundary — P1 security

**Files:** `index.html` — `importConfig()`, `loadPreferences()`, `mergeCustomTools()`, and `makeCard()`.

Imported config is parsed and `customTools` are merged without validating each record. `makeCard()` assigns `item.url` directly to an anchor's `href`. A crafted import containing a `javascript:` URL can create an executable same-origin link. Browser-side form validation does not protect imported files or old/tampered localStorage values.

**Improvement:** Validate custom-tool shape and bounds on import and localStorage load; allow only explicitly supported `http:`/`https:` URLs (or a narrowly documented internal-relative-path rule); refuse or quarantine invalid records before rendering. Validate again at the point a link is created.

**Acceptance checks:** Import JSON with `javascript:`, `data:`, malformed URLs, missing names, non-string tags, and oversized fields; assert invalid entries are rejected and no unsafe `href` is rendered.

## 3. Make browser credential persistence an explicit, least-surprise choice — P1 security / privacy

**Files:** `index.html` — `initGoogleTasksTool()`, `initGoogleCalendarTool()`, and `initGithubWorkTool()`; `assets/notes-workspace.js` — saved BYOK provider keys; `assets/github-app.js` and `assets/notes-store.js` — GitHub App connection persistence; `docs/working-on-integrations.md` and `README.md`.

The static app necessarily handles credentials in the browser: Google access tokens and the optional GitHub PAT are persisted in `localStorage`, Harness Hub BYOK keys can be reused from browser storage, and the GitHub App private key is kept in the local connection record. This is not equivalent to a server-side secret store; any same-origin script injection can read browser-accessible credentials. The integration guide explains some of this, but the persistence choice and revocation/clear paths are not consistent across providers.

**Improvement:** Default new credential fields to session-only use; make persistence a separate, clearly labeled opt-in with expiry/permission warnings; add one-click clear/revoke guidance per provider; never export credentials in dashboard config. Keep the GitHub App key warning prominent and document how to rotate/revoke it. Review CSP and same-origin script exposure as part of the threat model.

**Acceptance checks:** Tests verify session-only keys are not written to storage, saved credentials can be cleared, imports/exports never include keys, and setup copy names the exact storage location and revocation steps.

## 4. Make Google Tasks list selection and pagination explicit — P2 correctness

**File:** `index.html` — `initGoogleTasksTool()`.

The UI silently selects `listsData.items[0]`, loads one Tasks API page without following `nextPageToken`, and creates new tasks in that first list. People with multiple task lists or more than the default page of tasks can mistake an incomplete view for their full list and add a task to the wrong list.

**Improvement:** Render a task-list selector, label the selected destination before writes, fetch pages until complete (or provide a clear “Load more” control), and report partial failures instead of presenting a truncated list as complete.

**Acceptance checks:** Mock multiple lists, multiple task pages, empty lists, expired credentials, and a failed later page; verify selection, pagination, and task creation target are correct.

## 5. Add regression tests for the browser-facing security and API paths — P2 test coverage

**Files:** `tests/`, `docs/`, and `package.json`.

Current suites cover Scratchpad/GitHub flows well, but there are no focused behavior tests for the Google Tasks/Calendar DOM renderers or custom-tool config URL validation. The untrusted HTML and unsafe-scheme cases above can therefore regress without a test failure.

**Improvement:** Add fetch-mocked dashboard tests for Google API success/error/expired-token paths, hostile task/event strings, task-list pagination, and imported custom-tool validation. Keep API tests deterministic and independent of real accounts/network.

**Acceptance checks:** The new tests fail against the unsafe render/import behavior and pass after remediation; `npm test` exercises them.

## 6. Run automated checks on pull requests and reduce local feedback cost — P2 developer experience

**Files:** Missing `.github/workflows/test.yml`; `package.json`; `docs/link-check-workflow.yml`.

There is no active `.github/workflows/` directory, so tests are not automatically required on pull requests. The link-check workflow is only stored under `docs/`. The pre-feature baseline `npm test` run took about 91 seconds; the full suite with Video Creation tests took about 115 seconds in the final check. Both runs emitted Node `MODULE_TYPELESS_PACKAGE_JSON` warnings for ESM `.js` modules, which makes it harder to distinguish useful failures from setup noise.

**Improvement:** Add a PR workflow that runs `npm ci` and `npm test`, plus a lightweight JavaScript syntax check. Profile the slow behavior suites and remove avoidable waits without weakening assertions. Make the `.js` ESM/CommonJS boundary explicit (for example, consistent `.mjs`/`.cjs` extensions or a deliberate package type) so Node does not have to reparse modules heuristically.

**Acceptance checks:** A clean checkout passes the same checks in CI; CI output contains no module-type warnings; the test runtime is measured and documented.

## 7. Complete GitHub repository discovery beyond the first page — P2 existing integration backlog

**Files:** `index.html` — `initGithubWorkTool()` repository request; `docs/working-on-integrations.md`; `tasks/working-on-integration-roadmap.md`.

The Work List requests `per_page=100` but does not follow GitHub pagination, so a user with more accessible repositories may not be able to select the one they need. This limitation is already recorded in the integration roadmap and should stay tracked there rather than being mistaken for a complete repository list.

**Improvement:** Follow the GitHub `Link` header (or expose a search/paged selector) for both user-token and GitHub App installation modes; preserve the current Scratchpad default and explain permission-filtered repositories.

**Acceptance checks:** Mock more than 100 repositories over multiple pages for both authentication modes; verify the picker can reach every returned repository without duplicates and still honors the default selection.
