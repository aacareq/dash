# Help, links, and Smart Review (v1.7.0)

This replaces the nonfunctional help panel from PR #52. Home now has a Help & How to use button opening a native, keyboard-dismissable dialog, including usage, capability and performance ideas. Both inline and full-app editors implement the Link toolbar action with selection preservation, cancellation, HTTP(S) validation, and the existing input/autosave pipeline.

## Review workflow

Open Scratchpad → full app view, or use the card's App link. Review copies are captured after a 1.5-second typing pause or editor blur, one blank-line-separated paragraph per item. Source paths distinguish files. Unchanged captures are deduplicated; edits to an active paragraph refresh its metadata. These are review copies, not a destructive organizer of source files.

- Task intent (checkboxes or leading action verbs) wins over URLs; otherwise URLs are Follow-Up and prose is Spark.
- Tasks surface after 72 hours. Links surface after 7 days and auto-archive after 30 days untouched. Snooze resets attention to 7 days; three snoozes suggest passive reference.
- Needs Attention opens one card. Buttons offer done, promote, snooze, manual Markdown-summary mutation, compost, and reference downgrade. Touch swipe right snoozes; left composts.
- Mutation is explicitly manual/offline: no remote page fetching, CORS proxy, paid AI, or fabricated summary. Original link copies are archived and a new evergreen summary is created.
- Evergreen items appear in a daily rotating Serendipity selection (up to two).
- Compost is searchable and restorable. Review JSON export includes active and archived records. Import is a future capability, not currently offered.

Storage: `dash-smart-review-v1` localStorage, separate from existing note/credential storage and GitHub synchronization. Each flat record includes `type`, `lastTouchedAt`, and `snoozeCount`, plus source, text and archive state. Never put secrets in notes. Review copies are local-only. No original notes, synced files, or storage keys are removed. Storage failure is shown; malformed collections are not overwritten. Active tabs listen for review storage changes; concurrent writes are not a transactional cross-device sync protocol.

Timers are checked on app load, capture, review actions, and tab visibility. No polling or background network service is required. Very large collections should eventually move to IndexedDB with indexed queries and virtualized rendering.

## Verification

`npm test` includes `tests/smart-review.test.mjs`, testing classification, capture/edit deduplication, threshold boundaries, snooze escalation, archive/restore, summary mutation, toolbar behavior and URL validation, modal wiring/focus return, and review UI actions/search/XSS safety, alongside existing dashboard/PWA/sync regression tests.

Manual browser checklist: phone (320/390px), tablet (768px), desktop; keyboard tab/Escape and modal focus; touch swipe; editor selection on mobile; offline reload after the service worker update; existing note and GitHub conflict flows. Responsive styles wrap headers/toolbars/path controls, stack editor/preview, enlarge touch targets, and respect safe-area insets. Automated DOM tests do not substitute for device-level layout checks.
