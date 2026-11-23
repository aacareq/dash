# About Dash: feature set

Dash is a static, browser-based dashboard for AI tools, links and personal
workflows. It runs without a backend or build step; some integrations require
internet access, provider accounts or user-supplied credentials. See the
[main README](../README.md) for setup, details and limitations.

## Dashboard and productivity

- Searchable tool clusters, favorites, recent launches, custom links,
  configuration import/export, themes and workflow bookmarklets.
- Working On utilities include tasks, calendar, focus timer, GitHub work
  list, clipboard history and news feeds. Some integrations require separate
  authorization; clipboard access is subject to browser restrictions.
- Coding Agents includes a link to Google Antigravity Remote, searchable by
  Antigravity and remote-agent aliases.

## Notes and offline work

- Scratchpad is an installable offline-first PWA with local note storage,
  Markdown editing, an offline sync queue and optional GitHub synchronization
  with conflict checks.
- Notes adds a searchable library, tags, relationships, reminders and an
  optional bring-your-own-key (BYOK) AI Memory assistant. Some metadata and
  attachments remain local to the device.
- Notebook provides local autosave, optional GitHub sync, Markdown tools,
  templates, an outline, task aggregation and optional BYOK AI assistance.

## Media and publishing

- Video Creation includes research and a browser-native storyboard builder;
  Zero-Cost Motion Lab creates procedural frames and browser-recorded video,
  rather than AI-generated footage.
- Social Motion Studio combines templates, captions, Canvas animation and
  browser recording. Local scripts work without a key; hosted image and BYOK
  script services require network access and are subject to provider limits.
- X Studio offers a post composer, hooks and templates, media creation, local
  drafts and scheduling aids, and several publishing paths. Some paths require
  external services or server-side setup.

## Recent changes

Most recent substantive merged updates on main, as of November 22, 2026:

1. [#68](https://github.com/aacareq/dash/pull/68) added Antigravity Remote to
   Coding Agents and made it searchable.
2. [#67](https://github.com/aacareq/dash/pull/67) added Social Motion Studio,
   with social formats, animated captions, optional hosted images and BYOK
   scripts, plus browser exports.
3. [#65](https://github.com/aacareq/dash/pull/65) fixed X Studio's empty
   dropdowns and hardened its posting workflow, storage and browser fallbacks.
4. [#64](https://github.com/aacareq/dash/pull/64) introduced X Studio's
   composer, media tools, drafts and publishing options.

[#66](https://github.com/aacareq/dash/pull/66) was a checkpoint sync, not a
separate feature update.

For the adversarial review, improved evaluation rubric, and three-minute value
plan, see [Three-minute value evaluation](three-minute-value-evaluation.md).
