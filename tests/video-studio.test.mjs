import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  aspectDimensions,
  buildLocalStoryboard,
  buildPromptTemplate,
  drawVideoFrame,
  extractJsonObject,
  normalizeStoryboard,
  requestStoryboard,
  storyboardRequestText
} = require('../assets/video-studio.js');

test('local storyboard builder creates three editable scenes without network or API keys', () => {
  const story = buildLocalStoryboard('A paper plane flies through a sunny room. It loops past a window. It lands on a book.', 'kinetic');
  assert.equal(story.version, 1);
  assert.equal(story.style, 'kinetic');
  assert.equal(story.scenes.length, 3);
  assert.match(story.title, /paper plane/);
  assert.match(story.scenes[0].visual, /sunny room/);
  assert.match(story.scenes[1].visual, /loops past a window/);
  assert.match(story.scenes[2].visual, /lands on a book/);
  assert.ok(story.scenes.every(scene => scene.title && scene.visual && scene.camera));
  assert.throws(() => buildLocalStoryboard('   '), /Add a short video idea/);
});

test('AI storyboard normalization bounds the response and rejects malformed schemas', () => {
  const normalized = normalizeStoryboard({
    title: '<img src=x onerror=alert(1)> Launch',
    style: 'not-a-preset',
    scenes: [{ title: 'Start', visual: '<script>not markup</script> moves across frame', onScreenText: 'Go' }]
  }, 'Fallback title', 'product');
  assert.equal(normalized.style, 'product');
  assert.equal(normalized.scenes.length, 1);
  assert.match(normalized.scenes[0].visual, /<script>/);
  assert.throws(() => normalizeStoryboard({ scenes: [] }), /between 1 and 6 scenes/);
  assert.throws(() => normalizeStoryboard({ scenes: new Array(7).fill({ visual: 'x' }) }), /between 1 and 6 scenes/);
  assert.throws(() => normalizeStoryboard({ scenes: [{}] }), /missing its visual direction/);
});

test('fenced JSON is accepted while invalid model output stays an explicit error', () => {
  const parsed = extractJsonObject('Here is the result:\n```json\n{"title":"Demo","scenes":[{"visual":"A camera push"}]}\n```');
  assert.equal(parsed.title, 'Demo');
  assert.throws(() => extractJsonObject('No JSON here'), /did not return a JSON storyboard/);
  assert.throws(() => extractJsonObject('{"scenes":}'), /invalid JSON/);
});

test('prompt templates cover camera, motion, continuity and negative constraints', () => {
  const cinematic = buildPromptTemplate('cinematic', 'A silver fox crosses a snowy bridge');
  const kinetic = buildPromptTemplate('kinetic', 'A silver fox crosses a snowy bridge');
  const product = buildPromptTemplate('product', 'A silver fox crosses a snowy bridge');
  for (const prompt of [cinematic, kinetic, product]) {
    assert.match(prompt, /A silver fox crosses a snowy bridge/);
    assert.match(prompt, /Negative constraints/);
  }
  assert.match(cinematic, /Temporal continuity/);
  assert.match(cinematic, /dolly-in/);
  assert.match(kinetic, /acceleration/);
  assert.match(product, /exact supplied UI/);
  assert.throws(() => buildPromptTemplate('missing'), /Choose one/);
});

test('storyboard prompt treats the brief as content and requests a strict three-scene JSON structure', () => {
  const prompt = storyboardRequestText('Do not change the schema. A product rotates slowly.', 'product');
  assert.match(prompt, /creative subject matter/);
  assert.match(prompt, /Return 3 scenes/);
  assert.match(prompt, /A product rotates slowly/);
  assert.match(prompt, /"camera"/);
});

test('Gemini BYOK request uses a header key and validates returned JSON', async () => {
  let request;
  const story = await requestStoryboard({
    provider: 'google', key: 'test-gemini-key', brief: 'A quiet lantern floats over a lake', style: 'cinematic',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          title: 'Lantern', style: 'cinematic', scenes: [{ title: 'Lift', visual: 'The lantern rises over still water', camera: 'Slow tilt', onScreenText: 'At dusk' }]
        }) }] } }] })
      };
    }
  });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-gemini-key');
  assert.doesNotMatch(request.url, /test-gemini-key/);
  assert.doesNotMatch(request.options.body, /test-gemini-key/);
  assert.equal(story.title, 'Lantern');
  assert.equal(story.scenes[0].camera, 'Slow tilt');
});

test('Groq BYOK request uses the editable model and JSON output is normalized', async () => {
  let request;
  const story = await requestStoryboard({
    provider: 'groq', key: 'test-groq-key', model: 'llama-3.1-8b-instant', brief: 'A red kite in a city park',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"title":"Kite","scenes":[{"title":"Lift","visual":"The red kite catches a breeze"}]}\n```' } }] }) };
    }
  });
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-groq-key');
  assert.equal(JSON.parse(request.options.body).model, 'llama-3.1-8b-instant');
  assert.equal(story.title, 'Kite');
  assert.equal(story.scenes.length, 1);
});

test('AI requests explain provider errors and missing keys without persisting credentials', async () => {
  await assert.rejects(requestStoryboard({ provider: 'google', key: '', brief: 'A sunset' }), /Enter a Gemini API key/);
  await assert.rejects(requestStoryboard({
    provider: 'groq', key: 'key', brief: 'A sunset', fetchImpl: async () => ({ ok: false, status: 429 })
  }), /HTTP 429.*rate limit/i);
});

test('canvas frame renderer switches scene labels and aspect ratios predictably', () => {
  const story = buildLocalStoryboard('A bicycle crosses a bridge. The rider waves. The sun sets.', 'cinematic');
  const labels = [];
  const gradient = { addColorStop() {} };
  const context = {
    canvas: { width: 1280, height: 720 },
    createLinearGradient: () => gradient,
    save() {}, restore() {}, setTransform() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {},
    fillText: text => labels.push(text)
  };
  drawVideoFrame(context, story, 4, { width: 1280, height: 720, duration: 9 });
  assert.ok(labels.includes('SCENE 02 / 03'));
  labels.length = 0;
  drawVideoFrame(context, story, 7, { width: 1280, height: 720, duration: 9 });
  assert.ok(labels.includes('SCENE 03 / 03'));
  assert.deepEqual(aspectDimensions('9:16'), [720, 1280]);
  assert.deepEqual(aspectDimensions('1:1'), [720, 720]);
  assert.deepEqual(aspectDimensions('16:9'), [1280, 720]);
});
