import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('../video-workshop.html', import.meta.url), 'utf8');
const encoder = new TextEncoder();

function createLab() {
  const requests = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://example.org/dash/video-workshop.html',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.Blob = Blob;
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.fetch = async (...args) => { requests.push(args); throw new Error('Network must not be used by the local lab'); };
      window.HTMLCanvasElement.prototype.getContext = function getContext() {
        const gradient = { addColorStop() {} };
        return {
          canvas: this,
          clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, stroke() {},
          save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {}, moveTo() {}, lineTo() {},
          quadraticCurveTo() {}, bezierCurveTo() {}, closePath() {}, strokeRect() {}, drawImage() {}, fillText() {}, strokeText() {},
          createLinearGradient: () => gradient, createRadialGradient: () => gradient
        };
      };
      window.HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
        callback(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: type || 'image/png' }));
      };
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
      window.URL.createObjectURL = () => 'blob:https://example.org/test';
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function click() { this.dataset.clicked = 'true'; };
      window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 1);
      window.cancelAnimationFrame = id => clearTimeout(id);
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    }
  });
  return { dom, window: dom.window, requests, errors };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 25));

test('the standalone lab boots without remote scripts, loads four local scenes, and exposes useful frame specs', t => {
  const { dom, window, requests, errors } = createLab();
  t.after(() => dom.window.close());
  assert.equal(window.document.querySelectorAll('script[src]').length, 0);
  assert.equal(window.document.querySelectorAll('link[rel="stylesheet"][href^="http"]').length, 0);
  assert.equal(window.MotionLab.getSceneCount(), 4);
  assert.equal(window.document.querySelector('#preview').getAttribute('role'), 'img');
  assert.equal(window.document.querySelector('#frame-list .frame-select').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(Array.from(window.MotionLab.dimensions('16:9', 1080)), [1920, 1080]);
  assert.deepEqual(Array.from(window.MotionLab.dimensions('9:16', 720)), [720, 1280]);
  assert.deepEqual(Array.from(window.MotionLab.dimensions('1:1', 1080)), [1080, 1080]);
  assert.equal(requests.length, 0);
  assert.match(window.document.querySelector('#studio-status').textContent, /without network calls/i);
  assert.deepEqual(errors, []);
});

test('local frame generator, editing, ordering, filters, and recipe selector work without network', async t => {
  const { dom, window, requests, errors } = createLab();
  t.after(() => dom.window.close());

  const idea = window.document.querySelector('#idea');
  idea.value = 'A glass observatory floats above a blue ocean. A comet passes through the rings. Dawn paints the horizon.';
  window.document.querySelector('#scene-count').value = '3';
  window.document.querySelector('#generate-frames').click();
  assert.equal(window.MotionLab.getSceneCount(), 3);
  assert.equal(window.document.querySelectorAll('#frame-list .frame-item').length, 3);
  assert.match(window.document.querySelector('#studio-status').textContent, /generated locally/i);
  assert.match(window.document.querySelector('.frame-item textarea[data-field="prompt"]').value, /observatory/);

  const title = window.document.querySelector('.frame-item input[data-field="title"]');
  title.value = '<img src=x onerror=alert(1)> Safe text';
  title.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(window.document.querySelectorAll('#frame-list img').length, 0);
  assert.equal(window.document.querySelector('.frame-item input[data-field="title"]').value, '<img src=x onerror=alert(1)> Safe text');

  window.document.querySelector('#add-frame').click();
  assert.equal(window.MotionLab.getSceneCount(), 4);
  window.document.querySelector('.frame-item [data-action="move-up"]').click();
  assert.equal(window.document.querySelectorAll('#frame-list .frame-item').length, 4);
  window.document.querySelector('.frame-item [data-action="remove"]').click();
  assert.equal(window.MotionLab.getSceneCount(), 3);

  window.document.querySelector('[data-route-filter="cloud"]').click();
  assert.equal(window.document.querySelector('.method-card[data-method~="cloud"]').hidden, false);
  assert.equal([...window.document.querySelectorAll('.method-card')].filter(card => !card.hidden).every(card => card.dataset.method.split(/\s+/).includes('cloud')), true);
  window.document.querySelector('[data-route-filter="all"]').click();
  assert.equal([...window.document.querySelectorAll('.method-card')].every(card => !card.hidden), true);
  window.document.querySelector('[data-route-filter="local"]').click();
  const localModels = [...window.document.querySelectorAll('.method-card')].find(card => card.querySelector('h3')?.textContent === 'Open-weight video generation locally');
  assert.equal(localModels.hidden, false);
  assert.equal([...window.document.querySelectorAll('.method-card')].filter(card => !card.hidden).every(card => card.dataset.method.split(/\s+/).includes('local')), true);
  window.document.querySelector('[data-route-filter="all"]').click();

  const goal = window.document.querySelector('#recipe-goal');
  goal.value = 'photoreal'; goal.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(window.document.querySelector('#recipe-result h3').textContent, /owned compute/i);
  assert.equal(requests.length, 0);
  assert.deepEqual(errors, []);
  await flush();
});

test('playback prevents timeline edits until the user stops it', async t => {
  const { dom, window, errors } = createLab();
  t.after(() => dom.window.close());
  const idea = window.document.querySelector('#idea');
  window.document.querySelector('#play-preview').click();
  assert.equal(idea.disabled, true);
  assert.equal(window.document.querySelector('#generate-frames').disabled, true);
  assert.equal(window.document.querySelector('#frame-list textarea').disabled, true);
  assert.equal(window.document.querySelector('#stop-preview').disabled, false);
  window.document.querySelector('#stop-preview').click();
  assert.equal(idea.disabled, false);
  assert.equal(window.document.querySelector('#generate-frames').disabled, false);
  assert.equal(window.document.querySelector('#frame-list textarea').disabled, false);
  assert.equal(window.document.querySelector('#stop-preview').disabled, true);
  await flush();
  assert.deepEqual(errors, []);
});

test('local project JSON imports settings and text safely, and rejects oversized files', async t => {
  const { dom, window, requests, errors } = createLab();
  t.after(() => dom.window.close());
  const project = window.MotionLab.getProject();
  project.title = '<script>alert(1)</script> observatory';
  project.settings.aspect = '9:16';
  project.settings.resolution = 1080;
  project.settings.palette = 'rose';
  project.settings.style = 'poster';
  project.settings.secondsPerScene = 3;
  project.scenes = [
    { title: '<img src=x onerror=alert(1)>', caption: 'Safe caption', prompt: 'A moon over water', seed: 7 },
    { title: 'Dawn', caption: 'The horizon glows', prompt: 'Soft sunrise', seed: 8 }
  ];
  const input = window.document.querySelector('#import-project');
  const file = new Blob([JSON.stringify(project)], { type: 'application/json' });
  Object.defineProperty(file, 'name', { value: 'motion-project.json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(window.MotionLab.getSceneCount(), 2);
  assert.equal(window.MotionLab.getProject().settings.aspect, '9:16');
  assert.equal(window.MotionLab.getProject().settings.resolution, 1080);
  assert.equal(window.document.querySelectorAll('#frame-list img, #frame-list [onerror]').length, 0);
  assert.equal(window.document.querySelector('#frame-list input[data-field="title"]').value, '<img src=x onerror=alert(1)>');
  assert.deepEqual(requests, []);

  const oversized = new Blob(['x'.repeat(2 * 1024 * 1024 + 1)], { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [oversized] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.match(window.document.querySelector('#studio-status').textContent, /smaller than 2 MB/i);
  assert.deepEqual(errors, []);
});

test('PNG frame pack is a valid stored ZIP with CRC-32 and project notes', async t => {
  const { dom, window, errors } = createLab();
  t.after(() => dom.window.close());
  assert.equal(window.MotionLab.crc32(encoder.encode('123456789')), 0xcbf43926);
  const sampleZip = window.MotionLab.zipStored([
    { name: 'hello.txt', data: 'zero cost' },
    { name: 'frame.bin', data: new window.Uint8Array([0, 1, 2, 255]) }
  ]);
  const header = new Uint8Array(await sampleZip.arrayBuffer());
  assert.deepEqual([...header.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.notEqual(Buffer.from(header).indexOf(Buffer.from([0, 1, 2, 255])), -1);
  assert.ok([...header].some((byte, index) => byte === 0x50 && header[index + 1] === 0x4b && header[index + 2] === 0x01 && header[index + 3] === 0x02));

  window.document.querySelector('#export-frame-pack').click();
  await flush();
  assert.match(window.document.querySelector('#studio-status').textContent, /PNG scene frames.*packed locally/i);
  assert.deepEqual(errors, []);
});

test('research copy distinguishes local inference from quota-based services and includes official sources', t => {
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  assert.match(document.querySelector('#research').textContent, /free tier.*image-generation models/i);
  assert.match(document.querySelector('#research').textContent, /5 GPU minutes\/day/i);
  assert.match(document.querySelector('#research').textContent, /not guaranteed/i);
  assert.ok(document.querySelector('a[href="https://ai.google.dev/gemini-api/docs/pricing"]'));
  assert.ok(document.querySelector('a[href="https://huggingface.co/docs/hub/en/spaces-zerogpu"]'));
  assert.ok(document.querySelector('a[href="https://www.shotcut.org/"]'));
  assert.ok(document.querySelector('a[href="https://websd.mlc.ai/"]'));
  assert.ok(document.querySelector('a[href="https://github.com/Lightricks/LTX-2"]'));
  assert.ok(document.querySelector('a[href="https://github.com/Wan-Video/Wan2.2"]'));
  assert.match(document.querySelector('#research').textContent, /66 GiB/);
  assert.match(document.querySelector('#research').textContent, /80 GB VRAM/);
  assert.match(document.querySelector('#research').textContent, /24 fps/);
  assert.equal(document.querySelectorAll('script[src]').length, 0);
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /"\.\/video-workshop\.html"/);
  assert.match(sw, /dash-scratch-v24/);
});
