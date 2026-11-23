import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const templates = require('../assets/social-templates.js');
const motion = require('../assets/motion-studio.js');
const x = require('../assets/x-studio.js');

test('every local template uses the supplied point without a key', () => {
  for (const id of Object.keys(templates.templates)) {
    const lines = templates.render(id, 'focus', 'Write one next action.');
    assert.equal(lines.length, 3);
    assert.ok(lines.includes('Write one next action.'));
    assert.deepEqual(motion.buildLocalSocial(lines.join('\n')).scenes.map(s => s.caption), lines);
    assert.doesNotMatch(lines.join(' '), /follow me|comment yes|game-changer/i);
  }
  assert.throws(() => templates.render('tip', '', 'point'), /topic/);
  assert.throws(() => templates.render('missing', 'topic', 'point'), /template/);
});

test('both template panels load editable content, respect cancellation, and preserve preview', () => {
  for (const [file, target, mode] of [['x-studio.html', 'x-text', 'post'], ['motion.html', 'motion-idea', 'motion']]) {
    const dom = new JSDOM(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { url: 'https://example.com/dash/', runScripts: 'outside-only' });
    const { document } = dom.window;
    const panel = document.querySelector(`[data-social-templates="${mode}"]`);
    const editor = document.getElementById(target);
    let inputs = 0;
    editor.addEventListener('input', () => inputs++);
    templates.init(document); templates.init(document);
    assert.equal(panel.querySelectorAll('option').length, 4);
    panel.querySelector('[data-use-template]').click();
    assert.match(panel.querySelector('[data-template-status]').textContent, /topic/i);
    panel.querySelector('[data-example]').click();
    editor.value = 'Existing user work';
    dom.window.confirm = () => false;
    panel.querySelector('[data-use-template]').click();
    assert.equal(editor.value, 'Existing user work');
    dom.window.confirm = () => true;
    panel.querySelector('[data-use-template]').click();
    assert.match(editor.value, /Write the next action/);
    assert.equal(inputs, 1);
    assert.equal(editor.value.includes('\n\n'), mode === 'post');
    dom.window.close();
  }
});

test('AI prompt contracts apply the quality brief without breaking JSON consumers', () => {
  const p = x.buildPrompt('x_write', { topic: 'My real note: shipped an update.' });
  assert.match(p, /My real note/);
  assert.match(p, /140 characters/);
  assert.match(p, /No hashtags for X/);
  assert.match(p, /Never invent/);
  assert.match(p, /\{"posts":\[\{"text":/);
  const m = motion.socialRequestText('A specific point', 'hooklist');
  assert.match(m, /A specific point/);
  assert.match(m, /Never invent/);
  assert.match(m, /JSON/);
  assert.doesNotMatch(m, /CTA \(follow\/comment\/save\)/);
});
