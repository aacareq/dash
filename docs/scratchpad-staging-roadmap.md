# Scratchpad: simple capture now, prompt/research staging later

## Shipped in v1.10.0

The original Scratchpad workflow is restored: a Markdown editor, preview, local autosave, files/folders, downloads, and optional conflict-aware GitHub sync. There is no Smart Review UI, classifier, decay timer, automatic note-copying, or parallel review inbox.

A collapsed **Capture text with context** helper works in both the dashboard's inline pad and standalone/full app. It supports:

- Content input and explicit, permission-based **Paste clipboard into draft**, with manual-paste fallback. Pasting appends to a draft rather than replacing it; nothing reads the clipboard on focus or page load.
- Optional source/origin (URL, book, author, meeting, etc.), intent (Task / Inspiration / Reference / Prompt Seed), and capture timestamp.
- **Add to note** appends plain Markdown at the end of the current note. It never replaces a selection or the existing note. Metadata is visible text, not a separate schema/store.
- A destination label, draft-only warning, empty-input validation, mobile-sized controls, and confirmation. Clipboard permission failure never changes the note or discards the draft. If the draft changes while a clipboard read is pending, the clipboard result is not applied.

Draft fields are not persisted before Add. After Add, the normal editor input/autosave/preview and optional GitHub autosave pipelines apply; no new storage key or remote service is introduced. Check the active file before adding. Source provenance is user supplied, not automatically verified or inferred from clipboard content.

Existing notes, credentials, sync settings, storage keys, and conflict protections remain unchanged. Prior review data is deliberately **not erased**: `dash-smart-review-v1` is left untouched in localStorage, but is no longer read or modified by the app. If you need to recover it, use browser developer tools → Application/Storage → Local Storage → the current site → `dash-smart-review-v1`, and copy its JSON value to a private backup file. Do not clear site data before recovering it. This legacy record is not included in ordinary note exports or GitHub saves.

## Update: v1.11.0

New-note Markdown outlines and a local, optional field-based Basic prompt creator are now shipped. See [Note outlines and prompts](note-outlines-and-prompts.md). Selection-to-prompt, a cross-note basket, and research launchers below remain proposals.

## Design principle for future work

**The note is the source of truth. Capture → optionally select → explicitly compile → preview → copy/export.** No hidden copying, timer queues, automatic organization, or extra inbox. Every feature must answer “where is this saved?” on-screen. Ship each stage separately and validate it with users before adding the next one.

All ideas below are proposals, not shipped capabilities.

## Phase 1 — Selection-to-prompt (highest value, least UX complexity)

Start with an explicit **Use selection** action on the existing editor, not a new card database. Open an optional drawer containing a copy of the selection, with a visible source filename and source text. The original note stays editable and unchanged. Keep staging in memory; label it “temporary, not saved.” Warn before discarding a nonempty drawer.

Offer three deterministic wrappers and always show editable output before copying:

1. **Synthesis:** a Markdown `## Context` section containing the selected text and source, followed by “Identify connections, contradictions, and 3 novel angles. Distinguish evidence from speculation.”
2. **Critique / steelman:** a `## Premise` section, followed by “Steelman the premise, then stress-test it. List failure modes and ask 5 clarifying questions.”
3. **Deep research brief:** a `## Evidence and open questions` section, followed by “Generate a structured research plan, search queries, and primary-source targets. Separate supplied evidence from claims that still require verification. Do not invent citations.”

Use Markdown initially to avoid XML escaping complexity. If XML export is added, escape `&`, `<`, `>`, and attribute quotes, and test delimiter injection. Treat captured research as untrusted data, not instructions. Wrappers can state that quoted content is evidence only, but cannot guarantee downstream prompt-injection prevention.

A live **characters / estimated tokens** indicator can use `ceil(chars / 4)`. This is a rough English-text heuristic, **not an exact context weight**; languages, code, URLs, and model tokenizers vary. Include wrapper and provenance text in the estimate. Never imply guaranteed fit in a model's context window.

Acceptance gate: users can select text, understand temporary vs saved state, preview one wrapper, copy it with a manual fallback, and return to the unchanged note on mobile. No model/API request or cost.

## Phase 2 — Optional multi-snippet staging basket

Only after Phase 1 proves understandable:

- Add explicit “Add selection to basket,” plus remove/reorder controls and a counter. Each temporary snippet shows text, source file, source URL/origin, and capture time if provided.
- Copy across notes only on user request. Do not extract every paragraph into cards. Use an explicit “Split this selection at blank lines” option with preview; never destructively split original notes.
- Basket entries are snapshots; show that editing an original does not update staged copies. Prefer in-memory staging first; later offer a deliberate **Save basket as Markdown note** into the existing note store. If automatic draft persistence is desired, separately propose it with clear retention/storage rules.
- No swipe-only controls. Add accessible tap buttons first; optional swipes can supplement them, with undo and no destructive gestures.
- Render large lists lazily, cap previews, and avoid rerendering the editor while typing.

Acceptance gate: users can combine snippets from two files, identify their sources, remove one, preview compiled text, and export without altering either source file.

## Phase 3 — Lightweight retrieval and research hooks

Keep metadata portable inside Markdown rather than adding an implicit lifecycle engine:

- **Intent:** the shipped optional capture label is a starting point. Single-tap intent pills could replace the select if testing shows a speed improvement; they must remain optional and keyboard-accessible.
- **Lifecycle:** optional visible `Status: Raw / Refined / Promoted / Archived` text or a proposed metadata block. Changes are manual; “Promoted” means the user explicitly saved/exported a prompt/brief, not that an AI improved it. Do not auto-archive source notes.
- **Open questions:** a one-tap Markdown section template (“What don't I know yet?”) inside the reference note, rather than another task inbox.
- **Related notes:** index explicit `#tags`, normalized URLs, and opt-in keywords locally. Show match reasons. Capitalized-phrase heuristics can supplement search but are noisy (sentence starts, languages); label suggestions and allow dismissal. No external NLP dependency required. Profile and debounce indexing; use an idle-time or worker strategy for larger libraries.
- **Research launchers:** let the user edit the query before opening Google Scholar, arXiv, Wikipedia, or site-scoped Reddit/Hacker News searches. Build URLs with `URL` / `URLSearchParams` (e.g. Scholar `q`, arXiv `search_query`, Wikipedia `search`, and Google `q=site:reddit.com ...`). Open only the chosen provider with `noopener,noreferrer`, never a batch of tabs. Queries leave the device and may expose sensitive note content: show that warning. These are third-party searches, not guaranteed free APIs or authenticated primary-source evidence.
- **Filtered bundles:** propose user-confirmed hashtag/intent filtering with an export preview. Export stable UTF-8 Markdown first, then JSON with a schema version and optional escaped XML. Sort by normalized source path and explicitly selected order, include source provenance, use stable delimiters, and omit credentials, browser settings, and unrelated notes. The same selection should produce the same output bytes; timestamps belong to capture metadata, not the export generation time. Export is not a remote upload.

## Deliberately avoid

- Clipboard sniffing on app focus: browser restrictions differ; repeated prompts and silent private-data capture are unacceptable. Keep the shipped user-initiated paste button.
- Automatic source attribution: a clipboard snippet does not reliably identify its source page. Provide a quick source field and, later, an optional share/bookmarklet flow that explicitly supplies source URL/title.
- A new card hierarchy, background decay, or another synchronized database before the basic compiler is useful.
- Claiming exact tokens, verified sources, AI understanding, or cross-device basket synchronization without implementing them.

## Proposed rollout / verification

1. Ship simple capture (this PR) and validate notes + capture on phone/desktop.
2. Prototype selection-to-prompt behind one collapsed action; test with a small set of real note-to-prompt tasks.
3. Add basket only if users need cross-note selection, then retrieval/research tools.

For every phase: test XSS/escaping, append-only edits, no secret export, clipboard permission failures and async races, offline reload, GitHub Pages subpaths, screen-reader labels/keyboard operation, touch sizes, existing note data migration (if any), large-note latency, and remote conflict handling. Keep dependencies and backend costs at zero. Use the existing Node/jsdom test infrastructure; real mobile/browser testing remains necessary for layout, gestures, and permission prompts.
