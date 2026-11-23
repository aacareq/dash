import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);

const loadMotion = () => {
  delete require.cache[require.resolve('../assets/motion-studio.js')];
  return require('../assets/motion-studio.js');
};

describe('Motion Studio constants', () => {
  test('exports FORMATS/PRESETS/PALETTES/CAPTION_STYLES/PROVIDERS', () => {
    const M = loadMotion();
    assert.equal(M.VERSION, 1);
    assert.equal(Object.keys(M.FORMATS).length, 4);
    assert.ok(M.FORMATS['9:16'].dims[0] === 1080 && M.FORMATS['9:16'].dims[1] === 1920);
    assert.equal(Object.keys(M.PRESETS).length, 6);
    assert.equal(Object.keys(M.PALETTES).length, 6);
    assert.equal(Object.keys(M.CAPTION_STYLES).length, 4);
    assert.equal(Object.keys(M.PROVIDERS).length, 4);
    // groq + google + openrouter + huggingface
    assert.ok(M.PROVIDERS.groq.endpoint);
    assert.ok(M.PROVIDERS.google.endpoint('gemini-2.0-flash').includes('generativelanguage'));
  });

  test('buildLocalSocial creates 2-5 scenes per preset', () => {
    const M = loadMotion();
    const hook = M.buildLocalSocial('3 habits for focus', 'hooklist');
    assert.ok(hook.scenes.length >= 2 && hook.scenes.length <= 8);
    assert.ok(hook.title);
    assert.ok(hook.scenes.every(s=> s.title && s.caption && typeof s.durationSec === 'number'));
    const ba = M.buildLocalSocial('before after weight loss', 'beforeafter');
    assert.ok(ba.scenes.length >= 2);
    assert.throws(()=> M.buildLocalSocial('   '), /Add an idea/);
  });

  test('normalizeSocial bounds scenes 2-8 and cleans text', () => {
    const M = loadMotion();
    const norm = M.normalizeSocial({ title: 'Hi', scenes: [{ title:'A', caption:'hello world hello world hello world', imagePrompt:'a cat' }, { title:'B', caption:'second scene caption with enough words here', imagePrompt:'dog' }] }, 'fallback');
    assert.equal(norm.scenes.length, 2);
    assert.equal(typeof norm.scenes[0].durationSec, 'number');
    assert.throws(()=> M.normalizeSocial({ scenes: [] }), /2.*8/);
    assert.throws(()=> M.normalizeSocial({ scenes: [{ title:'A', caption:'hi' }] }), /2/);
    assert.throws(()=> M.normalizeSocial({ scenes: [{ title:'', caption:'' }, { title:'B', caption:'' }] }), /caption/);
  });

  test('extractJson handles fenced json', () => {
    const M = loadMotion();
    const obj = M.extractJson('```json\n{"title":"Hi","scenes":[{"caption":"yo"}]}\n```');
    assert.equal(obj.title, 'Hi');
    assert.throws(()=> M.extractJson('no json'), /No JSON/);
  });

  test('pollinationsUrl builds valid CDN url', () => {
    const M = loadMotion();
    const url = M.pollinationsUrl('a cute cat, vibrant background', 1080, 1920, 42);
    assert.ok(url.startsWith('https://image.pollinations.ai/p/'));
    assert.ok(url.includes('width=1080'));
    assert.ok(url.includes('nologo=true'));
    assert.ok(url.includes('seed=42'));
  });

  test('buildImagePrompt appends palette and aspect', () => {
    const M = loadMotion();
    const p = M.buildImagePrompt('a cat on sofa', { palette:'ocean', format:'9:16' });
    assert.ok(p.includes('a cat on sofa'));
    assert.ok(p.toLowerCase().includes('vertical') || p.includes('9:16') || p.length > 20);
  });

  test('aspectForSocial returns dims', () => {
    const M = loadMotion();
    assert.deepEqual(M.aspectForSocial('9:16'), [1080,1920]);
    assert.deepEqual(M.aspectForSocial('1:1'), [1080,1080]);
    assert.deepEqual(M.aspectForSocial('bogus'), [1080,1920]);
  });

  test('drawMotionFrame draws with mock context', () => {
    const M = loadMotion();
    const social = M.buildLocalSocial('morning habits for focus', 'hooklist');
    let fillRect=0, fillText=0;
    const grad = { addColorStop(){} };
    const ctx = {
      canvas: { width:1080, height:1920 },
      save(){}, restore(){}, setTransform(){}, scale(){}, translate(){}, clearRect(){},
      createLinearGradient: ()=> grad, createRadialGradient: ()=> grad,
      fillRect(){ fillRect++; }, fillText(){ fillText++; }, strokeText(){}, strokeRect(){},
      beginPath(){}, arc(){}, fill(){}, closePath(){}, clip(){}, drawImage(){},
      measureText: (t)=> ({ width: t.length*10 }),
      get globalAlpha(){ return 1; }, set globalAlpha(v){},
      get fillStyle(){ return '#fff'; }, set fillStyle(v){},
      get strokeStyle(){ return '#000'; }, set strokeStyle(v){},
      get lineWidth(){ return 1; }, set lineWidth(v){},
      get font(){ return '12px sans-serif'; }, set font(v){},
      get textAlign(){ return 'center'; }, set textAlign(v){},
      get textBaseline(){ return 'middle'; }, set textBaseline(v){}
    };
    M.drawMotionFrame(ctx, social, 0, { progress:0.5, palette:'electric', captionStyle:'hormozi', motion:'slow', handle:'@you', imageMap:{}, totalScenes: social.scenes.length });
    assert.ok(fillRect>0, 'should draw background');
    assert.ok(fillText>0, 'should draw captions/handle');
  });

  test('socialRequestText mentions JSON and palette/format', () => {
    const M = loadMotion();
    const txt = M.socialRequestText('test idea about focus', { preset:'hooklist', palette:'electric', format:'9:16' });
    assert.match(txt, /test idea about focus/);
    assert.match(txt, /JSON/);
    assert.match(txt, /9:16|vertical/i);
  });

  test('requestSocialScript BYOK validation and error messages', async () => {
    const M = loadMotion();
    await assert.rejects(()=> M.requestSocialScript({ provider:'google', key:'', brief:'hi' }), /key required/i);
    await assert.rejects(()=> M.requestSocialScript({ provider:'groq', key:'k', brief:'hi', fetchImpl: async()=> ({ ok:false, status:429, statusText:'Too Many Requests', text: async()=>'' }) }), /429/);
    // OpenRouter uses openai endpoint
    let urlCaptured='';
    await M.requestSocialScript({
      provider:'openrouter', key:'tok', brief:'hi there topic',
      fetchImpl: async (url, opts) => {
        urlCaptured = url;
        return { ok:true, json: async()=> ({ choices:[{ message:{ content: JSON.stringify({ title:'T', scenes:[{ title:'A', caption:'hello world and more words here okay', imagePrompt:'a cat' }, { title:'B', caption:'second scene for motion validation ok', imagePrompt:'dog' }] }) } }] }) };
      }
    });
    assert.ok(urlCaptured.includes('openrouter.ai'));
  });

  test('dashboard integration: index.html has socialmotion cluster and nav', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('data-section="socialmotion"'), 'nav');
    assert.ok(html.includes('socialmotion:'), 'cluster key');
    assert.ok(html.includes('Social Motion Studio'), 'title');
    assert.ok(html.includes('motion.html'), 'link');
    assert.match(html, /DashOS-v\d+\.\d+\.\d+/, 'semantic version');
  });

  test('sw.js precaches motion assets', () => {
    const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
    assert.match(sw, /motion\.html/);
    assert.match(sw, /motion-studio\.js/);
    assert.match(sw, /dash-scratch-v\d+/);
  });

  test('motion.html shell exists and loads module', () => {
    const html = readFileSync(new URL('../motion.html', import.meta.url), 'utf8');
    assert.ok(html.includes('motion-canvas'), 'canvas');
    assert.ok(html.includes('motion-studio.js'), 'module');
    assert.ok(html.includes('Social Motion Studio'), 'title');
    // DOM boot without error (auto-init guard requires real ids — should not throw)
    const dom = new JSDOM(html, {
      url:'https://example.com/',
      pretendToBeVisual:true,
      runScripts:'dangerously',
      beforeParse(window){
        window.HTMLCanvasElement.prototype.getContext = function(type){
          if(type!=='2d') return null;
          return { canvas:this, save:()=>{}, restore:()=>{}, setTransform:()=>{}, scale:()=>{}, translate:()=>{}, createLinearGradient:()=>({addColorStop:()=>{}}), createRadialGradient:()=>({addColorStop:()=>{}}), fillRect:()=>{}, fillText:()=>{}, strokeText:()=>{}, beginPath:()=>{}, arc:()=>{}, fill:()=>{}, clip:()=>{}, drawImage:()=>{}, measureText:()=>({width:50}) };
        };
        window.HTMLCanvasElement.prototype.toDataURL = ()=> 'data:image/png;base64,abc';
        window.HTMLCanvasElement.prototype.captureStream = undefined;
      }
    });
    const { window } = dom;
    const js = readFileSync(new URL('../assets/motion-studio.js', import.meta.url), 'utf8');
    window.eval(js);
    assert.ok(window.MotionStudio, 'MotionStudio attached');
    window.MotionStudio.initMotionStudio(window.document);
    // second init idempotent (dataset guard)
    window.MotionStudio.initMotionStudio(window.document);
    window.close();
  });
});
