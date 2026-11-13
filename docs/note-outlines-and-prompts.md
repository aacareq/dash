# Note outlines and Basic prompt creator — v1.11.0

## New-note outline

Fresh Markdown notes start with:

```markdown
# filename — Note created on 2026-11-13T12:34:56.000Z

## Plain Note

## Task

## Inspiration

## Reference

## Prompt Seed
```

The title is derived from the filename and is editable in the ordinary editor. Creation time is ISO-8601 UTC (the `Z` suffix). This is ordinary Markdown, not hidden metadata or a folder/card structure.

Applies to first-launch notes, Today's note when not already present, New note / New dated file, notes in today's folder, and new workspace Markdown files. “Create file with outline” replaces the misleading “Create blank file” label; non-Markdown formats still start empty. Existing notes, existing empty/cleared notes, copied-current-text files, and remote/imported bodies are not retrofitted or reformatted. GitHub's create-from-current-text flow retains the exact current contents. First-launch legacy text takes precedence over a template.

Capture continues appending ordinary text at the end. It does not move content into headings automatically; you remain in control of note organization.

## Optional Basic prompt creator

Open the collapsed section directly after **Capture text with context** in either the dashboard inline Scratchpad or the full app.

1. Enter the **intent / task**. Optional fields: role/persona (suggested roles include Senior Engineer, Copywriter, Research analyst and Teacher), background/context, audience, tone/style, constraints/exclusions, length limit, scope boundaries, examples, and steps.
2. Choose output instructions: Markdown, JSON, Markdown Table, Bullet Points, Code Block, or Plain Text. These generate instructions for a model; they cannot force an external model to comply.
3. Choose a deterministic framework:
   - **Role–Task–Context–Format:** role, task, context, format plus shared audience/tone/rules/examples.
   - **CARE:** Context, Action, Result, Examples, with role and shared controls retained.
   - **RISE:** Role, Input, Steps, Expectation, retaining the task explicitly even with custom steps. Blank steps receive a basic task/validation sequence.
4. Select Markdown headings or XML delimiters. XML values escape `&`, `<`, and `>` so context cannot close the generated XML sections. This is delimiter safety, not a guarantee against downstream prompt injection; treat source material as untrusted.
5. **Generate prompt preview**, inspect and optionally edit the preview, then **Copy prompt** or **Add prompt to note**. Copy failure selects the preview for manual copying. Append never replaces the original note or selected text and triggers the existing input/autosave/preview/sync pipeline.

Fields and output are temporary browser UI state. They are not saved automatically or sent anywhere. Adding to the note persists the prompt through the existing note save/export/sync controls. The destination is shown. Loading a starter over populated fields or regenerating over a nonempty preview asks for confirmation. Changing inputs does not silently overwrite an edited preview; explicitly generate again. The preview is the exact text copied/appended.

## Starters and variables

Starters: Summarization, Code review, Extraction, Drafting. Loading one fills the temporary fields, not your note. Customize it before generation.

Use `{{topic}}` or `[audience]` in any input. Placeholder names support letters, numbers, underscores, periods and hyphens. Optionally provide one `name=value` per line:

```text
topic=Offline-first notes
audience=New contributors
```

Bindings are substituted literally once; they are not evaluated as JavaScript and substitutions are not recursively expanded. The last duplicate binding wins. Unbound placeholders remain intact so the prompt stays reusable. XML escaping happens after substitution.

The live preview indicator reports characters and a rough `ceil(characters / 4)` token estimate. It is not a model-specific count or a guarantee of context-window fit. It includes the generated wrapper and user edits.

## Architecture and verification

No new dependencies, API calls, backend, storage schema, review queue, or separate inbox. `assets/note-template.js` provides the PWA outline and a tested equivalent lives in the dashboard's existing classic script. `assets/prompt-creator.js` handles pure assembly and shared UI; capture and prompt append share one helper. All new modules are precached with cache version v19. Dashboard version: v1.11.0.

Run `npm test`. Regression coverage includes template parity, date/intent sections, daily/dated creation, existing/cleared/copied/non-Markdown preservation and legacy boot; all frameworks and format instructions; literal bindings/unresolved variables; XML escaping; starter overwrite cancellation; preview generation/editing/estimate/manual clipboard fallback and append/input behavior on both pages. Existing sync, conflict, migration, workspace, and offline-shell tests remain enabled.

Manual checks: phone/tablet/desktop and 200% zoom, keyboard/datalist and dropdown usability, native confirmation/clipboard permission behavior, offline reload after update, new file title/outline, and GitHub sync/conflict flow. DOM tests do not replace device-level visual testing.
