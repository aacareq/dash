import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const studioSource = readFileSync(new URL('../assets/video-studio.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 80));

function createDashboard() {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://example.org/dash/index.html',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.Element.prototype.scrollIntoView = () => {};
      window.HTMLCanvasElement.prototype.getContext = function getContext() {
        const labels = [];
        return {
          canvas: this, labels,
          clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, save() {}, restore() {},
          translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
          bezierCurveTo() {}, stroke() {}, closePath() {}, fillText(text) { labels.push(String(text)); },
          createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} })
        };
      };
      window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
      window.HTMLDialogElement.prototype.close = function close() {
        this.open = false;
        this.dispatchEvent(new window.Event('close'));
      };
      window.document.execCommand = () => true;
      window.fetch = async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      };
      window.requestAnimationFrame = callback => {
        const id = setTimeout(() => callback(Date.now()), 0);
        id.unref?.();
        return id;
      };
      window.cancelAnimationFrame = id => clearTimeout(id);
      const originalInterval = window.setInterval.bind(window);
      window.setInterval = (...args) => { const id = originalInterval(...args); id.unref?.(); return id; };
    }
  });
  dom.window.eval(studioSource);
  return { dom, window: dom.window, errors, requests };
}

test('Video Creation is a searchable dashboard category with official evidence links', async t => {
  const { dom, window, errors } = createDashboard();
  t.after(() => dom.window.close());
  await flush();
  const nav = window.document.querySelector('[data-section="video"]');
  assert.ok(nav, 'Video Creation is in the sidebar');
  nav.click();
  const section = window.document.querySelector('#group-video');
  assert.ok(section);
  assert.equal(section.classList.contains('is-hidden'), false);
  const cards = [...section.querySelectorAll('.card')];
  assert.equal(cards.length, 6);
  assert.equal(window.document.querySelector('#cnt-video').textContent, '6');
  assert.ok(section.querySelector('.section-note').textContent.includes('no account, GPU, key'));
  assert.ok(cards.every(card => card.querySelector('.detail-panel')));
  const pixverse = cards.find(card => card.querySelector('.card-title').textContent === 'PixVerse Basic');
  assert.equal(pixverse.querySelector('.detail-panel a[href="https://app.pixverse.ai/subscribe"]').textContent, 'Provider source ↗');
  const search = window.document.querySelector('#global-search');
  search.value = 'CogVideoX';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(cards.find(card => card.querySelector('.card-title').textContent === 'Open-weight Video Checkpoints').classList.contains('is-filtered'), false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('local storyboard, prompt templates, and API key lifecycle work in the in-dashboard studio', async t => {
  const { dom, window, errors, requests } = createDashboard();
  t.after(() => dom.window.close());
  await flush();
  window.document.querySelector('[data-section="video"]').click();
  const card = window.document.querySelector('.card[data-id="video:zero-cost-video-studio"]');
  assert.ok(card);
  card.querySelector('.card-main').click();
  const dialog = window.document.querySelector('#modal-video-studio');
  assert.equal(dialog.open, true);

  const brief = window.document.querySelector('#video-brief');
  brief.value = 'A paper lantern drifts over a still lake. Moonlight touches the water.';
  window.document.querySelector('#video-build-local').click();
  assert.match(window.document.querySelector('#video-status').textContent, /Local storyboard ready/);
  assert.equal(window.document.querySelectorAll('#video-scenes .video-scene-edit').length, 3);
  assert.equal(window.document.querySelectorAll('#video-prompt-templates .video-prompt-card').length, 3);
  assert.equal(window.document.querySelector('#video-record-button').disabled, false);
  assert.equal(window.document.querySelector('#video-export-storyboard').disabled, false);

  const aspect = window.document.querySelector('#video-aspect');
  aspect.value = '9:16';
  aspect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(window.document.querySelector('#video-canvas').width, 720);
  assert.equal(window.document.querySelector('#video-canvas').height, 1280);

  const maliciousBrief = '<img src=x onerror=alert(1)> A paper lantern';
  brief.value = maliciousBrief;
  window.document.querySelector('#video-build-local').click();
  assert.equal(window.document.querySelectorAll('#video-scenes img').length, 0);
  assert.ok([...window.document.querySelectorAll('#video-scenes textarea')].some(input => input.value.includes(maliciousBrief)));

  // AI is only called after the explicit action; its key is sent in a request header, not stored or placed in a URL/body.
  requests.length = 0;
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      title: 'Lantern film', style: 'cinematic', scenes: [{ title: 'Glow', visual: 'A paper lantern glows over water', camera: 'Slow tilt', onScreenText: 'A quiet night' }]
    }) }] } }] }) };
  };
  window.document.querySelector('#video-provider').value = 'google';
  window.document.querySelector('#video-key').value = 'session-only-video-key';
  window.document.querySelector('#video-build-ai').click();
  await flush();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'session-only-video-key');
  assert.doesNotMatch(requests[0].url, /session-only-video-key/);
  assert.doesNotMatch(requests[0].options.body, /session-only-video-key/);
  assert.equal(window.localStorage.getItem('session-only-video-key'), null);
  assert.match(window.document.querySelector('#video-status').textContent, /AI storyboard received/);
  assert.equal(window.document.querySelectorAll('#video-scenes .video-scene-edit').length, 1);
  dialog.close();
  assert.equal(window.document.querySelector('#video-key').value, '');
  assert.deepEqual(errors, []);
  dom.window.close();
});
