import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { classify, capture, due, expire, act, DAY } from '../assets/review.js';
import { createEditor } from '../assets/editor.js';

test('classification: action intent wins over URL, quotes and prose are evergreen', () => {
  for (const text of ['Call Alex', '- [ ] buy food', 'Fix https://example.com']) assert.equal(classify(text), 'Task');
  assert.equal(classify('https://example.com'), 'Follow-Up');
  assert.equal(classify('> Inspiration'), 'Spark');
});
test('capture deduplicates unchanged text, refreshes edits, and isolates note paths', () => {
  const items = capture([], 'Call Alex\n\nhttps://example.com', 'one.md', 0);
  capture(items, 'Call Alex\n\nhttps://example.com', 'one.md', DAY);
  assert.equal(items.length, 2); assert.equal(items[0].lastTouchedAt, 0);
  capture(items, 'Call Jo\n\nhttps://example.com', 'one.md', DAY);
  assert.equal(items.length, 2); assert.equal(items[0].lastTouchedAt, DAY);
  capture(items, 'Call Jo', 'two.md', DAY); assert.equal(items.length, 3);
});
test('decay boundaries, autoarchive, snooze escalation and evergreen references', () => {
  const items = capture([], 'Call Alex\n\nhttps://example.com\n\nA spark', 'one', 0);
  const [task, link, spark] = items;
  assert.equal(due(task, 3 * DAY - 1), false); assert.equal(due(task, 3 * DAY), true);
  assert.equal(due(link, 7 * DAY), true); assert.equal(due(spark, 100 * DAY), false);
  act(task, 'snooze', 3 * DAY); assert.equal(due(task, 9 * DAY), false); assert.equal(due(task, 10 * DAY), true);
  act(task, 'snooze', 10 * DAY); act(task, 'snooze', 17 * DAY); assert.equal(task.snoozeCount, 3);
  act(task, 'reference', 24 * DAY); assert.equal(task.type, 'Spark'); assert.equal(due(task, 100 * DAY), false);
  expire(items, 30 * DAY); assert.equal(link.archived, true); assert.equal(spark.archived, false);
  act(link, 'restore', 30 * DAY); assert.equal(link.archived, false); assert.equal(due(link, 30 * DAY), false);
});
test('mutate retains the original and creates an offline summary; compost and promote are reversible', () => {
  const [link] = capture([], 'https://example.com', 'one', 0);
  assert.equal(act(link, 'mutate', DAY, ''), null); assert.equal(link.archived, false);
  const summary = act(link, 'mutate', DAY, '# Useful idea');
  assert.equal(summary.type, 'Spark'); assert.equal(summary.text, '# Useful idea'); assert.equal(link.archived, true);
  assert.equal(link.original, 'https://example.com');
  act(summary, 'promote', DAY); assert.equal(summary.type, 'Task');
  act(summary, 'compost', DAY); assert.equal(summary.archived, true);
  act(summary, 'restore', DAY); assert.equal(summary.archived, false);
});
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

test('review UI renders a focused queue, snoozes, archives safely and searches stored text', async () => {
  const { initReview } = await import('../assets/review.js');
  const dom = new JSDOM('<section id="root"></section><textarea></textarea>', { url: 'https://example.com/dash/' });
  const { window } = dom;
  const old = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  Object.assign(globalThis, { document: window.document, window, localStorage: window.localStorage });
  try {
    const items = capture([], 'Call Alex\n\nhttps://example.com\n\n<img src=x onerror=alert(1)>', 'test.md', Date.now() - 8 * DAY);
    localStorage.setItem('dash-smart-review-v1', JSON.stringify(items));
    const root = window.document.querySelector('#root');
    initReview({ root, textarea: window.document.querySelector('textarea'), source: () => 'test.md' });
    assert.equal(root.querySelector('#review-pill').textContent, 'Needs Attention (2)');
    root.querySelector('#review-pill').click(); assert.equal(root.querySelector('#review-panel').hidden, false);
    [...root.querySelectorAll('button')].find(b => b.textContent === 'Defer / Snooze 1 week').click();
    assert.equal(root.querySelector('#review-pill').textContent, 'Needs Attention (1)');
    [...root.querySelectorAll('button')].find(b => b.textContent === 'Compost').click();
    assert.equal(root.querySelector('#review-pill').textContent, 'Needs Attention (0)');
    assert.match(root.querySelector('.review-archive').textContent, /https:\/\/example.com/);
    const search = root.querySelector('input'); search.value = 'missing'; search.dispatchEvent(new window.Event('input'));
    assert.equal(root.querySelector('.review-archive').textContent, '');
    assert.equal(root.querySelector('img'), null);
    const saved = JSON.parse(localStorage.getItem('dash-smart-review-v1'));
    assert.equal(saved[0].snoozeCount, 1); assert.equal(saved[1].archived, true);
  } finally { Object.assign(globalThis, old); dom.window.close(); }
});
