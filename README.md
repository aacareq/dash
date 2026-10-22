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
  list, a GitHub-backed work list that can create files in a chosen repo, a
  Google Calendar mini agenda, a Pomodoro/focus timer, an exportable
  scratchpad, and a Techmeme/Hacker News headlines feed (with a short chain of
  fallback sources and a direct link if every live fetch fails). The Google
  Tasks, GitHub, and Google Calendar tools need a token pasted in (kept only
  in this browser's `localStorage`) since the dashboard has no backend of its
  own.
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
