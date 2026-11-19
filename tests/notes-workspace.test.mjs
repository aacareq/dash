import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { MemoryStore } from '../assets/notes-store.js';
import { NoteManager } from '../assets/notes-manager.js';
import { category, dueNotes, initNotesWorkspace, matchingNotes, memoryContext, relatedNotes } from '../assets/notes-workspace.js';

async function setup() {
  const store = new MemoryStore();
  const notes = new NoteManager(store);
  const launch = await notes.switchTo('projects/launch.md', { initialBody: 'The launch is on Thursday. - [ ] not a checklist line' });
  await notes.updateWorkspaceMetadata(launch, {
    tags: ['product'], favorite: true, due: '2026-11-19T12:00:00Z',
    images: [{ name: 'wireframe.png', blob: new Blob(['image bytes']) }]
  });
  const plan = await notes.switchTo('planning.md', { initialBody: '- [ ] Draft launch plan' });
  await notes.updateWorkspaceMetadata(plan, { tags: ['product'], links: [launch.workspaceId] });
  return { notes, store };
}

test('search, reminders, related notes, and privacy-bounded AI context', async () => {
  const { notes } = await setup();
  const records = await notes.readWorkspaceNotes();
  const [plan, launch] = records;
  assert.equal(category(plan), 'Tasks');
  assert.deepEqual(matchingNotes(records, 'THURSDAY wireframe product projects', 'favorites'), [launch]);
  assert.deepEqual(matchingNotes(records, 'no results'), []);
  assert.deepEqual(dueNotes(records, Date.parse('2026-11-20')), [launch]);
  assert.deepEqual(relatedNotes(plan, records).linked, [launch]);
  assert.deepEqual(relatedNotes(launch, records).backlinks, [plan]);
  assert.deepEqual(relatedNotes(launch, records).suggested, [plan]);
  const context = memoryContext(records, plan, 'When is the launch?');
  assert.deepEqual(context.map(note => note.source), ['planning.md', 'projects/launch.md']);
  assert.doesNotMatch(JSON.stringify(context), /wireframe|image bytes/);
});

test('metadata survives a stale editor save, reopening and file or folder renames', async () => {
  const { notes, store } = await setup();
  const stale = new NoteManager(store);
  await stale.switchTo('projects/launch.md');
  const launch = await notes.switchTo('projects/launch.md');
  await notes.updateWorkspaceMetadata(launch, { done: true });
  await notes.switchTo('planning.md');
  await stale.setBody('Updated by Scratchpad');
  await notes.renameDirectory('projects', 'archive');
  await notes.renameNote('archive/launch.md', 'archive/release.md');
  const [plan, release] = await notes.readWorkspaceNotes();
  assert.equal(release.path, 'archive/release.md');
  assert.equal(release.body, 'Updated by Scratchpad');
  assert.equal(release.workspace.images[0].name, 'wireframe.png');
  assert.equal(release.workspace.done, true);
  assert.deepEqual(dueNotes([release], Date.parse('2026-11-20')), []);
  assert.deepEqual(relatedNotes(plan, [plan, release]).linked, [release]);
});

test('workspace renders live search, persists details, and only sends inference after preview', async t => {
  const { notes } = await setup();
  const dom = new JSDOM(readFileSync(new URL('../scratchpad.html', import.meta.url), 'utf8'), {
    url: 'https://example.test/dash/scratchpad.html?notes=1'
  });
  const old = new Map();
  for (const key of ['window', 'document', 'Option', 'Event', 'localStorage', 'fetch']) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const $ = id => document.getElementById(id);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const textarea = $('scratchpad-text');
  textarea.value = notes.current.body;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Thursday [projects/launch.md]' } }] }) };
  };
  initNotesWorkspace({ notes, textarea, flushLocalSave: () => notes.setBody(textarea.value), switchNote: next => {
    textarea.value = next.body;
    document.dispatchEvent(new Event('dash-note-changed'));
  } });
  await settle();
  assert.equal($('notes-workspace').hidden, false);
  $('notes-search').value = 'wireframe';
  $('notes-search').dispatchEvent(new Event('input'));
  assert.match($('notes-results').textContent, /projects\/launch\.md/);
  assert.doesNotMatch($('notes-results').textContent, /planning\.md/);
  $('notes-tags').value = 'planning, launch';
  $('notes-metadata').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.deepEqual((await notes.readWorkspaceNotes())[0].workspace.tags, ['planning', 'launch']);
  $('notes-question').value = 'When is the launch?';
  $('notes-key').value = 'mock-key';
  $('notes-prepare').click();
  await settle();
  assert.match($('notes-ai-context').textContent, /Thursday/);
  assert.doesNotMatch($('notes-ai-context').textContent, /mock-key/);
  assert.equal(requests.length, 0);
  $('notes-send').click();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.match($('notes-answer').textContent, /Thursday/);
});
