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
- **Custom Tools** lets you add your own links; export/import your config from
  the dashboard to move it between browsers.
- **Bookmarklets** — its own menu cluster (dashed cards, e.g. *GitHub + Arena
  Agent*, *Coding Agents*, and *GitHub + Arena AI + Proton VPN*) can be clicked
  to run, or dragged onto your bookmarks bar. Allow pop-ups the first time so
  every tab can open. The same cards are also pinned at the front of Favorites.
- **Personal AI Agents — Always-On** — a menu cluster for standing agent
  sessions you keep checking back into (Muse.ai, Grok Bot, Claude Code).
- **Working On** (4th in the menu, right after Daily Core) — in-dashboard
  tools that open as wide dialogs instead of navigating away: a Google Tasks
  list, a GitHub-backed work list that can create **and edit** files in a
  chosen repo, a Google Calendar mini agenda, a Pomodoro/focus timer, an
  exportable scratchpad, and a multi-source news/headlines feed. The Google
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
  edits over it.
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

## Layout

- `index.html` — the current dashboard (Command Center 2026)
- `*.html` / `tools/` — standalone topic pages (inference, coding, hosting,
  video, images, music, feeds, search and more)
- `archive/` — the 11 superseded dashboard versions, each kept exactly where
  it can be found (see `archive/README.md` for the list); there are no
  duplicate copies of these left in the repo root

## Contributing / changes

Edit the file you want to change and open a pull request against `main`.
A weekly link-check workflow is provided in `docs/link-check-workflow.yml` — move it to
`.github/workflows/link-check.yml` to enable it (adding workflow files via an app needs
GitHub's separate workflows permission).

## License

MIT — see `LICENSE`.
