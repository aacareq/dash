import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createEditor } from '../assets/editor.js';
import { formatCapture, initCapture } from '../assets/capture.js';

test('PWA link toolbar preserves selection, emits input, validates URL, and cancels safely', () => {
  const dom = new JSDOM('<textarea>Hello world</textarea><div id="tools"><button data-md="link">Link</button></div><div id="preview" hidden></div><button id="toggle"></button>');
  const { window } = dom;
  const old = { document: globalThis.document, window: globalThis.window, Event: globalThis.Event };
  Object.assign(globalThis, { document: window.document, window, Event: window.Event });
  try {
    const textarea = window.document.querySelector('textarea'); let inputs = 0;
    createEditor({ textarea, toolbar: window.document.querySelector('#tools'), preview: window.document.querySelector('#preview'), previewToggle: window.document.querySelector('#toggle'), onInput: () => inputs++ });
    textarea.setSelectionRange(6, 11); window.prompt = () => 'https://example.com/a(b)';
    window.document.querySelector('[data-md]').click();
    assert.equal(textarea.value, 'Hello [world](https://example.com/a%28b%29)'); assert.equal(inputs, 1);
    window.prompt = () => null; window.document.querySelector('[data-md]').click(); assert.equal(inputs, 1);
    window.prompt = () => 'javascript:alert(1)'; window.alert = () => {}; window.document.querySelector('[data-md]').click(); assert.equal(inputs, 1);
  } finally { Object.assign(globalThis, old); dom.window.close(); }
});
test('home help button opens native modal and returns focus on close; old broken panel is gone', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.com/dash/' });
  const { window } = dom; const dialog = window.document.querySelector('#dashboard-help');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  const script = [...window.document.scripts].find(s => s.textContent.includes("const help = document.getElementById('dashboard-help')"));
  window.eval(script.textContent);
  const opener = window.document.querySelector('#dashboard-help-open'); opener.click(); assert.equal(dialog.hasAttribute('open'), true);
  dialog.close(); assert.equal(window.document.activeElement, opener);
  assert.match(dialog.textContent, /Ideas for performance/);
  assert.doesNotMatch(readFileSync(new URL('../scratchpad.html', import.meta.url), 'utf8'), /scratchpad-help-modal/);
  dom.window.close();
});

test('help content fits its dialog rather than requesting an independent viewport width', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const { window } = dom;
  const dialog = window.document.querySelector('#dashboard-help');
  const guide = dialog.querySelector('.help-guide');
  const style = window.getComputedStyle(guide);
  assert.equal(style.width, '100%');
  assert.equal(style.maxWidth, '100%');
  assert.equal(style.boxSizing, 'border-box');
  assert.equal(style.overflowY, 'auto');
  assert.equal(style.overflowWrap, 'anywhere');
  assert.match(window.getComputedStyle(dialog).width, /850px/);
  assert.equal(window.getComputedStyle(dialog).maxWidth, '992px'); // 1024px viewport minus 2rem
  assert.equal(window.getComputedStyle(dialog.querySelector('ul')).paddingInlineStart, '22.4px');
  dom.window.close();
});

test('capture formatter keeps content and optional portable metadata without inventing a schema', () => {
  assert.equal(formatCapture({ text: '  ' }), '');
  assert.equal(formatCapture({ text: 'A thought' }), 'A thought');
  assert.equal(formatCapture({ text: 'A thought', source: 'Book\nAuthor', intent: 'Reference', timestamp: true }, new Date('2026-11-13T12:00:00Z')), 'A thought\n\nIntent: Reference\n\nSource: Book Author\n\nCaptured: 2026-11-13T12:00:00.000Z');
  assert.equal(formatCapture({ text: 'Text', intent: 'arbitrary' }), 'Text');
});

for (const page of ['index.html', 'scratchpad.html']) {
  test(`${page}: capture appends to the existing note and emits normal input; no review UI or data changes`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const dom = new JSDOM(html, { url: `https://example.com/dash/${page}` });
    const doc = dom.window.document;
    try {
      const root = doc.querySelector('#scratchpad-capture');
      const note = doc.querySelector('#scratchpad-text');
      assert.ok(root); assert.equal(root.open, false); assert.equal(doc.querySelector('#smart-review'), null);
      assert.doesNotMatch(html, /Smart Review|smart-review|review\.js/);
      dom.window.localStorage.setItem('dash-smart-review-v1', '[{"text":"legacy data"}]');
      note.value = 'Keep this existing note'; note.setSelectionRange(0, 4);
      let changes = 0; note.addEventListener('input', () => changes++);
      let destination = 'notes/one.md';
      initCapture({ root, textarea: note, target: () => destination });
      const field = key => root.querySelector(`[data-capture="${key}"]`);
      assert.deepEqual([...field('intent').options].map(o => o.textContent), ['Plain Note', 'Task', 'Inspiration', 'Reference', 'Prompt Seed']);
      assert.equal(changes, 0);
      root.querySelector('[data-add]').click(); assert.equal(changes, 0); assert.match(root.textContent, /Enter some content first/);
      field('text').value = '<script>alert(1)</script> captured idea';
      field('source').value = 'https://example.com'; field('intent').value = 'Prompt Seed';
      root.querySelector('[data-add]').click();
      assert.equal(changes, 1);
      assert.equal(note.value, 'Keep this existing note\n\n<script>alert(1)</script> captured idea\n\nIntent: Prompt Seed\n\nSource: https://example.com\n');
      assert.equal(field('text').value, ''); assert.equal(field('source').value, '');
      assert.match(root.querySelector('[role=status]').textContent, /Added to notes\/one.md/);
      assert.equal(root.querySelector('script'), null); // Capture text never becomes live HTML.
      destination = 'notes/two.md'; root.dispatchEvent(new dom.window.Event('focusin'));
      assert.match(root.querySelector('[data-target]').textContent, /two.md/);
      field('text').value = 'Another capture'; root.querySelector('[data-add]').click();
      assert.ok(note.value.endsWith('\n\nAnother capture\n')); assert.equal(changes, 2);
      assert.equal(dom.window.localStorage.getItem('dash-smart-review-v1'), '[{"text":"legacy data"}]');
    } finally { dom.window.close(); }
  });
}

test('clipboard is user-initiated, drafts are append-only, permission denial and asynchronous races are safe', async () => {
  const dom = new JSDOM('<details id="capture"></details><textarea id="note">Original</textarea>', { url: 'https://example.com/dash/' });
  const doc = dom.window.document; let reads = 0, resolveRead;
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { readText: () => { reads++; return new Promise(resolve => { resolveRead = resolve; }); } } });
  try {
    const root = doc.querySelector('#capture'); const note = doc.querySelector('#note');
    initCapture({ root, textarea: note }); const draft = root.querySelector('[data-capture=text]');
    assert.equal(reads, 0);
    dom.window.dispatchEvent(new dom.window.Event('focus')); assert.equal(reads, 0);
    draft.value = 'My draft'; const button = root.querySelector('[data-paste]');
    button.click(); assert.equal(reads, 1); assert.equal(button.disabled, true);
    resolveRead('Clipboard content'); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(draft.value, 'My draft\n\nClipboard content'); assert.equal(note.value, 'Original');
    button.click(); draft.value = 'Changed while reading'; resolveRead('Stale clipboard'); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(draft.value, 'Changed while reading'); assert.match(root.querySelector('[role=status]').textContent, /Draft changed/);
    dom.window.navigator.clipboard.readText = async () => { throw new Error('denied'); };
    button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(draft.value, 'Changed while reading'); assert.equal(note.value, 'Original');
    assert.match(root.querySelector('[role=status]').textContent, /paste manually/);
    assert.equal(button.disabled, false);
  } finally { dom.window.close(); }
});
