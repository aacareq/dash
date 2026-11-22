import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const loadXStudio = () => {
  // Fresh require without cache
  delete require.cache[require.resolve("../assets/x-studio.js")];
  return require("../assets/x-studio.js");
};

describe("X Studio constants", () => {
  let X;
  before(() => { X = loadXStudio(); });
  it("exports LIMITS and specs", () => {
    assert.equal(X.LIMITS.text, 280);
    assert.equal(X.LIMITS.premium, 25000);
    assert.equal(X.LIMITS.imagesPerPost, 4);
    assert.equal(X.X_SPECS.image.maxBytes, 5*1024*1024);
    assert.equal(X.X_SPECS.video.maxSec, 140);
  });
  it("has correct catalog sizes", () => {
    assert.equal(X.HOOKS.length, 12);
    assert.equal(new Set(X.HOOKS.map(h=>h.id)).size, 12);
    assert.equal(X.CTAS.length, 7);
    assert.equal(X.STYLES.length, 5);
    assert.equal(Object.keys(X.PROVIDERS).length, 3);
    assert.equal(X.IMAGE_TEMPLATES.length, 5);
    assert.equal(Object.keys(X.PALETTES).length, 5);
    for (const h of X.HOOKS) assert.ok(h.label && h.prompt, `hook ${h.id} missing label/prompt`);
    for (const c of X.CTAS) assert.ok(c.text, `cta ${c.id} missing text`);
  });
  it("countChars handles emoji and empty", () => {
    assert.equal(X.countChars(""), 0);
    assert.equal(X.countChars("hello"), 5);
    assert.equal(X.countChars("👨‍👩‍👧‍👦"), [..."👨‍👩‍👧‍👦"].length);
    assert.equal(X.countChars(null), 0);
  });
  it("splitIntoThread respects limits", () => {
    assert.deepEqual(X.splitIntoThread(""), [""]);
    assert.deepEqual(X.splitIntoThread("short"), ["short"]);
    const long = "a".repeat(300);
    const parts = X.splitIntoThread(long, 280);
    assert.equal(parts.length, 2);
    assert.ok(parts.every(p => [...p].length <= 280));
    // paragraph split
    const para = Array.from({length:3}, (_,i)=> `Sentence ${i+1} is nice.`).join("\n\n");
    const p2 = X.splitIntoThread(para, 20);
    assert.ok(p2.length > 1);
    // hard slice for single long word
    const word = "x".repeat(600);
    assert.ok(X.splitIntoThread(word, 100).length === 6);
  });
  it("scorePost returns valid shape and tips", () => {
    const empty = X.scorePost({ text: "" });
    assert.ok(empty.score >=0 && empty.score <=100);
    assert.ok(empty.tips.length >0);
    assert.equal(empty.meta.len, 0);
    const withMedia = X.scorePost({ text: "Great hook " + "x".repeat(80), hasMedia: true, hasVideo: false, threadLength: 1 });
    const withoutMedia = X.scorePost({ text: "Great hook " + "x".repeat(80), hasMedia: false });
    assert.ok(withMedia.score > withoutMedia.score, "media should boost");
    const caps = X.scorePost({ text: "THIS IS ALL CAPS AND SHOULD BE PENALIZED FOR SHOUTING LOUDLY ON X PLATFORM NOW" });
    const normal = X.scorePost({ text: "This is normal sentence case with a good hook and question?" });
    assert.ok(caps.score < normal.score, "caps penalty");
    const hashtags = X.scorePost({ text: "hello #one #two #three #four" });
    assert.ok(hashtags.tips.some(t=> /hashtags/i.test(t)));
    const premium = X.scorePost({ text: "x".repeat(300), accountPremium: true });
    assert.equal(premium.meta.limit, 25000);
  });
  it("buildPrompt generates prompt strings", () => {
    const p = X.buildPrompt("x_write", { topic: "test topic", style: "punchy", hook:"curiosity", cta:"ask", audience:"builders" });
    assert.match(p, /punchy/);
    assert.match(p, /test topic/);
    assert.match(p, /280/);
    assert.equal(X.buildPrompt("unknown", {topic:"hi"}), "hi");
  });
  it("xIntentUrl encodes correctly", () => {
    const url = X.xIntentUrl("hello world & test");
    assert.ok(url.includes("x.com/intent/post"));
    assert.ok(url.includes(encodeURIComponent("hello world & test").slice(0,10)));
    assert.equal(X.xIntentLegacyUrl("hi").includes("twitter.com/intent/tweet"), true);
  });
  it("bufferPayload shapes correctly", () => {
    const b = X.bufferPayload({ text:"hi", profileIds:["abc"], mediaUrls:[], scheduledAt:"2025-01-01" });
    assert.equal(b.text, "hi");
    assert.deepEqual(b.profile_ids, ["abc"]);
  });
  it("drawPostImage works with mock context", () => {
    let fillRectCalls=0, fillTextCalls=0;
    const mockCtx = {
      canvas: { width:1600, height:900 },
      save: ()=>{}, restore: ()=>{}, setTransform: ()=>{},
      createLinearGradient: ()=> ({ addColorStop: ()=>{}, }),
      fillRect: ()=> fillRectCalls++,
      fillText: ()=> fillTextCalls++,
      beginPath: ()=>{}, arc: ()=>{}, fill: ()=>{},
      roundRect: undefined,
      measureText: ()=>({width:100})
    };
    X.drawPostImage(mockCtx, { title:"Test hook for X", subtitle:"Subline", palette:"indigo", template:"gradient_quote" });
    assert.ok(fillRectCalls >0, "should fill rects");
    assert.ok(fillTextCalls >0, "should fill text");
    // minimal template
    X.drawPostImage(mockCtx, { title:"hi", template:"minimal" });
    // data_bar
    X.drawPostImage(mockCtx, { title:"hi", template:"data_bar", bars:[{label:"A",pct:50}] });
  });
});

describe("Dashboard integration", () => {
  it("index.html contains X Studio cluster with 5 items and nav button", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.ok(html.includes('data-section="xstudio"'), "nav button");
    assert.ok(html.includes("xstudio:"), "database key");
    assert.ok(html.includes("𝕏 X Studio"), "title");
    assert.ok(html.includes("x-studio.html"), "link");
    assert.ok(html.includes("Publish to X — 5 Ways"), "publishes item");
    assert.ok(html.includes("DashOS-v1.18"), "version bump near 1.18");
    assert.ok(html.includes("Viral Research"), "research card");
  });
  it("sw.js precaches x-studio assets", () => {
    const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
    assert.match(sw, /x-studio\.html/);
    assert.match(sw, /x-studio\.js/);
    assert.match(sw, /dash-scratch-v2/);
  });
  it("posting adapters validate inputs", async () => {
    const X = loadXStudio();
    await assert.rejects(() => X.postViaXApi({ accessToken:"", text:"hi" }), /Paste your X OAuth/);
    await assert.rejects(() => X.postViaXApi({ accessToken:"tok", text:"" }), /Text required/);
    await assert.rejects(() => X.uploadMediaXApi({ accessToken:"tok", file: null }), /Browser upload needs/);
    await assert.rejects(() => X.postViaBuffer({ accessToken:"", profileIds:["a"], text:"hi" }), /Buffer access_token/);
    await assert.rejects(() => X.postViaBuffer({ accessToken:"tok", profileIds:[], text:"hi" }), /profile ID/);
    await assert.rejects(() => X.postViaWebhook({ url:"", payload:{} }), /webhook URL/);
    await assert.rejects(() => X.postViaWebhook({ url:"not-http", payload:{} }), /webhook URL/);
    const ok = await X.postViaWebhook({ url:"https://example.com/hook", payload:{ text:"hi" }, fetchImpl: async () => ({ ok:true, text: async()=> "ok" }) });
    assert.equal(ok, "ok");
    assert.equal(X.extractJson('{"a":1}').a, 1);
    assert.throws(()=> X.extractJson("no json here"), /No JSON/);
  });
});

describe("X Studio DOM integration (dropdowns populated)", () => {
  it("populates all dropdowns and reacts to input", async () => {
    const html = readFileSync(new URL("../x-studio.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, {
      url: "https://example.com/",
      pretendToBeVisual: true,
      runScripts: "dangerously",
      resources: "usable",
      beforeParse(window) {
        // Stub canvas for jsdom
        window.HTMLCanvasElement.prototype.getContext = function(type) {
          if (type !== "2d") return null;
          return {
            canvas: this,
            save: ()=>{}, restore: ()=>{}, setTransform: ()=>{},
            createLinearGradient: ()=> ({ addColorStop: ()=>{} }),
            fillRect: ()=>{}, fillText: ()=>{}, strokeRect: ()=>{},
            beginPath: ()=>{}, arc: ()=>{}, fill: ()=>{}, closePath: ()=>{},
            measureText: ()=>({ width: 50 })
          };
        };
        window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,abc";
      }
    });
    const { window } = dom;
    // Load x-studio.js in window context via fs eval
    const js = readFileSync(new URL("../assets/x-studio.js", import.meta.url), "utf8");
    window.eval(js);
    assert.ok(window.XStudio, "XStudio should attach to window");
    // Manually trigger init (auto boot may have fired, but ensure)
    window.XStudio.initXStudio(window.document);

    const doc = window.document;
    // Check dropdowns populated (the bug)
    const hookSel = doc.getElementById("x-hook");
    const styleSel = doc.getElementById("x-style");
    const ctaSel = doc.getElementById("x-cta");
    const imgTplSel = doc.getElementById("x-img-template");
    const paletteSel = doc.getElementById("x-palette");
    const viaSel = doc.getElementById("x-schedule-via");

    assert.ok(hookSel, "x-hook exists");
    assert.ok(styleSel, "x-style exists");
    assert.ok(ctaSel, "x-cta exists");
    assert.ok(imgTplSel, "x-img-template exists");
    assert.ok(paletteSel, "x-palette exists");

    // After fix, hook should have 13 options (1 placeholder + 12 hooks)
    assert.ok(hookSel.options.length >= 12, `hook options ${hookSel.options.length} should be >=12, got ${[...hookSel.options].map(o=>o.text).join("|")}`);
    assert.ok(styleSel.options.length >= 5, `style options ${styleSel.options.length}`);
    assert.ok(ctaSel.options.length >= 7, `cta options ${ctaSel.options.length}`);
    assert.ok(imgTplSel.options.length >= 5, `img template ${imgTplSel.options.length}`);
    assert.ok(paletteSel.options.length >= 5, `palette ${paletteSel.options.length}`);
    assert.ok(viaSel.options.length === 4, "via should be 4 static");

    // Check virality score renders after typing
    const ta = doc.getElementById("x-text");
    const virality = doc.getElementById("x-virality");
    ta.value = "Unpopular opinion: most viral X posts aren't lucky — they're engineered for dwell + replies. What's your take?";
    ta.dispatchEvent(new window.Event("input", { bubbles:true }));
    // allow microtask
    await new Promise(r=> setTimeout(r, 20));
    assert.ok(virality.innerHTML.includes("x-score-ring"), "virality should render ring");
    assert.ok(virality.innerHTML.includes("Chars:"), "virality meta");
    assert.equal(doc.getElementById("x-char-counter").textContent.includes("/"), true);

    // Thread mode
    const threadToggle = doc.getElementById("x-thread-toggle");
    const longText = "First tweet hook. " + "Word ".repeat(80);
    ta.value = longText;
    threadToggle.checked = true;
    threadToggle.dispatchEvent(new window.Event("change", { bubbles:true }));
    ta.dispatchEvent(new window.Event("input", { bubbles:true }));
    await new Promise(r=> setTimeout(r, 20));
    const threadInfo = doc.getElementById("x-thread-info");
    assert.equal(threadInfo.hidden, false, "thread info visible when toggled");

    // Tabs switching
    const apiTab = doc.querySelector('[data-x-tab="api"]');
    const webPane = doc.querySelector('[data-x-pane="web"]');
    const apiPane = doc.querySelector('[data-x-pane="api"]');
    assert.equal(webPane.hidden, false, "web pane initially visible");
    apiTab.click();
    assert.equal(apiPane.hidden, false, "api pane visible after click");
    assert.equal(webPane.hidden, true, "web pane hidden after switch");
    const bufferTab = doc.querySelector('[data-x-tab="buffer"]');
    bufferTab.click();
    assert.equal(doc.querySelector('[data-x-pane="buffer"]').hidden, false);

    // Image render
    const renderBtn = doc.getElementById("x-render-image");
    const canvas = doc.getElementById("x-media-canvas");
    renderBtn.click();
    assert.equal(canvas.width, 1600);
    assert.equal(canvas.height, 900);

    // Hook insertion
    hookSel.value = "contrarian";
    hookSel.dispatchEvent(new window.Event("change", { bubbles:true }));
    const insertHook = doc.getElementById("x-insert-hook");
    ta.value = "existing content";
    insertHook.click();
    assert.ok(ta.value.includes("Everyone says"), "hook should be inserted");

    // CTA insertion
    const ctaSel2 = doc.getElementById("x-cta");
    ctaSel2.value = "ask";
    ctaSel2.dispatchEvent(new window.Event("change", { bubbles:true }));
    doc.getElementById("x-insert-cta").click();
    assert.ok(ta.value.includes("What's your take?"), "cta inserted");

    // Draft save/load
    const draftsBefore = window.localStorage.getItem("dash-x-studio-drafts-v1");
    doc.getElementById("x-save-draft").click();
    const draftsAfter = window.localStorage.getItem("dash-x-studio-drafts-v1");
    assert.ok(draftsAfter && draftsAfter !== draftsBefore, "draft saved to localStorage");
    assert.ok(doc.getElementById("x-drafts").innerHTML.includes("Chars") || doc.getElementById("x-drafts").innerHTML.includes("chars") || doc.getElementById("x-drafts").innerHTML.includes("Load"), "drafts rendered");

    // Idempotent second init should not duplicate options
    const beforeCount = hookSel.options.length;
    window.XStudio.initXStudio(window.document);
    assert.equal(hookSel.options.length, beforeCount, "second init should be idempotent");

    window.close();
  });
  it("handles premium toggle and media file validation messages", async () => {
    const html = readFileSync(new URL("../x-studio.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "https://example.com/", pretendToBeVisual:true, runScripts:"dangerously", beforeParse(window){
      window.HTMLCanvasElement.prototype.getContext = function(){ return { canvas:this, save:()=>{}, restore:()=>{}, setTransform:()=>{}, createLinearGradient:()=>({addColorStop:()=>{}}), fillRect:()=>{}, fillText:()=>{}, beginPath:()=>{}, arc:()=>{}, fill:()=>{}, measureText:()=>({width:10}) }; };
      window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,abc";
    }});
    const { window } = dom;
    const js = readFileSync(new URL("../assets/x-studio.js", import.meta.url), "utf8");
    window.eval(js);
    window.XStudio.initXStudio(window.document);
    const doc = window.document;
    const ta = doc.getElementById("x-text");
    // premium changes limit
    ta.value = "x".repeat(300);
    doc.getElementById("x-premium").checked = false;
    doc.getElementById("x-premium").dispatchEvent(new window.Event("change", {bubbles:true}));
    ta.dispatchEvent(new window.Event("input",{bubbles:true}));
    await new Promise(r=> setTimeout(r,10));
    assert.ok(doc.getElementById("x-virality").innerHTML.includes("Over 280"), "should warn over 280 when not premium");
    doc.getElementById("x-premium").checked = true;
    doc.getElementById("x-premium").dispatchEvent(new window.Event("change",{bubbles:true}));
    ta.dispatchEvent(new window.Event("input",{bubbles:true}));
    await new Promise(r=> setTimeout(r,10));
    assert.ok(!doc.getElementById("x-virality").innerHTML.includes("Over 280"), "premium should allow 300");
    window.close();
  });
});
