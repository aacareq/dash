import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 60));
function createDashboard(storage = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://example.org/index.html', runScripts: 'dangerously', virtualConsole,
    beforeParse(window) {
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.Element.prototype.scrollIntoView = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, stroke() {}, closePath() {}, createRadialGradient: () => ({ addColorStop() {} }) });
      window.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });
      window.requestAnimationFrame = callback => { const id = setTimeout(() => callback(Date.now()), 0); id.unref?.(); return id; };
      const originalInterval = window.setInterval.bind(window);
      window.setInterval = (...args) => { const id = originalInterval(...args); id.unref?.(); return id; };
    }
  });
  return { dom, window: dom.window, errors };
}

test('personal agents bookmarklet leads pinned favorites even with saved copies', async () => {
  const { dom, window, errors } = createDashboard({ 'commandos-favorites-v1': JSON.stringify(['daily:gmail', 'bookmarklets:personal-ai-agents-always-on']) });
  await flush();
  const ids = () => [...window.document.querySelectorAll('[data-home-key="favorites"] .card')].map(card => card.dataset.id);
  assert.equal(ids()[0], 'bookmarklets:personal-ai-agents-always-on');
  assert.equal(ids()[1], 'workingon:scratchpad-quick-notes');
  assert.equal(ids().filter(id => id === ids()[0]).length, 1);
  window.document.querySelector('[data-section="favorites"]').click();
  assert.equal(ids()[0], 'bookmarklets:personal-ai-agents-always-on');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('free inference section is navigable, searchable, and links to provider evidence', async () => {
  const { dom, window, errors } = createDashboard();
  await flush();
  window.document.querySelector('[data-section="freeinference"]').click();
  const section = window.document.querySelector('#group-freeinference');
  assert.equal(section.classList.contains('is-hidden'), false);
  const cards = [...section.querySelectorAll('.card')];
  assert.equal(cards.length, 9);
  assert.equal(window.document.querySelector('#cnt-freeinference').textContent, '9');
  const nvidia = cards.find(card => card.querySelector('.card-title').textContent === 'NVIDIA Build');
  assert.equal(nvidia.querySelector('.card-main').href, 'https://build.nvidia.com/models');
  assert.ok(cards.every(card => card.querySelector('.detail-panel a[href^="https://"]')));
  const search = window.document.querySelector('#global-search');
  search.value = 'neurons'; search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(cards.find(card => card.querySelector('.card-title').textContent === 'Cloudflare Workers AI').classList.contains('is-filtered'), false);
  assert.equal(nvidia.classList.contains('is-filtered'), true);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('light mode is togglable, persistent and exposed to assistive technology', async () => {
  const first = createDashboard();
  await flush();
  const button = first.window.document.querySelector('#theme-toggle');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click();
  assert.equal(first.window.document.body.classList.contains('light'), true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.textContent, /Light mode/);
  assert.equal(first.window.localStorage.getItem('commandos-theme'), 'light');
  const saved = first.window.localStorage.getItem('commandos-theme');
  first.dom.window.close();
  const second = createDashboard({ 'commandos-theme': saved });
  await flush();
  const nextButton = second.window.document.querySelector('#theme-toggle');
  assert.equal(second.window.document.body.classList.contains('light'), true);
  assert.equal(nextButton.getAttribute('aria-pressed'), 'true');
  nextButton.click();
  assert.equal(second.window.document.body.classList.contains('light'), false);
  assert.equal(second.window.localStorage.getItem('commandos-theme'), 'dark');
  assert.equal(nextButton.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(second.errors, []);
  second.dom.window.close();
});
