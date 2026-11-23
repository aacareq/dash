/*
 * Social Motion Studio — zero-backend motion graphics for social.
 * Builds on free inference (BYOK): LLM for script, Pollinations/HF for images, Canvas for motion.
 * No build step, no API key required for core path. Keys are BYOK only, never persisted server-side.
 */
(function attachMotionStudio(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object" && root.document) {
    root.MotionStudio = api;
    const boot = () => api.initMotionStudio(root.document);
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createMotionStudio() {
  "use strict";

  const VERSION = 1;
  const FORMATS = {
    "9:16": { label: "9:16 Vertical — TikTok / Reels / Shorts", dims: [1080, 1920], ratio: "9 / 16" },
    "4:5": { label: "4:5 Portrait — Instagram Feed", dims: [1080, 1350], ratio: "4 / 5" },
    "1:1": { label: "1:1 Square — Feed / LinkedIn", dims: [1080, 1080], ratio: "1 / 1" },
    "16:9": { label: "16:9 Landscape — X / YouTube", dims: [1280, 720], ratio: "16 / 9" }
  };
  const PRESETS = {
    hooklist: { label: "🔥 Hook + 3 Facts (viral list)", colors: ["#0b0b14", "#1e1b4b", "#7c3aed", "#f472b6", "#fef08a"] },
    beforeafter: { label: "⚖️ Before → After", colors: ["#0f172a", "#1e3a4a", "#06b6d4", "#f59e0b", "#fef3c7"] },
    mythfact: { label: "💥 Myth vs Fact", colors: ["#1a0000", "#7f1d1d", "#dc2626", "#fbbf24", "#fefce8"] },
    quote: { label: "💬 Big Quote", colors: ["#0a0f1c", "#1e293b", "#38bdf8", "#a5b4fc", "#f8fafc"] },
    tutorial: { label: "📋 3-Step Tutorial", colors: ["#04210f", "#14532d", "#22c55e", "#86efac", "#ecfdf5"] },
    hottake: { label: "⚡️ Hot Take + CTA", colors: ["#0c0a1a", "#3b0764", "#a855f7", "#ec4899", "#fff1f2"] }
  };
  const PALETTES = {
    electric: ["#0a0a18", "#1a1040", "#7c3aed", "#f472b6", "#fef08a"],
    ocean: ["#061a2a", "#0e3a4a", "#06b6d4", "#67e8f9", "#ecfeff"],
    ember: ["#1a0a05", "#451a03", "#f97316", "#fbbf24", "#fffbeb"],
    rose: ["#1a050a", "#4c0519", "#e11d48", "#fb7185", "#fff1f2"],
    forest: ["#051410", "#052e16", "#16a34a", "#86efac", "#f0fdf4"],
    monochrome: ["#0a0a0a", "#1a1a1a", "#52525b", "#d4d4d8", "#fafafa"]
  };
  const CAPTION_STYLES = {
    hormozi: { label: "Hormozi — bold + highlight", desc: "Big white + yellow pop per word" },
    minimal: { label: "Minimal — clean", desc: "Small white on dark pill" },
    karaoke: { label: "Karaoke — word highlight", desc: "Current word yellow, rest white" },
    big: { label: "BIG HOOK — huge", desc: "Massive, 2 lines max, for first scene only" }
  };
  const PROVIDERS = {
    groq: { label: "Groq (free)", model: "llama-3.1-8b-instant", endpoint: () => "https://api.groq.com/openai/v1/chat/completions" },
    google: { label: "Gemini (free tier)", model: "gemini-2.0-flash", endpoint: m => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent` },
    openrouter: { label: "OpenRouter (:free)", model: "openai/gpt-4o-mini", endpoint: () => "https://openrouter.ai/api/v1/chat/completions" },
    huggingface: { label: "HF Inference (free)", model: "mistralai/Mistral-7B-Instruct-v0.3", endpoint: () => "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3" }
  };

  const clean = (v, max = 600) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const toSeed = s => {
    let h = 2166136261 >>> 0;
    for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  };
  const seeded = seed => {
    let s = seed >>> 0;
    return () => {
      s += 0x6D2B79F5; let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // ---- Local fallback script (no network) ----
  const HOOKS = [
    "Stop scrolling. {topic} in 15 seconds:",
    "The {topic} trick nobody told you:",
    "I wish someone told me this about {topic}:",
    "3 {topic} mistakes keeping you stuck:",
    "Unpopular {topic} truth:",
    "Steal my {topic} playbook:"
  ];
  const STATEMENTS = [
    "Most people overcomplicate {topic}.",
    "The secret is consistency, not perfection.",
    "Small tweaks → outsized results.",
    "Your future self will thank you.",
    "Clarity beats cleverness every time.",
    "Do the boring work consistently."
  ];

  function buildLocalSocial(brief, preset = "hooklist") {
    // Multiple lines are user-supplied captions, not facts invented by a template.
    const supplied = String(brief ?? "").split(/\n+/).map(line => clean(line, 140)).filter(Boolean);
    if (supplied.length >= 2 && supplied.length <= 8) {
      return normalizeSocial({ title: supplied[0], preset, scenes: supplied.map((caption, i) => ({
        title: i === 0 ? "HOOK" : `SCENE ${i + 1}`, caption, prompt: caption
      })) });
    }
    const raw = clean(brief, 120);
    if (!raw) throw new Error("Add an idea / topic first");
    const topic = raw;
    const shortTopic = topic.split(/[.!?]/)[0].slice(0, 42) || topic;
    const hookTmpl = HOOKS[toSeed(topic) % HOOKS.length];
    const hook = hookTmpl.replace("{topic}", shortTopic);
    const bodyLines = [
      `1. ${STATEMENTS[toSeed(topic+"1")%STATEMENTS.length].replace("{topic}", shortTopic)}`,
      `2. ${STATEMENTS[toSeed(topic+"2")%STATEMENTS.length].replace("{topic}", shortTopic)}`,
      `3. ${STATEMENTS[toSeed(topic+"3")%STATEMENTS.length].replace("{topic}", shortTopic)}`
    ];
    const title = shortTopic.length > 48 ? shortTopic.slice(0, 45) + "…" : shortTopic;
    if (preset === "beforeafter") {
      return normalizeSocial({
        title, preset, scenes: [
          { title: "BEFORE", caption: `Before: ${shortTopic} feels hard`, prompt: `Before state of ${topic}, muted tones, cluttered` },
          { title: "AFTER", caption: `After: clear system for ${shortTopic}`, prompt: `After state of ${topic}, bright, organized, confident` },
          { title: "HOW", caption: "One change. Steal this:", prompt: `Minimal infographic showing 1 key change for ${topic}` }
        ]
      });
    }
    if (preset === "mythfact") {
      return normalizeSocial({
        title, preset, scenes: [
          { title: "MYTH", caption: `Myth: ${shortTopic} needs talent`, prompt: `Bold MYTH stamp over ${topic}` },
          { title: "FACT", caption: `Fact: system beats talent. Here's how:`, prompt: `Bold FACT stamp, clean, proven` }
        ]
      });
    }
    if (preset === "quote") {
      return normalizeSocial({
        title, preset, scenes: [
          { title: "QUOTE", caption: hook, prompt: `Inspirational quote about ${topic}, cinematic` },
          { title: "— YOU", caption: `Save this for later. Follow for more ${shortTopic}.`, prompt: `Minimal quote card for ${topic}` }
        ]
      });
    }
    if (preset === "tutorial") {
      return normalizeSocial({ title, preset, scenes: [
        { title: "STEP 1", caption: bodyLines[0], prompt: `Step 1 illustration for ${topic}` },
        { title: "STEP 2", caption: bodyLines[1], prompt: `Step 2 illustration for ${topic}` },
        { title: "STEP 3", caption: bodyLines[2], prompt: `Step 3 illustration for ${topic}` }
      ]});
    }
    // default hooklist / hottake
    return normalizeSocial({
      title, preset,
      scenes: [
        { title: "HOOK", caption: hook, prompt: `Hook image for ${topic}, high contrast, scroll-stopping` },
        { title: "1", caption: bodyLines[0], prompt: `Illustration for: ${bodyLines[0]} — ${topic}` },
        { title: "2", caption: bodyLines[1], prompt: `Illustration for: ${bodyLines[1]} — ${topic}` },
        { title: "3", caption: bodyLines[2], prompt: `Illustration for: ${bodyLines[2]} — ${topic}` },
        { title: "CTA", caption: `What would you add about ${shortTopic}?`, prompt: `CTA card for ${topic}, clean, button` }
      ]
    });
  }

  function normalizeSocial(input, fallbackTitle = "My social clip") {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Social object required");
    if (!Array.isArray(input.scenes) || input.scenes.length < 2 || input.scenes.length > 8) throw new Error("Scenes must be 2–8");
    const preset = PRESETS[input.preset] ? input.preset : "hooklist";
    const scenes = input.scenes.map((s, i) => {
      if (!s || typeof s !== "object") throw new Error(`Scene ${i+1} invalid`);
      const caption = clean(s.caption || s.text || s.line, 140) || clean(s.prompt || "", 140) || "…";
      if (!caption || caption === "…") throw new Error(`Scene ${i+1} missing caption`);
      return {
        title: clean(s.title || s.label, 32) || `S${i+1}`,
        caption,
        prompt: clean(s.prompt || s.imagePrompt || s.visual, 280) || clean(caption, 280) || "abstract gradient",
        durationSec: Number(s.durationSec) > 0 ? Math.min(10, Math.max(1, Number(s.durationSec))) : 2.5
      };
    });
    return {
      version: VERSION,
      title: clean(input.title, 72) || clean(fallbackTitle, 72) || "My social clip",
      preset,
      scenes
    };
  }

  function socialRequestText(brief, preset) {
    // preset may be string or { preset, palette, format }
    let presetKey = preset;
    let fmt = null;
    let pal = null;
    if (preset && typeof preset === "object") {
      presetKey = preset.preset || presetKey;
      fmt = preset.format || preset.aspect || null;
      pal = preset.palette || null;
    }
    const p = PRESETS[presetKey] || PRESETS.hooklist;
    const key = PRESETS[presetKey] ? presetKey : "hooklist";
    const extra = [];
    if (fmt) extra.push(`Format: ${fmt} — keep safe margins, vertical hook first`);
    if (pal) extra.push(`Palette hint: ${pal}`);
    return [
      "Act as a direct-response social strategist creating a short-form script. Output JSON only.",
      `Preset: ${p.label} (${key}) — tailor structure to it.`,
      `Topic: ${JSON.stringify(clean(brief, 400))}`,
      ...(extra.length ? extra : []),
      "Return JSON: {\"title\":\"short title 5-8 words\",\"preset\":\"hooklist|beforeafter|mythfact|quote|tutorial|hottake\",\"scenes\":[{\"title\":\"SCENE LABEL 1-2 words\",\"caption\":\"1 sentence hook or fact, <=18 words, punchy\",\"prompt\":\"image prompt: vivid, short, no text, social-friendly\"}]}",
      "Use 4–5 scenes. Open with a concrete hook under 140 characters; make the payoff specific and actionable. Use short, skimmable sentences of roughly 8–14 words; close with a useful takeaway or specific open question.",
      "Avoid delve, game-changer, unlock, unleash, tapestry, testament, in today's fast-paced world, let's dive in, and here's why. No engagement bait or hashtag spam; at most two functional emoji. No introductory filler.",
      "Use only facts supplied in the brief. Never invent statistics, personal experiences, examples, sources, outcomes or promises. If details are missing, stay general or use clearly marked placeholders. Silently check hook specificity, remove fluff, and use a practitioner voice.",
      "Do not add markdown, fences, or extra keys."
    ].join("\n");
  }

  async function requestSocialScript({ provider, key, brief, preset = "hooklist", model = "", fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
    const sel = PROVIDERS[provider];
    const apiKey = String(key ?? "").trim();
    const topic = clean(brief, 400);
    if (!sel) throw new Error("Pick Groq / Gemini / OpenRouter / HF");
    if (!apiKey) throw new Error(`${sel.label} key required (BYOK) — or use local generator (no key)`);
    if (!topic) throw new Error("Add your idea first");
    if (typeof fetchImpl !== "function") throw new Error("Fetch unavailable");
    const modelName = clean(model, 120) || sel.model;
    const prompt = socialRequestText(topic, preset);
    const isGemini = provider === "google";
    const isHF = provider === "huggingface";
    const headers = { "Content-Type": "application/json" };
    let body, endpoint = sel.endpoint(modelName);
    if (isGemini) {
      headers["x-goog-api-key"] = apiKey;
      body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 1200 } };
    } else if (isHF) {
      headers.Authorization = `Bearer ${apiKey}`;
      body = { inputs: prompt, parameters: { max_new_tokens: 900, temperature: 0.7, return_full_text: false } };
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
      if (provider === "openrouter") { headers["HTTP-Referer"] = (typeof location !== "undefined" && location.origin) || "https://dash.local"; headers["X-Title"] = "Dash Motion Studio"; }
      body = { model: modelName, messages: [{ role: "system", content: "You are a viral scriptwriter. Return JSON only." }, { role: "user", content: prompt }], temperature: 0.85, max_tokens: 1200 };
    }
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs)) : null;
    try {
      const res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), ...(ctrl ? { signal: ctrl.signal } : {}) });
      if (!res.ok) {
        const advice = res.status === 429 ? "Rate limited — try again in a minute" : [400,401,403].includes(res.status) ? "Check key / model access" : "Provider error — use local generator";
        throw new Error(`${sel.label} ${res.status}: ${advice}`);
      }
      const data = await res.json();
      let text = "";
      if (isGemini) text = data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||"").join("") || "";
      else if (isHF) text = Array.isArray(data) ? (data[0]?.generated_text || "") : (data.generated_text || JSON.stringify(data));
      else text = data.choices?.[0]?.message?.content || "";
      if (!text.trim()) throw new Error("Empty response — try again or use local");
      const obj = extractJson(text);
      return normalizeSocial(obj, topic);
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(`${sel.label} timed out`);
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  }

  function extractJson(text) {
    const s = String(text ?? "").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("No JSON found — try again");
    try { return JSON.parse(s.slice(a, b+1)); } catch { throw new Error("Invalid JSON — retry or edit locally"); }
  }

  // ---- Image generation (free) ----
  function pollinationsUrl(prompt, w = 1080, h = 1920, seed = 1) {
    const p = encodeURIComponent(clean(prompt, 280) || "abstract gradient");
    // Pollinations free, no key, cached CDN. Seed via param for variation.
    return `https://image.pollinations.ai/p/${p}?width=${w}&height=${h}&seed=${seed}&nologo=true&enhance=false`;
  }
  function buildImagePrompt(scene, preset, palette) {
    // Supports: (sceneObj, presetKey, paletteKey) OR (promptString, {palette, format})
    let base, presetKey, paletteKey;
    if (typeof scene === "string") {
      base = clean(scene, 200) || "abstract";
      if (preset && typeof preset === "object") {
        presetKey = preset.preset || preset.style || "";
        paletteKey = preset.palette || palette || "electric";
        const fmt = preset.format || preset.aspect || "";
        const styleHint = presetKey === "quote" ? "minimal, typography background, blurred" : presetKey === "mythfact" ? "high contrast, bold" : "vibrant, social media style";
        const fmtHint = fmt ? `, ${fmt} ${/9:16/.test(fmt) ? "vertical" : fmt} composition` : "";
        return `${base}, ${styleHint}, palette ${paletteKey || "electric"}${fmtHint}, no text, no watermark, high detail`;
      }
      presetKey = preset || "";
      paletteKey = palette || "electric";
    } else {
      base = clean((scene && (scene.prompt || scene.caption)) || "", 200) || "abstract";
      presetKey = preset || "";
      paletteKey = palette || "electric";
    }
    const styleHint = presetKey === "quote" ? "minimal, typography background, blurred" : presetKey === "mythfact" ? "high contrast, bold" : "vibrant, social media style";
    return `${base}, ${styleHint}, palette ${paletteKey || "electric"}, no text, no watermark, high detail`;
  }

  // ---- Canvas motion ----
  function drawMotionFrame(ctx, social, sceneIdx = 0, opts = {}) {
    if (!ctx || !ctx.canvas) return;
    const canvas = ctx.canvas;
    const W = canvas.width || 1080, H = canvas.height || 1920;
    const p = Math.max(0, Math.min(1, Number(opts.progress) || 0));
    const captionStyle = opts.captionStyle || "hormozi";
    const presetKey = PRESETS[social?.preset] ? social.preset : "hooklist";
    const paletteKey = opts.palette && PALETTES[opts.palette] ? opts.palette : (presetKey === "quote" ? "monochrome" : "electric");
    const palette = PALETTES[paletteKey] || PALETTES.electric;
    const scene = social?.scenes?.[sceneIdx];
    if (!scene) return;
    const bgImg = opts.imageMap ? opts.imageMap[sceneIdx] : null;

    try { ctx.setTransform(1,0,0,1,0,0); } catch {}
    if (typeof ctx.clearRect === "function") ctx.clearRect(0,0,W,H); else { ctx.fillStyle = palette[0]; ctx.fillRect(0,0,W,H); }

    // Background: image if available, else gradient
    if (bgImg && bgImg.complete && bgImg.naturalWidth) {
      // Ken Burns
      const motion = opts.motion || "slow";
      const zoom = motion === "push" ? 1 + p*0.08 : 1.05;
      const panX = motion === "sweep" ? (p-0.5)*W*0.04 : 0;
      const scale = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight) * zoom;
      const dw = bgImg.naturalWidth * scale, dh = bgImg.naturalHeight * scale;
      const dx = (W - dw)/2 + panX, dy = (H - dh)/2;
      try { ctx.drawImage(bgImg, dx, dy, dw, dh); } catch {}
      // dark overlay for text readability
      const grad = ctx.createLinearGradient(0,0,0,H);
      grad.addColorStop(0,"rgba(0,0,0,0.05)"); grad.addColorStop(0.5,"rgba(0,0,0,0.25)"); grad.addColorStop(1,"rgba(0,0,0,0.82)");
      ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);
    } else {
      const g = ctx.createLinearGradient(0,0,W,H);
      g.addColorStop(0, palette[0]); g.addColorStop(0.55, palette[1]); g.addColorStop(1, palette[0]);
      ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
      // subtle blobs
      ctx.globalAlpha = 0.18; ctx.fillStyle = palette[2];
      ctx.beginPath(); ctx.arc(W*0.75, H*0.28, Math.min(W,H)*0.18,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(W*0.20, H*0.78, Math.min(W,H)*0.22,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Top bar: preset label + progress
    ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(0,0,W, Math.max(28, H*0.045));
    ctx.fillStyle = "rgba(255,255,255,0.78)"; ctx.font = `800 ${Math.max(11, W*0.022)}px system-ui,sans-serif`;
    ctx.fillText(`DASH MOTION · ${presetKey.toUpperCase()} · ${sceneIdx+1}/${social.scenes.length}`, W*0.04, H*0.028);

    // Scene badge
    const badge = scene.title || `S${sceneIdx+1}`;
    ctx.fillStyle = palette[2]; ctx.font = `900 ${Math.max(18, W*0.045)}px system-ui,sans-serif`;
    const badgeW = ctx.measureText(badge).width + W*0.06;
    const badgeH = H*0.055;
    const bx = W*0.04, by = H*0.07;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx,by,badgeW,badgeH, 12); ctx.fill(); } else ctx.fillRect(bx,by,badgeW,badgeH);
    ctx.fillStyle = "#fff"; ctx.fillText(badge, bx + W*0.03, by + badgeH*0.68);

    // Caption: kinetic typography
    const caption = clean(scene.caption, 140) || "";
    const words = caption.split(/\s+/).filter(Boolean);
    const captionAreaTop = H*0.48;
    const maxW = W*0.88;
    const isHook = sceneIdx === 0;
    const baseSize = isHook ? Math.round(W*0.075) : Math.round(W*0.055);
    // Wrap words into lines (max 3)
    const lines = []; let cur = "";
    const ctxMeasure = (t, sz) => { ctx.font = `900 ${sz}px system-ui,sans-serif`; return ctx.measureText(t).width; };
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctxMeasure(test, baseSize) > maxW && cur) { lines.push(cur); cur = w; if (lines.length >= 3) break; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    if (lines.length > 3) lines.length = 3;

    // animate progress: each word pops in sequence
    const totalWords = Math.max(1, words.length);
    const popPhase = (i) => {
      const start = i / totalWords * 0.7;
      const end = start + 0.22;
      if (p < start) return 0;
      if (p > end) return 1;
      const t = (p - start) / (end - start);
      return 1 - Math.pow(1 - t, 3); // easeOutCubic
    };

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const cx = W/2;
    let y = captionAreaTop;
    const lineH = baseSize * 1.15;
    for (let li = 0; li < lines.length; li++) {
      const lineWords = lines[li].split(" ");
      const lineProgress = Math.min(1, Math.max(0, (p*1.2 - li*0.15)));
      const scale = 0.92 + lineProgress*0.08;
      ctx.save();
      ctx.translate(cx, y + li*lineH);
      ctx.scale(scale, scale);
      ctx.globalAlpha = 0.15 + lineProgress*0.85;
      // shadow
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      // Build line display with per-word color if karaoke/hormozi
      if (captionStyle === "minimal") {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        const pad = W*0.04;
        const lineW = ctxMeasure(lines[li], baseSize);
        const rx = -lineW/2 - pad/2, ry = -baseSize*0.65, rw = lineW + pad, rh = baseSize*1.05;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(rx, ry, rw, rh, 10); ctx.fill(); } else ctx.fillRect(rx, ry, rw, rh);
        ctx.fillStyle = "#fff";
        ctx.font = `700 ${baseSize}px system-ui,sans-serif`;
        ctx.fillText(lines[li], 0, 0);
      } else {
        // word-by-word highlight
        let xOff = -ctxMeasure(lines[li], baseSize)/2;
        for (let wi = 0; wi < lineWords.length; wi++) {
          const w = lineWords[wi];
          const wW = ctxMeasure(w + " ", baseSize);
          const globalIdx = words.indexOf(w, words.slice(0, words.indexOf(w)).length) || wi; // fallback
          const isCurrent = Math.floor(p * totalWords) === globalIdx && p < 0.92;
          if (captionStyle === "hormozi" || captionStyle === "karaoke") {
            ctx.fillStyle = isCurrent ? "#fef08a" : "#ffffff";
            // stroke for readability
            ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = Math.max(3, baseSize*0.08);
            ctx.strokeText(w, xOff + wW/2, 0);
            ctx.fillText(w, xOff + wW/2, 0);
            if (isCurrent && captionStyle === "hormozi") {
              // underline pop
              ctx.fillStyle = "#fef08a";
              ctx.fillRect(xOff, baseSize*0.45, wW*0.9, Math.max(4, baseSize*0.08));
            }
          } else if (captionStyle === "big") {
            ctx.fillStyle = "#fff";
            ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = Math.max(4, baseSize*0.1);
            ctx.strokeText(w, xOff + wW/2, 0);
            ctx.fillText(w, xOff + wW/2, 0);
          } else {
            ctx.fillStyle = "#fff";
            ctx.fillText(w, xOff + wW/2, 0);
          }
          xOff += wW;
        }
      }
      ctx.restore();
      // pop scale handled via translate/scale above
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

    // Bottom: handle + CTA
    const handle = opts.handle || "";
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = `700 ${Math.max(12, W*0.028)}px system-ui,sans-serif`;
    ctx.fillText(handle, W*0.04, H*0.93);
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.font = `500 ${Math.max(10, W*0.022)}px system-ui,sans-serif`;
    ctx.fillText(`${social.title || ""}`.slice(0, 48), W*0.04, H*0.965);

    // Progress bar
    const total = Number(opts.totalScenes) || social.scenes.length || 1;
    const sceneProgress = (sceneIdx + p) / total;
    ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(W*0.04, H*0.985, W*0.92, Math.max(3, H*0.006));
    ctx.fillStyle = palette[2]; ctx.fillRect(W*0.04, H*0.985, W*0.92 * sceneProgress, Math.max(3, H*0.006));
  }

  function aspectForSocial(fmt) {
    const f = FORMATS[fmt] ? fmt : "9:16";
    return FORMATS[f].dims.slice();
  }

  // ---- Storage (same pattern as x-studio) ----
  const LS_KEY = "dash-motion-v1";
  const safeLS = {
    get(k, fb=null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
    set(k,v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  };

  function initMotionStudio(doc) {
    try {
      const d = doc || document;
      if (d.documentElement?.dataset?.motionInit === "true") return;
      const hasShell = d.getElementById("motion-idea") && d.getElementById("motion-canvas");
      if (!hasShell) return;
      d.documentElement.dataset.motionInit = "true";

      const $ = id => d.getElementById(id);
      const statusEl = $("motion-status");
      const canvas = $("motion-canvas");
      const ctx = canvas ? canvas.getContext("2d") : null;
      const state = {
        social: null,
        format: "9:16",
        preset: "hooklist",
        palette: "electric",
        captionStyle: "hormozi",
        motion: "slow",
        handle: "",
        images: {}, // sceneIdx -> Image
        imageUrls: {}, // sceneIdx -> objectURL
        currentScene: 0,
        playing: false,
        raf: 0,
        totalDuration: 12
      };
      const setStatus = (m, tone="") => { if (!statusEl) return; statusEl.textContent = m || ""; statusEl.dataset.tone = tone; statusEl.className = `motion-status ${tone? "is-"+tone:""}`; };

      const getBrief = () => $("motion-idea")?.value || "";
      const refreshFormat = () => {
        const fmt = $("motion-format")?.value || "9:16";
        state.format = fmt;
        const [w,h] = aspectForSocial(fmt);
        if (canvas) { canvas.width = w; canvas.height = h; canvas.style.aspectRatio = w + " / " + h; }
        const specEl = $("motion-spec"); if (specEl) specEl.textContent = `${w} × ${h} · ${fmt} · 30 fps`;
        drawPreview(0);
      };
      const drawPreview = (progress = 0.5) => {
        if (!state.social || !ctx) return;
        drawMotionFrame(ctx, state.social, state.currentScene, {
          progress,
          palette: state.palette,
          captionStyle: state.captionStyle,
          motion: state.motion,
          handle: state.handle,
          imageMap: state.images,
          totalScenes: state.social.scenes.length
        });
        const thumbCtx = $("motion-thumb")?.getContext("2d");
        if (thumbCtx) {
          const tCanvas = $("motion-thumb");
          tCanvas.width = 180; tCanvas.height = Math.round(180 * (canvas.height / canvas.width));
          drawMotionFrame(thumbCtx, state.social, state.currentScene, {
            progress: 0.5, palette: state.palette, captionStyle: state.captionStyle, motion: state.motion, handle: state.handle, imageMap: state.images, totalScenes: state.social.scenes.length
          });
        }
      };
      const renderScenes = () => {
        const root = $("motion-scenes");
        if (!root || !state.social) return;
        root.replaceChildren();
        state.social.scenes.forEach((s, i) => {
          const row = d.createElement("div");
          row.className = "motion-scene-row" + (i === state.currentScene ? " is-active" : "");
          row.innerHTML = `<button type="button" class="motion-scene-btn" data-idx="${i}"><span class="motion-scene-badge">${s.title}</span><span class="motion-scene-caption">${escapeHtml(s.caption)}</span></button><div class="motion-scene-actions"><button type="button" data-edit="${i}" class="motion-mini">Edit</button><span class="motion-img-state">${state.images[i] ? "🖼️ image" : "○ no image"}</span></div>`;
          root.appendChild(row);
        });
        root.querySelectorAll("[data-idx]").forEach(b => b.addEventListener("click", () => { state.currentScene = Number(b.dataset.idx); renderScenes(); drawPreview(0.5); }));
        root.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openEdit(Number(b.dataset.edit))));
      };
      const openEdit = (idx) => {
        const s = state.social?.scenes?.[idx];
        if (!s) return;
        const dlg = $("motion-edit-dialog");
        if (!dlg) return;
        $("motion-edit-title").value = s.title;
        $("motion-edit-caption").value = s.caption;
        $("motion-edit-prompt").value = s.prompt;
        dlg.dataset.editIdx = String(idx);
        dlg.showModal();
      };
      $("motion-edit-save")?.addEventListener("click", () => {
        const dlg = $("motion-edit-dialog");
        const idx = Number(dlg.dataset.editIdx);
        const s = state.social?.scenes?.[idx];
        if (s) {
          s.title = clean($("motion-edit-title").value, 32) || s.title;
          s.caption = clean($("motion-edit-caption").value, 140) || s.caption;
          s.prompt = clean($("motion-edit-prompt").value, 280) || s.prompt;
          renderScenes(); drawPreview(0.5); setStatus("Scene updated", "ok");
        }
        dlg.close();
      });

      const buildSocial = (isLocal = true) => {
        const brief = getBrief();
        if (!brief.trim()) { setStatus("Write your idea first (e.g. '3 morning habits for focus')", "error"); return; }
        state.preset = $("motion-preset")?.value || "hooklist";
        state.palette = $("motion-palette")?.value || "electric";
        state.captionStyle = $("motion-caption-style")?.value || "hormozi";
        state.motion = $("motion-motion")?.value || "slow";
        state.handle = $("motion-handle")?.value || "";
        const local = buildLocalSocial(brief, state.preset);
        state.social = local;
        state.currentScene = 0;
        state.images = {};
        renderScenes(); drawPreview(0.5); setStatus(`Local draft ready — ${local.scenes.length} scenes. Review and edit all claims before recording.`, "ok");
      };

      $("motion-generate-local")?.addEventListener("click", () => buildSocial(true));
      $("motion-format")?.addEventListener("change", refreshFormat);
      $("motion-preset")?.addEventListener("change", () => { if (state.social) { state.preset = $("motion-preset").value; buildSocial(true); } });
      $("motion-palette")?.addEventListener("change", e => { state.palette = e.target.value; drawPreview(0.5); });
      $("motion-caption-style")?.addEventListener("change", e => { state.captionStyle = e.target.value; drawPreview(0.5); });
      $("motion-motion")?.addEventListener("change", e => { state.motion = e.target.value; drawPreview(0.5); });
      $("motion-handle")?.addEventListener("input", e => { state.handle = e.target.value || ""; drawPreview(0.5); });

      // BYOK generate
      $("motion-generate-ai")?.addEventListener("click", async () => {
        const brief = getBrief();
        if (!brief.trim()) { setStatus("Add your idea first", "error"); return; }
        const provider = $("motion-provider")?.value || "groq";
        const key = $("motion-key")?.value || "";
        const preset = $("motion-preset")?.value || "hooklist";
        const btn = $("motion-generate-ai");
        btn.disabled = true; setStatus(`Asking ${PROVIDERS[provider]?.label || provider}… key only sent to that provider`, "busy");
        try {
          const social = await requestSocialScript({ provider, key, brief, preset, model: $("motion-model")?.value || "" });
          state.social = social; state.preset = social.preset; state.currentScene = 0; state.images = {};
          renderScenes(); drawPreview(0.5); setStatus("AI script ready — edit any scene, then generate images", "ok");
        } catch (e) { setStatus(e.message + (e instanceof TypeError ? " Check network/CORS or use local" : ""), "error"); }
        finally { btn.disabled = false; }
      });
      $("motion-provider")?.addEventListener("change", e => {
        const p = PROVIDERS[e.target.value]; if (p && $("motion-model")) $("motion-model").value = p.model; const k = $("motion-key"); if (k) k.value = "";
      });

      // Images via Pollinations (free, no key) + optional HF
      $("motion-gen-images")?.addEventListener("click", async () => {
        if (!state.social) { setStatus("Build a script first", "error"); return; }
        const btn = $("motion-gen-images"); btn.disabled = true; setStatus("Generating images via Pollinations (free, no key) — 2–3 sec each...", "busy");
        const [w,h] = aspectForSocial(state.format);
        let okCount = 0;
        for (let i = 0; i < state.social.scenes.length; i++) {
          const scene = state.social.scenes[i];
          const prompt = buildImagePrompt(scene, state.preset, state.palette);
          const url = pollinationsUrl(prompt, w, h, toSeed(prompt + i) % 1000000);
          try {
            const img = new Image(); img.crossOrigin = "anonymous";
            await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("load failed")); img.src = url; setTimeout(() => rej(new Error("timeout")), 12000); });
            state.images[i] = img; okCount++;
            setStatus(`Image ${i+1}/${state.social.scenes.length} ready`, "busy");
            renderScenes(); drawPreview(0.5);
          } catch (e) {
            console.warn("Pollinations failed for scene", i, e);
            // fallback: keep gradient (no image) — still usable
          }
        }
        btn.disabled = false;
        setStatus(`${okCount}/${state.social.scenes.length} images loaded. Record now, or keep gradient variants — both export cleanly.`, okCount ? "ok" : "error");
      });
      $("motion-clear-images")?.addEventListener("click", () => {
        state.images = {}; renderScenes(); drawPreview(0.5); setStatus("Cleared images — back to gradient motion", "ok");
      });

      // Playback & Record
      const totalMs = () => (state.social ? state.social.scenes.length * 2500 : 0); // 2.5s per scene
      let playStart = 0;
      const tick = (now) => {
        if (!state.playing || !state.social) return;
        const elapsed = now - playStart;
        const total = totalMs();
        const sceneDur = 2500;
        const idx = Math.min(state.social.scenes.length - 1, Math.floor(elapsed / sceneDur));
        const localP = Math.min(1, Math.max(0, (elapsed % sceneDur) / sceneDur));
        if (idx !== state.currentScene) { state.currentScene = idx; renderScenes(); }
        drawMotionFrame(ctx, state.social, idx, { progress: localP, palette: state.palette, captionStyle: state.captionStyle, motion: state.motion, handle: state.handle, imageMap: state.images, totalScenes: state.social.scenes.length });
        const prog = Math.min(1, elapsed / total);
        const bar = $("motion-progress"); if (bar) bar.value = prog;
        const timeEl = $("motion-time"); if (timeEl) {
          const fmt = ms => `${String(Math.floor(ms/1000/60)).padStart(2,"0")}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}`;
          timeEl.textContent = `${fmt(elapsed)} / ${fmt(total)}`;
        }
        if (elapsed >= total) { state.playing = false; $("motion-play").disabled = false; $("motion-stop").disabled = true; setStatus("Preview finished"); return; }
        state.raf = requestAnimationFrame(tick);
      };
      $("motion-play")?.addEventListener("click", () => {
        if (!state.social) { setStatus("Build a script first", "error"); return; }
        state.playing = true; playStart = performance.now(); $("motion-play").disabled = true; $("motion-stop").disabled = false; setStatus("Playing — " + state.format + " preview");
        state.raf = requestAnimationFrame(tick);
      });
      $("motion-stop")?.addEventListener("click", () => {
        state.playing = false; cancelAnimationFrame(state.raf); $("motion-play").disabled = false; $("motion-stop").disabled = true; setStatus("Stopped"); drawPreview(0.5);
      });

      let recorder = null, recStream = null, recChunks = [], recUrl = "";
      const stopRec = () => {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      };
      $("motion-record")?.addEventListener("click", async () => {
        if (!state.social) { setStatus("Build a script first", "error"); return; }
        if (typeof canvas.captureStream !== "function" || typeof window.MediaRecorder !== "function") { setStatus("Canvas recording not supported — export the current scene as PNG and use an editor", "error"); return; }
        const dur = totalMs() / 1000;
        recChunks = [];
        const stream = canvas.captureStream(30);
        recStream = stream;
        const types = ["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4"];
        const mime = types.find(t => !window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(t));
        try { recorder = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { stream.getTracks().forEach(t=>t.stop()); setStatus("Recorder failed: " + e.message, "error"); return; }
        recorder.ondataavailable = e => { if (e.data?.size) recChunks.push(e.data); };
        recorder.onstop = () => {
          stream.getTracks().forEach(t=>t.stop()); recStream = null;
          const blob = new Blob(recChunks, { type: recorder.mimeType || mime || "video/webm" });
          if (!blob.size) { setStatus("No video data — try exporting the current scene as PNG", "error"); return; }
          if (recUrl) URL.revokeObjectURL(recUrl); recUrl = URL.createObjectURL(blob);
          const v = $("motion-result"); if (v) { v.src = recUrl; v.hidden = false; }
          const a = $("motion-download"); if (a) { const ext = blob.type.includes("mp4") ? "mp4" : "webm"; a.href = recUrl; a.download = `social-motion-${new Date().toISOString().slice(0,10)}.${ext}`; a.textContent = `Download ${ext.toUpperCase()} (${Math.round(blob.size/1024)} KB)`; a.hidden = false; }
          setStatus(`Recording ready as ${blob.type.includes("mp4")?"MP4":"WebM"}. Check playback, captions and platform compatibility before sharing.`, "ok");
          $("motion-record").disabled = false; $("motion-stop-rec").hidden = true;
        };
        recorder.onerror = () => setStatus("Recorder error", "error");
        recStream = stream; recorder.start(200);
        $("motion-record").disabled = true; $("motion-stop-rec").hidden = false;
        // drive animation during recording
        state.playing = true; playStart = performance.now();
        const recTick = (now) => {
          if (!state.playing) return;
          const elapsed = now - playStart;
          const idx = Math.min(state.social.scenes.length-1, Math.floor(elapsed / 2500));
          const localP = Math.min(1, (elapsed % 2500)/2500);
          state.currentScene = idx; drawMotionFrame(ctx, state.social, idx, { progress: localP, palette: state.palette, captionStyle: state.captionStyle, motion: state.motion, handle: state.handle, imageMap: state.images, totalScenes: state.social.scenes.length });
          if (elapsed >= totalMs()) { state.playing = false; stopRec(); return; }
          state.raf = requestAnimationFrame(recTick);
        };
        state.raf = requestAnimationFrame(recTick);
        setStatus(`Recording ${dur.toFixed(1)}s — keep tab open`, "busy");
        setTimeout(stopRec, totalMs() + 300);
      });
      $("motion-stop-rec")?.addEventListener("click", () => { state.playing = false; cancelAnimationFrame(state.raf); stopRec(); setStatus("Stopped early", "ok"); $("motion-record").disabled = false; $("motion-stop-rec").hidden = true; });

      // Variations: shuffle palette + regenerate
      $("motion-variations")?.addEventListener("click", () => {
        const brief = getBrief(); if (!brief.trim()) { setStatus("Add idea first", "error"); return; }
        const keys = Object.keys(PALETTES); const rnd = seeded(toSeed(brief + Date.now()))();
        const pick = keys[Math.floor(rnd * keys.length)];
        $("motion-palette").value = pick; state.palette = pick;
        buildSocial(true); setStatus(`Variation with ${pick} palette — generate images for new look`, "ok"); drawPreview(0.5);
      });

      // Export PNG / ZIP (reuse video-workshop zip logic if available, fallback simple)
      $("motion-export-png")?.addEventListener("click", async () => {
        if (!state.social) return;
        try {
          const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error("PNG failed")), "image/png"));
          const a = d.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `motion-${Date.now()}.png`; a.click(); setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
          setStatus("PNG exported", "ok");
        } catch (e) { setStatus(e.message, "error"); }
      });
      $("motion-copy-script")?.addEventListener("click", async () => {
        if (!state.social) return;
        const text = state.social.scenes.map((s,i)=> `${i+1}. ${s.caption}`).join("\n");
        try { await navigator.clipboard.writeText(text); setStatus("Script copied — paste into TikTok/Reels caption or X Studio", "ok"); } catch { setStatus("Copy blocked — select manually", "error"); }
      });

      // Init defaults
      refreshFormat();
      state.social = buildLocalSocial($("motion-idea")?.value || "Test your idea in 15 seconds", "hooklist");
      renderScenes(); drawPreview(0.5);
      setStatus("Ready — type your idea, hit Generate, export in 30 seconds. No key, no credits, no queue.");
    } catch (err) {
      try { console.error("[MotionStudio] init failed", err); const el = document.getElementById("motion-status"); if (el) el.textContent = "Init error: " + (err.message || err); } catch {}
    }
  }

  function escapeHtml(s) { return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  return {
    VERSION,
    FORMATS, PRESETS, PALETTES, CAPTION_STYLES, PROVIDERS,
    clean, toSeed, seeded,
    buildLocalSocial, normalizeSocial, socialRequestText, requestSocialScript, extractJson,
    pollinationsUrl, buildImagePrompt, drawMotionFrame, aspectForSocial, initMotionStudio
  };
});
