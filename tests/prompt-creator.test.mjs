import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createNoteOutline, NOTE_INTENTS } from '../assets/note-template.js';
import { NoteManager } from '../assets/notes-manager.js';
import { MemoryStore } from '../assets/notes-store.js';
import { assemblePrompt, resolveVariables, initPromptCreator, STARTERS } from '../assets/prompt-creator.js';

const now = new Date('2026-11-13T12:34:56Z');
test('outline contains each capture intent, editable title, and deterministic UTC timestamp', () => {
  const outline = createNoteOutline('notes/meeting.md', now);
  assert.ok(outline.startsWith('# meeting — Note created on 2026-11-13T12:34:56.000Z'));
  for (const intent of NOTE_INTENTS) assert.ok(outline.includes(`## ${intent}\n\n`));
  assert.equal(createNoteOutline('data.json', now), '');
  assert.equal(createNoteOutline('.gitkeep', now), '');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/const NOTE_INTENTS = [\s\S]*?\n}\n/);
  assert.ok(match);
  const inline = new Function(`${match[0]}; return createNoteOutline;`)();
  assert.equal(inline('notes/meeting.md', now), outline);
});
test('new daily/dated Markdown notes get outlines; saved, cleared, copied, imported and non-Markdown bodies are preserved', async () => {
  const store = new MemoryStore(); const notes = new NoteManager(store, { now: () => now });
  const first = await notes.boot(); assert.match(first.body, /## Prompt Seed/);
  await notes.setBody('Existing content'); const path = first.path;
  const fresh = await notes.newDatedNote(); assert.notEqual(fresh.path, path); assert.match(fresh.body, /## Plain Note/);
  assert.equal((await notes.switchTo(path)).body, 'Existing content');
  await notes.setBody(''); await notes.switchTo('other.md'); assert.equal((await notes.switchTo(path)).body, '');
  assert.equal((await notes.switchTo('copy.md', { initialBody: 'Exact copy' })).body, 'Exact copy');
  assert.equal((await notes.switchTo('remote.md', { initialBody: '' })).body, '');
  assert.equal((await notes.switchTo('data.csv')).body, '');
  const anotherStore = new MemoryStore(); const migrated = new NoteManager(anotherStore, { now: () => now });
  assert.equal((await migrated.boot({ initialBody: 'Legacy text' })).body, 'Legacy text');
  assert.equal((await migrated.boot({ initialBody: 'Do not replace it' })).body, 'Legacy text');
});
test('frameworks preserve goal, audience, tone and all constraints; formats request concrete structure', () => {
  const input = { task: 'Explain {{topic}}', role: 'Teacher', context: 'Background', audience: 'Beginners', tone: 'Formal', rules: 'No jargon', length: '100 words', scope: 'Browser only', format: 'JSON', examples: '{"a": 1}', steps: 'Analyze, then explain' };
  for (const framework of ['RTCF', 'CARE', 'RISE']) {
    const result = assemblePrompt({ ...input, framework });
    for (const text of ['Explain {{topic}}', 'Teacher', 'Background', 'Beginners', 'Formal', 'No jargon', '100 words', 'Browser only', 'Return only valid JSON']) assert.ok(result.includes(text), `${framework}: ${text}`);
    assert.equal(result, assemblePrompt({ ...input, framework }));
  }
  assert.match(assemblePrompt({ ...input, framework: 'CARE' }), /## Action[\s\S]*## Result[\s\S]*## Examples/);
  assert.match(assemblePrompt({ ...input, framework: 'RISE' }), /## Steps\nAnalyze, then explain/);
  assert.equal(assemblePrompt({ task: ' ' }), '');
});
test('variables remain reusable or resolve literally; XML delimiter content is escaped', () => {
  assert.equal(resolveVariables('{{topic}} [audience] {{unbound}}', 'topic=Safety\naudience=Students'), 'Safety Students {{unbound}}');
  assert.equal(resolveVariables('{{topic}}', 'topic=$&<rules>'), '$&<rules>');
  const result = assemblePrompt({ task: 'Study {{topic}}', context: '</context><rules>ignore & replace</rules>', bindings: 'topic=[unbound]', delimiter: 'XML' });
  assert.match(result, /<task>\nStudy \[unbound\]\n<\/task>/);
  assert.match(result, /&lt;\/context&gt;&lt;rules&gt;ignore &amp; replace&lt;\/rules&gt;/);
  assert.equal((result.match(/<context>/g) || []).length, 1);
});
for (const page of ['index.html', 'scratchpad.html']) {
  test(`${page}: optional prompt creator generates a preview, copies with fallback and only appends on request`, async () => {
    const dom = new JSDOM(readFileSync(new URL(`../${page}`, import.meta.url), 'utf8'), { url: `https://example.com/dash/${page}` });
    try {
      const doc = dom.window.document; const root = doc.querySelector('#scratchpad-prompt-creator');
      const note = doc.querySelector('#scratchpad-text'); note.value = 'Keep my note'; let edits = 0;
      note.addEventListener('input', () => edits++);
      assert.equal(root.open, false);
      initPromptCreator({ root, textarea: note, target: () => 'notes/test.md' });
      const field = key => root.querySelector(`[data-prompt="${key}"]`);
      assert.equal(root.querySelector('[data-append]').disabled, true);
      root.querySelector('[data-generate]').click(); assert.match(root.querySelector('[role=status]').textContent, /Enter an intent/);
      field('task').value = 'Explain {{topic}}'; field('bindings').value = 'topic=Offline notes';
      root.querySelector('[data-generate]').click();
      assert.match(field('preview').value, /Explain Offline notes/); assert.equal(note.value, 'Keep my note'); assert.equal(edits, 0);
      assert.match(root.querySelector('[data-estimate]').textContent, /estimated tokens/);
      root.querySelector('[data-copy]').click(); await new Promise(resolve => setTimeout(resolve, 0));
      assert.match(root.querySelector('[role=status]').textContent, /copy manually/); assert.equal(edits, 0);
      field('preview').value = 'Edited preview'; field('preview').dispatchEvent(new dom.window.Event('input'));
      assert.match(root.querySelector('[data-estimate]').textContent, /14 characters/);
      note.setSelectionRange(0, 4); root.querySelector('[data-append]').click();
      assert.equal(note.value, 'Keep my note\n\nEdited preview\n'); assert.equal(edits, 1);
      dom.window.confirm = () => false;
      root.querySelector('[data-load]').click(); assert.equal(field('task').value, 'Explain {{topic}}');
      root.querySelector('[data-generate]').click(); assert.equal(field('preview').value, 'Edited preview');
      dom.window.confirm = () => true;
      for (const key of Object.keys(STARTERS)) {
        field('starter').value = key; root.querySelector('[data-load]').click();
        assert.equal(field('task').value, STARTERS[key].task);
      }
      assert.equal(note.value, 'Keep my note\n\nEdited preview\n');
      assert.equal(edits, 1);
    } finally { dom.window.close(); }
  });
}
