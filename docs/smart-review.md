# Notes-first Smart Review (v1.9.0)

## User workflow

1. Your existing active note editor is first, with its normal local autosave and optional GitHub synchronization. Smart Review appears directly below the editor.
2. To add review data, either type a new item in the review input and click **Add to review**, or highlight text in the existing note editor and click **Add selected note text**. A blank-line-separated selection/input can add several items. The selected note's path is shown as the copy's source. New input is clearly labeled as review-only.
3. Tick saved review items, or use **Select all active** / **Needs Attention** to choose them. These buttons only select items. **Clear selection** unchecks them. New copies are selected automatically but do not start a review.
4. Click **Start Smart Review (N)**. One selected card appears below the saved item list. Review sessions include only the selection at the time Start was clicked. Editing the selection or adding copies closes the old session until Start is clicked again.
5. Promote, Snooze, Mutate, Compost, Do / Done, and Next item operate on the displayed review copy. They never rewrite the original note. You can select fresh items and evergreen Sparks without waiting days for expiration.

## Where data goes

| Data | Storage / backup | Relationship to notes |
| --- | --- | --- |
| Existing notes | Existing IndexedDB note store, file downloads, optional GitHub note sync | Original source; existing behavior preserved |
| Saved review items and timers | Local browser `dash-smart-review-v1`; separate Export review JSON backup | Independent copies; never sent to GitHub or written into source notes |
| Selection and current review session | In-memory only | Resets when reloading; saved items remain |

**Nothing is automatically captured from notes.** Opening, typing, blurring, or switching a note does not copy its contents to review. Repeated explicit copies of the same text from the same note are deduplicated. Separate selections from a source never overwrite an earlier copy. Editing original text later does not silently update its independent review copy.

The preexisting review storage key/records are retained, including earlier automatically captured items. Active items are listed for selection; archived items remain searchable/restorable. Clearing browser storage erases local review data. Note exports/GitHub saves do not include review copies; use Export review JSON separately. Import/restore of JSON backups is not implemented.

## Classification, timers, and actions

- Task intent (checkboxes or leading action verbs) wins over URLs; otherwise URLs are Follow-Up and prose is Spark.
- Tasks surface after 72 hours; links after 7 days and auto-archive after 30 untouched days. Snooze sets a one-week delay; three snoozes suggest keeping a passive reference.
- Promote makes a task; Done and Compost archive the copy. Next item skips without changing timestamps.
- Mutate explicitly asks the user for an offline Markdown summary, archives the original copy, and creates an evergreen summary. No remote scraping, proxy, paid AI, or fabricated summaries.
- Daily Serendipity shows up to two evergreen items. Archive search, Restore, and Export apply only to review data.
- Touch swipe right snoozes; left composts the currently displayed selected card.

Checks run on app load, review actions, and tab visibility; there is no background polling. Existing note/GitHub storage and conflict protections are unchanged. Large review collections could eventually move to IndexedDB with virtualization; cross-device transactional metadata sync is not provided.

## Help and discovery

The home header, help dialog, inline Scratchpad, and full app header link to the review section. Deep links focus and scroll to it but do not capture notes, choose items, or start a session. The home help explains the explicit workflow and separate storage. Its responsive width fix from v1.8.0 is retained.

## Verification

`npm test` includes classification, timers, archive/restore, summary mutation, Markdown links, help sizing/wiring, and explicit review workflow tests. Regressions cover:

- Editor before review, with no automatic capture on load, input, or blur.
- Existing review data remains available and unchanged on load.
- Explicit note selection copies only highlighted content, retains source, and does not replace earlier selections.
- New items save independently, are selectable, and do not start review automatically.
- Only checked items appear after Start; deselection/empty selection, due selection, triage, archive/restore, and source-note preservation.

Manual browser checklist: phone/tablet/desktop and 200% zoom; text highlighting then Add selected note text (including mobile); select/unselect using keyboard/touch; Start review and swipe; reload/offline shell update; note switching and original GitHub conflict flows. Automated DOM/CSS tests do not substitute for physical-device layout testing.
