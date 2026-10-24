# Clipboard History (`Working On → Clipboard History`)

A multi-item clipboard for the dashboard: capture the things you copy or paste,
pin the keepers, copy any of them back, and save the whole collection to
`clips/clips-<date-time>.md` in your **scratch** repo — using the same
one-click GitHub connection as the Scratchpad (no separate setup).

> New collection: a collection is a batch of clips with its own file,
> `clips/clips-2026-10-24-1142.md`. **New collection** clears the list and
> starts a new file; the old file stays in the repo.

## What a browser will and won't let a clipboard manager do

This is the honest version, because it shapes the whole design.

| Want | Reality in a web page |
| --- | --- |
| Notice every copy made anywhere on the machine | **Impossible.** There is no clipboard-change event, and no way to read the clipboard in the background. |
| Read the clipboard on a timer | **Impossible.** Reads need a user gesture and (usually) an explicit permission prompt. |
| Read the clipboard when the user clicks a button | **Possible**, via `navigator.clipboard.readText()` — secure context, user gesture, permission prompt in Safari/Chrome; Firefox doesn't expose it to scripts by default at all. |
| Capture a paste the user makes here | **Reliable**, no permission: the `paste` event carries `clipboardData`. This is the primary path. |
| Capture copies made *on this page* | **Possible**, via the `copy` event — only text selected inside the dashboard. |
| Hold more than one item | **Our own state**, not the OS. The system clipboard still holds exactly one item; the history lives in `localStorage`. |
| Put an old item back | **Possible** — writing to the clipboard (`writeText`) *replaces* the single OS item. |
| Keep going when the tab is in the background | **No.** Captures only happen while the dashboard is focused. |

Consequences you'll notice:

- If you copy something in another app or another tab, this tool **will not
  see it** until you paste it here (or click Capture clipboard while it's still
  the latest clipboard item).
- Safari/iOS may show a **Paste** permission prompt on the first capture, and
  Firefox may refuse `readText` entirely — pasting into the dialog or the input
  box always works, so those browsers get a clear "paste instead" message
  rather than a silent failure.
- `navigator.clipboard` requires **HTTPS or localhost** (same as the GitHub
  setup). On `file://` the capture button explains itself and the paste paths
  still work.
- Only **text** is captured. Images/HTML would need the richer `read()` API and
  a much bigger permission ask, so they're out of scope — which is also why the
  saved file is plain markdown.

## Privacy and safety

A clipboard routinely holds passwords, tokens and personal data. So:

- Nothing is captured **automatically in the background** — only pastes inside
  the dialog, copies on this page, or an explicit click.
- History capped at **100 clips** and **20,000 characters** per clip; older,
  unpinned clips fall off first, and an oversized clip is truncated with a note
  rather than silently dropped or blowing the ~5 MB `localStorage` budget.
- Everything stays in this browser (`dash-clipboard-history-v1`) until you save.
  **New collection** clears the list.
- Once saved, clips are **in the repo's git history**, readable by anyone with
  access. Don't save a collection that contains secrets — or use a private repo
  (the scratch repo is private by default).

## Capturing

- **Paste anywhere in the dialog** — the reliable path, no prompts.
- **Capture clipboard** — reads the current clipboard; explains permission
  denial or unsupported browsers and points you at the paste path.
- **Add clip** box — type/paste and press Enter.
- **Copy** inside the dashboard while the dialog is open also adds the
  selection.

Duplicates aren't stored twice (the existing one is highlighted instead), blank
clips are rejected, and multi-line clips keep their line breaks.

## The saved file

```
# Clips — 10/24/2026, 11:42:00 AM

_2 clips · saved 10/24/2026, 11:45:12 AM_

## 1 · 10/24/2026, 11:42:05 AM

```text
first clip
```

---

## 2 · 10/24/2026, 11:43:00 AM · 📌 pinned

```text
const x = 1;
console.log(x);
```
```

- Each clip is a **fenced block**, so code, lists and even markdown inside a clip
  survive intact and can't rewrite the rest of the file. A clip that itself
  contains a fence gets a longer fence (```` ```` ````).
- Pinned clips are marked; the list in the tool shows pinned items first.
- Re-saving updates the same file (via its blob SHA, so a concurrent change
  triggers a re-read and retry instead of a hard failure).

## Saving to the scratch repo

- Target: `<account>/scratch`, path `clips/clips-<YYYY-MM-DD-HHMM>.md` — both
  shown in the header bar above the list.
- Uses the **same connection** as the Scratchpad: if GitHub saving is set up
  there, this works immediately; if not, the panel says so and offers a button
  that opens the Scratchpad's GitHub section.
- If the `scratch` repo doesn't exist yet, it's created (private, initial
  commit) before the first write.
- **Autosave** (off by default) pushes the collection ~3 s after each new clip.
- A refused write (app not installed on the repo) is reported in the status
  line and the header's error state, not silently dropped.

## Storage keys

| Key | Contents |
| --- | --- |
| `dash-clipboard-history-v1` | `{ startedAt, items: [{ id, text, createdAt, pinned }] }` |
| `dash-clipboard-path` | a custom file path, if one was set |
| `dash-clipboard-autosave` | `"true"` when autosave is on |
| `dash-clipboard-sha-v1` | last saved blob SHA |

## Tests

```sh
npm install jsdom
node docs/clipboard-history.test.js
```

Covers capture by paste / capture button (granted, denied, unsupported) / manual
entry, duplicate and blank rejection, the 20k truncation, copy-back, pin/delete
with persistence, the saved markdown (fences, escalation, pinned marker,
separator), SHA-based updates, scratch-repo bootstrap, autosave timing, new
collections, unreachable-repo errors, and that it reuses the existing app
connection instead of asking for anything new.
