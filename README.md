# dash — Command Center 2026

A personal, single-page dashboard for AI chat, inference services, coding
agents and everyday tools — with search, favorites, recently launched items,
custom tools, config import/export, a dark/light theme, and one-click
bookmarklets that launch whole workflows.

**Live dashboard:** https://aacareq.github.io/dash/

## Use it

Open the live link above, or open `index.html` locally in a browser. No build
step and no dependencies — everything is plain HTML, CSS and JavaScript.

- **Search** filters every card; section search boxes support query templates.
- **Favorites** are pinned with the star button and saved in `localStorage`.
- **Custom Tools** lets you add your own links; export/import your config from
  the dashboard to move it between browsers.
- **Bookmarklets** (dashed cards in Favorites, e.g. *GitHub + Arena Agent* and
  *Coding Agents*) can be clicked to run, or dragged onto your bookmarks bar.
  Allow pop-ups the first time so every tab can open.

## Layout

- `index.html` — the current dashboard (Command Center 2026)
- `*.html` / `tools/` — standalone topic pages (inference, coding, hosting,
  video, images, music, feeds, search and more)
- `archive/` — superseded dashboard versions, kept for reference

## Contributing / changes

Edit the file you want to change and open a pull request against `main`.
A weekly link-check workflow is provided in `docs/link-check-workflow.yml` — move it to
`.github/workflows/link-check.yml` to enable it (adding workflow files via an app needs
GitHub's separate workflows permission).

## License

MIT — see `LICENSE`.
