/**
 * X Studio — dash standalone module for crafting viral X posts with images/video.
 * Research-backed: open X algorithm (Heavy Ranker), dwell/ reply/ media signals,
 * 30-60min early window, SimClusters, penalties. Zero backend; BYOK only.
 */
(function attachXStudio(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) {
    root.XStudio = api;
    const boot = () => api.initXStudio(root.document);
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createXStudio() {
  "use strict";

  const VERSION = 1;
  const STORAGE = {
    drafts: "dash-x-studio-drafts-v1",
    queue: "dash-x-studio-queue-v1",
    prefs: "dash-x-studio-prefs-v1",
    byok: "dash-x-studio-byok-v1"
  };
  const LIMITS = {
    text: 280,
    premium: 25000,
    imagesPerPost: 4,
    imageBytes: 5 * 1024 * 1024,
    videoBytes: 512 * 1024 * 1024,
    videoSeconds: 140,
    gifBytes: 15 * 1024 * 1024
  };
  const X_SPECS = {
    image: { formats: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: LIMITS.imageBytes, maxCount: 4, dims: "1600×900 recommended, 1080×1080 square ok" },
    video: { formats: ["video/mp4", "video/quicktime"], maxBytes: LIMITS.videoBytes, maxSec: LIMITS.videoSeconds, dims: "1280×720 (16:9), 720×1280 (9:16), 720×720 (1:1), 30/60fps" }
  };

  const HOOKS = [
    { id: "contrarian", label: "Contrarian / myth-bust", prompt: "Everyone says {topic} — here's why that's backwards:" },
    { id: "story", label: "Micro-story", prompt: "Last {timeframe} I {action}. Here's what happened:" },
    { id: "list", label: "List / playbook", prompt: "{n} {topic} lessons I wish I knew earlier:" },
    { id: "curiosity", label: "Curiosity gap", prompt: "The {adjective} {topic} trick nobody talks about:" },
    { id: "data", label: "Data drop", prompt: "We analyzed {n} {topic}. {surprising finding} — breakdown:" },
    { id: "hot_take", label: "Hot take + nuance", prompt: "Unpopular opinion: {claim}. Let me explain →" },
    { id: "howto", label: "How-to thread", prompt: "How to {outcome} in {timeframe} (without {common mistake}):" },
    { id: "question", label: "Question hook", prompt: "What's the {metric} mistake killing your {topic}?" },
    { id: "before_after", label: "Before → after", prompt: "Before: {bad state}\nAfter: {good state}\nHere's the 1 change:" },
    { id: "teardown", label: "Teardown", prompt: "I tore down {popular thing}. {n} things worth stealing:" },
    { id: "mistake", label: "Mistakes thread", prompt: "{n} mistakes that make your {topic} invisible (and fixes):" },
    { id: "behind", label: "Behind the scenes", prompt: "Building {project} in public — day {n}: {update}" }
  ];
  const CTAS = [
    { id: "ask", label: "Ask for replies (algorithm +75)", text: "What's your take? Reply and I'll respond — let's discuss 👇" },
    { id: "poll", label: "Poll-style", text: "A or B? Vote in replies: A = {optA}  /  B = {optB}" },
    { id: "challenge", label: "Challenge", text: "Try this for 48h and report back. Who's in?" },
    { id: "curate", label: "Curate replies", text: "Drop your best {topic} tip below — I'll RT the top 3." },
    { id: "bookmark", label: "Bookmark prompt", text: "Bookmark this — you'll want it when {moment}." },
    { id: "follow", label: "Soft follow", text: "I post daily {topic} breakdowns — follow for tomorrow's part 2." },
    { id: "thread", label: "Thread continuation", text: "🧵 Full breakdown in the thread — next tweet has the template:" }
  ];
  const STYLES = [
    { id: "punchy", label: "Punchy / viral", hint: "Short lines, line breaks, one idea per sentence. Hook in first 2 words." },
    { id: "story", label: "Narrative", hint: "First-person, specific moment, stakes, twist, lesson." },
    { id: "educational", label: "Educational", hint: "Claim → mechanism → example → CTA. Earn dwell time." },
    { id: "contrarian", label: "Contrarian", hint: "Name consensus → push back → evidence → invite debate." },
    { id: "meme", label: "Meme / cultural", hint: "Reference, remix, caption. Pair with strong visual." }
  ];

  const PROVIDERS = {
    groq: { label: "Groq", model: "llama-3.1-8b-instant", endpoint: () => "https://api.groq.com/openai/v1/chat/completions" },
    openrouter: { label: "OpenRouter", model: "openai/gpt-4o-mini", endpoint: () => "https://openrouter.ai/api/v1/chat/completions" },
    google: { label: "Gemini", model: "gemini-2.0-flash", endpoint: m => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent` }
  };

  const IMAGE_TEMPLATES = [
    { id: "gradient_quote", label: "Quote / stat card", desc: "Bold gradient + big type, made for dwell." },
    { id: "minimal", label: "Minimal light", desc: "Clean card for educational posts." },
    { id: "photo_overlay", label: "Photo overlay (upload)", desc: "Your image + readable type on scrim." },
    { id: "data_bar", label: "Data bar card", desc: "Fake a benchmark / comparison bar." },
    { id: "thread_cover", label: "Thread cover", desc: "Numbered cover (1/10) to boost saves." }
  ];
  const PALETTES = {
    indigo: ["#0b0b1a", "#312e81", "#818cf8"],
    ember: ["#1a0b08", "#7c2d12", "#fb923c"],
    teal: ["#04201b", "#0f766e", "#2dd4bf"],
    rose: ["#1f0a14", "#9f1239", "#fb7185"],
    ink: ["#0f172a", "#334155", "#e2e8f0"]
  };

  const clean = (v, max = 500) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const countChars = t => [...String(t ?? "")].length;
  const linkCount = t => (String(t).match(/https?:\/\/\S+/g) || []).length;
  const hashtagCount = t => (String(t).match(/#\w+/g) || []).length;
  const isAllCaps = t => {
    const letters = String(t).replace(/[^A-Za-z]/g, "");
    if (letters.length < 12) return false;
    const up = letters.replace(/[^A-Z]/g, "").length;
    return up / letters.length > 0.7;
  };

  function splitIntoThread(text, limit = LIMITS.text) {
    const raw = String(text ?? "").trim();
    if (!raw) return [""];
    if (countChars(raw) <= limit) return [raw];
    // Prefer splitting on double newline / sentence boundaries; fallback hard slice.
    const chunks = [];
    const paragraphs = raw.split(/\n{2,}/);
    let buf = "";
    const push = s => { if (s) chunks.push(s.trim()); };
    for (const para of paragraphs) {
      const candidate = buf ? `${buf}\n\n${para}` : para;
      if (countChars(candidate) <= limit) buf = candidate;
      else {
        if (buf) push(buf);
        if (countChars(para) <= limit) buf = para;
        else {
          // split long para by sentences
          const sentences = para.split(/(?<=[.!?])\s+/);
          buf = "";
          for (const sent of sentences) {
            const cand2 = buf ? `${buf} ${sent}` : sent;
            if (countChars(cand2) <= limit) buf = cand2;
            else {
              if (buf) push(buf);
              if (countChars(sent) <= limit) buf = sent;
              else {
                // hard slice
                const chars = [...sent];
                for (let i = 0; i < chars.length; i += limit) push(chars.slice(i, i + limit).join(""));
                buf = "";
              }
            }
          }
        }
      }
    }
    if (buf) push(buf);
    return chunks.length ? chunks : [raw.slice(0, limit)];
  }

  function scorePost({ text = "", hasMedia = false, hasVideo = false, threadLength = 1, hasPoll = false, accountPremium = false } = {}) {
    const t = String(text);
    const len = countChars(t);
    const limit = accountPremium ? LIMITS.premium : LIMITS.text;
    const tags = hashtagCount(t);
    const caps = isAllCaps(t);
    const links = linkCount(t);
    const lines = t.split("\n").filter(s => s.trim()).length;
    const endsWithQuestion = /\?\s*$/.test(t.trim()) || /\b(what|why|how|which|who|when|where)\b/i.test(t.slice(-80));
    let score = 55;
    const tips = [];
    const add = (d, msg) => { score += d; if (msg) tips.push(msg); };

    if (len === 0) add(-30, "Write your hook — first 8 words decide scroll-stop.");
    else if (len > 0 && len < 40) add(-8, "Too short for dwell — add one concrete detail or number.");
    else if (len >= 70 && len <= 180) add(8, "Sweet spot length — scannable + dwell-friendly.");
    else if (len > 240 && len <= limit) add(3, "Long-form ok — consider a thread to grow dwell to 2 min.");
    if (len > limit) add(-12, `Over ${limit} chars — split into thread or shorten.`);

    if (hasMedia || hasVideo) add(10, "Media boost: +media signal; X prefers native image/video over link-only.");
    if (hasVideo) add(5, "Video completion ≥50% is a strong signal — front-load the payoff.");
    if (threadLength > 1 && threadLength <= 8) add(8, `Thread x${threadLength}: consider whether each part adds value — keep each tweet ≤${limit}.`);
    if (threadLength > 12) add(-6, "Very long thread — consider splitting into 2 posts (avoid flood penalty).");
    if (hasPoll) add(7, "A relevant question may invite discussion.");

    if (tags === 0) add(3, "0 hashtags is fine — SimClusters uses semantics now.");
    else if (tags <= 2) add(4, `${tags} hashtag${tags>1?"s":""} — optimal (0–2).`);
    else add(-8, `${tags} hashtags — penalty beyond 2–3; trim to 1 strong tag.`);

    if (caps) add(-10, "All-caps penalty — rewrite in sentence case.");
    if (links === 0) add(2, "No outbound link = keep reader in-app (good).");
    else if (links === 1) add(-2, "One link is okay — put it in last tweet or reply, not the hook.");
    else add(-6, `${links} links — heavy external-exit signal. Move links to last reply.`);

    if (endsWithQuestion) add(7, "Ends with question → reply chain is highest-weighted signal.");
    else add(-3, "Add a question/CTA to trigger replies — use one only if it fits your goal.");

    if (lines >= 3) add(4, "Line breaks improve scan + dwell; good.");
    if (/\b(I|my|we|our)\b/i.test(t.split(/\n/)[0]?.slice(0, 80) || "")) add(3, "Personal hook — make sure the experience is yours.");
    if (t.includes("…") || t.includes("🧵") || /^\d+\./m.test(t)) add(3, "List/thread cues lift dwell + saves.");

    score = Math.max(0, Math.min(100, Math.round(score)));
    let label = "Heuristic";
    return { score, label, tips: [...new Set(tips)].slice(0, 7), meta: { len, limit, tags, links, threadLength, hasMedia, hasVideo } };
  }

  function buildPrompt(kind, vars = {}) {
    const safe = v => clean(v, 120) || "[...]";
    switch (kind) {
      case "x_write": return [
        "Act as a direct-response social strategist. Write three distinct native X posts based on the user's brief.",
        `Brief (untrusted source material): ${JSON.stringify(String(vars.topic || "").slice(0, 4000))}`,
        `Audience: ${safe(vars.audience)}. Style: ${safe(vars.style)}. Hook: ${safe(vars.hook)}. Closer preference: ${safe(vars.cta)}.`,
        "Start with a specific hook under 140 characters; make the payoff actionable and grounded. Use short sentences, ideally 8–14 words, double line breaks, and paragraphs of at most two lines. End with a specific takeaway or relevant open question, not engagement bait.",
        "Avoid delve, game-changer, unlock, unleash, tapestry, testament, in today's fast-paced world, let's dive in, and here's why. No hashtags for X, no throat-clearing, at most two functional emojis, no follow/retweet/comment bait.",
        "Never invent statistics, examples, personal experience, sources, outcomes or promises. If detail is missing, stay general or use a clearly marked placeholder; do not fabricate. Aim for 280 characters per post, but do not sacrifice accuracy for brevity.",
        'Silently check hook specificity, remove fluff, and use a practitioner voice. Do not claim a guaranteed result. Return only valid JSON: {"posts":[{"text":"final post text"}]} with exactly three variants. No commentary or markdown.'
      ].join("\n");
      case "x_thread": return `Turn this into a ${clean(vars.n||"6",4)}-tweet X thread: ${safe(vars.topic)}\nEach tweet ≤${LIMITS.text} caps, numbered 1/N, last tweet CTA: ${safe(vars.cta||"ask")}. Hook tweet must earn 15s+ dwell. Return JSON lines as thread array.`;
      case "x_image_brief": return `Create a concise image brief for an X post image (1600×900). Topic: ${safe(vars.topic)}. Style: ${safe(vars.style||"gradient")}. Text on image: ≤7 words. Return JSON {"headline":"...","sub":"...","palette":"indigo|ember|teal|rose"}`;
      default: return clean(vars.topic||"", 400);
    }
  }

  function xIntentUrl(text) {
    const enc = encodeURIComponent(String(text ?? ""));
    return `https://x.com/intent/post?text=${enc}`;
  }
  function xIntentLegacyUrl(text) {
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(String(text ?? ""))}`;
  }
  function bufferPayload({ text, mediaUrls = [], profileIds = [], scheduledAt = null }) {
    return { text: String(text||""), media: mediaUrls, profile_ids: profileIds, scheduled_at: scheduledAt };
  }

  // Storage helpers (safe for missing localStorage)
  const safeStorage = {
    get(k, fallback = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  function loadDrafts() { const d = safeStorage.get(STORAGE.drafts, []); return Array.isArray(d) ? d : []; }
  function saveDraft(draft) {
    const list = loadDrafts();
    const now = Date.now();
    const doc = { id: draft.id || `d_${now}_${Math.random().toString(36).slice(2,7)}`, updatedAt: now, createdAt: draft.createdAt || now, ...draft };
    const idx = list.findIndex(x => x.id === doc.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...doc }; else list.unshift(doc);
    if (!safeStorage.set(STORAGE.drafts, list.slice(0, 80))) throw new Error("Draft not saved: browser storage is unavailable or full. Copy your text before leaving.");
    return doc;
  }
  function deleteDraft(id) { safeStorage.set(STORAGE.drafts, loadDrafts().filter(d => d.id !== id)); }
  function loadQueue() { const q = safeStorage.get(STORAGE.queue, []); return Array.isArray(q) ? q : []; }
  function saveQueue(list) { if (!safeStorage.set(STORAGE.queue, list)) throw new Error("Reminder not saved: browser storage is unavailable or full."); return list; }
  function enqueuePost(item) {
    const q = loadQueue();
    const now = Date.now();
    const doc = { id: `q_${now}_${Math.random().toString(36).slice(2,6)}`, status: "scheduled", createdAt: now, attempts: 0, ...item };
    q.push(doc); saveQueue(q); return doc;
  }
  function updateQueue(id, patch) {
    const q = loadQueue();
    const idx = q.findIndex(x => x.id === id);
    if (idx < 0) return null;
    q[idx] = { ...q[idx], ...patch };
    saveQueue(q); return q[idx];
  }
  function removeQueue(id) { saveQueue(loadQueue().filter(x => x.id !== id)); }

  // Canvas image generation — no external asset needed
  function drawPostImage(ctx, opts = {}) {
    if (!ctx) return;
    const W = Number(opts.W) || Number(ctx.canvas?.width) || 1600;
    const H = Number(opts.H) || Number(ctx.canvas?.height) || 900;
    const tpl = opts.template || "gradient_quote";
    const title = clean(opts.title || "Your hook here", 90) || "Your hook here";
    const sub = clean(opts.subtitle || "", 140);
    const pal = PALETTES[opts.palette] || PALETTES.indigo;
    const accent = pal[2];
    ctx.save?.();
    ctx.setTransform?.(1,0,0,1,0,0);
    // bg
    const g = ctx.createLinearGradient ? ctx.createLinearGradient(0,0,W,H) : null;
    if (g?.addColorStop) { g.addColorStop(0, pal[0]); g.addColorStop(0.55, pal[1]); g.addColorStop(1, pal[0]); ctx.fillStyle = g; } else ctx.fillStyle = pal[0];
    ctx.fillRect(0,0,W,H);
    // blobs
    ctx.globalAlpha = 0.18; ctx.fillStyle = "#fff";
    ctx.beginPath?.(); ctx.arc?.(W*0.78, H*0.22, Math.min(W,H)*0.18, 0, Math.PI*2); ctx.fill?.();
    ctx.beginPath?.(); ctx.arc?.(W*0.18, H*0.82, Math.min(W,H)*0.22, 0, Math.PI*2); ctx.fill?.();
    ctx.globalAlpha = 1;
    // top bar
    ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(0, 0, W, Math.round(H*0.085));
    ctx.fillStyle = "rgba(255,255,255,0.72)"; ctx.font = `700 ${Math.round(W*0.016)}px system-ui, sans-serif`;
    ctx.fillText?.((opts.eyebrow || "DASH X STUDIO").toUpperCase(), W*0.05, H*0.055);
    // badge if thread cover
    if (tpl === "thread_cover" && opts.threadBadge) {
      ctx.fillStyle = accent; ctx.beginPath?.();
      const bx = W*0.05, by = H*0.12, bw = W*0.18, bh = H*0.08;
      if (ctx.roundRect) { ctx.roundRect(bx,by,bw,bh, 12); ctx.fill(); } else { ctx.fillRect(bx,by,bw,bh); }
      ctx.fillStyle = "#fff"; ctx.font = `800 ${Math.round(W*0.018)}px system-ui, sans-serif`;
      ctx.fillText?.(clean(opts.threadBadge, 24).toUpperCase(), bx+W*0.03, by+bh*0.62);
    }
    // title
    ctx.fillStyle = "#fff";
    const titleSize = Math.round(W * (tpl==="minimal"?0.042:0.048));
    ctx.font = `800 ${titleSize}px system-ui, sans-serif`;
    const maxChars = Math.floor((W*0.9)/(titleSize*0.56));
    const lines = wrapLines(title, maxChars, 3);
    const baseY = H*0.32;
    const lh = Math.round(titleSize*1.25);
    lines.forEach((ln, i) => ctx.fillText?.(ln, W*0.05, baseY + i*lh));
    if (sub) {
      ctx.fillStyle = "rgba(255,255,255,0.86)"; ctx.font = `500 ${Math.round(titleSize*0.52)}px system-ui, sans-serif`;
      const subLines = wrapLines(sub, Math.floor((W*0.88)/(titleSize*0.38)), 2);
      subLines.forEach((ln,i)=> ctx.fillText?.(ln, W*0.05, baseY + lines.length*lh + 18 + i*Math.round(titleSize*0.62)));
    }
    // footer accent line
    ctx.fillStyle = accent; ctx.fillRect(W*0.05, H*0.92, W*0.9, Math.max(3, H*0.007));
    ctx.fillStyle = "rgba(255,255,255,0.65)"; ctx.font = `600 ${Math.round(W*0.012)}px system-ui, sans-serif`;
    ctx.fillText?.(clean(opts.footer || "x.com/yourhandle  •  dash studio", 60), W*0.05, H*0.965);
    // data_bar decoration
    if (tpl === "data_bar" && Array.isArray(opts.bars)) {
      const by = H*0.62; let y = by;
      opts.bars.slice(0,3).forEach(b => {
        const label = clean(b.label||"", 22); const pct = Math.max(5, Math.min(100, Number(b.pct)||50));
        ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = `700 ${Math.round(W*0.013)}px system-ui, sans-serif`;
        ctx.fillText?.(label, W*0.05, y);
        ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(W*0.05, y+8, W*0.90, 10);
        ctx.fillStyle = accent; ctx.fillRect(W*0.05, y+8, W*0.90 * pct/100, 10);
        ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(W*0.012)}px system-ui, sans-serif`;
        ctx.fillText?.(`${pct}%`, W*0.05 + W*0.90*pct/100 + 6, y+16);
        y += 42;
      });
    }
    ctx.restore?.();
  }
  function wrapLines(text, maxChars, maxLines=3) {
    const words = clean(text, 240).split(/\s+/).filter(Boolean);
    const lines=[]; let line="";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length > maxChars && line) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines.length=maxLines; lines[maxLines-1]= lines[maxLines-1].slice(0, Math.max(0, maxChars-1))+"…"; }
    return lines;
  }
  function imageTemplateKinds() { return IMAGE_TEMPLATES.slice(); }

  async function generateWithProvider({ provider, key, prompt, model, fetchImpl = globalThis.fetch, timeoutMs=28000 } = {}) {
    const p = PROVIDERS[provider]; const apiKey = String(key||"").trim();
    if (!p) throw new Error("Pick Groq / OpenRouter / Gemini.");
    if (!apiKey) throw new Error(`Enter ${p.label} key (BYOK, sent only to ${p.label}).`);
    if (!prompt) throw new Error("Add a topic first.");
    if (typeof fetchImpl !== "function") throw new Error("Fetch unavailable.");
    const isGemini = provider === "google";
    const modelName = clean(model,100) || p.model;
    const headers = { "Content-Type":"application/json" };
    let endpoint = p.endpoint(modelName); let body;
    if (isGemini) {
      headers["x-goog-api-key"] = apiKey;
      body = { contents:[{ role:"user", parts:[{ text: prompt }] }], generationConfig:{ temperature:0.85, maxOutputTokens: 1800 } };
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
      if (provider === "openrouter") { headers["HTTP-Referer"] = location.origin; headers["X-Title"] = "Dash X Studio"; }
      body = { model: modelName, messages:[{ role:"system", content:"You are a concise X ghostwriter. Return valid JSON only. No markdown fences." }, { role:"user", content: prompt }], temperature:0.85, max_tokens:1400 };
    }
    const ctrl = typeof AbortController==="function" ? new AbortController(): null;
    const timer = ctrl? setTimeout(()=>ctrl.abort(), Math.max(1000, timeoutMs)): null;
    try {
      const res = await fetchImpl(endpoint, { method:"POST", headers, body: JSON.stringify(body), ...(ctrl?{signal:ctrl.signal}:{}) });
      if (!res.ok) {
        const advice = res.status===429 ? "Rate limited — wait or check quota." : [400,401,403].includes(res.status) ? "Check key/model." : "Provider error — retry or use offline hooks.";
        throw new Error(`${p.label} ${res.status}: ${advice}`);
      }
      const data = await res.json();
      const text = isGemini ? data.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||"").join("") : data.choices?.[0]?.message?.content;
      if (!text?.trim()) throw new Error("Empty response — try again.");
      return text.trim();
    } catch (e) {
      if (e?.name==="AbortError") throw new Error(`${p.label} timed out.`);
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  }
  function extractJson(text) {
    const s = String(text||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
    const a = s.indexOf("{"), b = s.lastIndexOf("}"), c = s.indexOf("["), d = s.lastIndexOf("]");
    // prefer object if both
    let raw = null;
    if (a>=0 && b>a) raw = s.slice(a,b+1);
    else if (c>=0 && d>c) raw = s.slice(c,d+1);
    else throw new Error("No JSON in response.");
    try { return JSON.parse(raw); } catch { throw new Error("Invalid JSON — try again or edit manually."); }
  }

  // Posting adapters — honest about CORS: X API blocks browser CORS; we explain proxy path.
  async function postViaXApi({ accessToken, text, mediaIds=[], replyToId=null, fetchImpl=globalThis.fetch } = {}) {
    const token = String(accessToken||"").trim();
    if (!token) throw new Error("Paste your X OAuth 2.0 User Access Token (tweet.write + media.write + offline.access).");
    if (!text?.trim()) throw new Error("Text required.");
    // NOTE: X API v2 currently requires CORS proxy for browser direct calls. We attempt direct; if blocked, we surface guidance.
    const body = { text: String(text) };
    if (mediaIds.length) body.media = { media_ids: mediaIds.slice(0,4) };
    if (replyToId) body.reply = { in_reply_to_tweet_id: String(replyToId) };
    const res = await fetchImpl("https://api.x.com/2/tweets", {
      method:"POST", headers:{ "Authorization": `Bearer ${token}`, "Content-Type":"application/json" }, body: JSON.stringify(body)
    });
    if (!res.ok) {
      const j = await res.json().catch(()=> ({}));
      throw new Error(j.title ? `${j.title}: ${j.detail||res.status}` : `X API ${res.status} — ${j.detail || "check token scopes & not CORS-blocked (use proxy/backend)"}`);
    }
    return res.json();
  }
  async function uploadMediaXApi({ accessToken, file, fetchImpl=globalThis.fetch } = {}) {
    // v2 media/upload — still OAuth1 for many apps; we expose both endpoints and let user try.
    // For browser MVP, we document the flow and return guidance error rather than fake success.
    throw new Error("Browser upload needs OAuth 1.0a signing + CORS proxy (see Publishing → X API tab for curl + proxy setup). For now use X Web + attach image manually, or Buffer.");
  }
  async function postViaBuffer({ accessToken, profileIds, text, mediaUrls=[], scheduledAt=null, fetchImpl=globalThis.fetch } = {}) {
    const token = String(accessToken||"").trim();
    if (!token) throw new Error("Buffer access_token required (buffer.com/developers → Create App).");
    if (!profileIds?.length) throw new Error("Add at least one Buffer profile ID (X channel).");
    const form = new URLSearchParams();
    form.set("profile_ids[]", String(profileIds[0]));
    // Buffer v1 expects repeated profile_ids[] — we simplify to one + note multi-channel in docs
    form.set("text", String(text||""));
    form.set("shorten", "false");
    if (scheduledAt) form.set("scheduled_at", new Date(scheduledAt).toISOString());
    const url = scheduledAt ? "https://api.bufferapp.com/1/updates/create.json" : "https://api.bufferapp.com/1/updates/create.json";
    const res = await fetchImpl(url, { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: form.toString() + `&access_token=${encodeURIComponent(token)}` });
    if (!res.ok) throw new Error(`Buffer ${res.status}: check token/profile + CORS (Buffer API may need backend proxy too).`);
    return res.json();
  }
  async function postViaWebhook({ url, payload, fetchImpl=globalThis.fetch } = {}) {
    const u = String(url||"").trim();
    if (!u || !/^https?:\/\//.test(u)) throw new Error("Enter webhook URL (https://).");
    const res = await fetchImpl(u, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload||{}) });
    if (!res.ok) throw new Error(`Webhook ${res.status}`);
    return res.text().catch(()=> "ok");
  }

  // DOM init (standalone x-studio.html + optional dashboard embed)
  function initXStudio(doc) {
    try {
    const d = doc || document;
    if (d.documentElement?.dataset?.xStudioInit === "true") return;
    // Guard: page must have composer — use stable ids that actually exist in x-studio.html
    const hasComposer = d.getElementById("x-text") && d.getElementById("x-hook") && d.getElementById("x-virality");
    if (!hasComposer) return;
    d.documentElement.dataset.xStudioInit = "true";
    const $ = id => d.getElementById(id);
    const $$ = sel => [...d.querySelectorAll(sel)];
    const composer = $("x-text"), queueRoot = $("x-queue"), draftRoot = $("x-drafts");
    const statusEl = $("x-status"), mediaCanvas = $("x-media-canvas"), mediaPreview = $("x-media-preview-url");
    if (!composer) return;
    const state = {
      thread: false, premium:false, hasMedia:false, hasVideo:false, hasPoll:false,
      images: [], // dataURLs
      videoFile: null,
      pendingText: ""
    };
    const getText = () => $("x-text")?.value || "";
    const setStatus = (m, tone="") => { if (!statusEl) return; statusEl.textContent=m||""; statusEl.dataset.tone=tone; statusEl.className = `x-status ${tone?"is-"+tone:""}`; };
    const refreshScore = () => {
      const s = scorePost({ text: getText(), hasMedia: state.hasMedia || !!state.images.length, hasVideo: !!state.videoFile, threadLength: state.thread ? splitIntoThread(getText()).length : 1, hasPoll: state.hasPoll, accountPremium: state.premium });
      const el = $("x-virality"); if (!el) return;
      el.innerHTML = `<div class="x-score-ring" data-score="${s.score}"><span class="x-score-num">${s.score}</span><span class="x-score-label">${s.label}</span></div><p class="x-muted">Experimental formatting heuristic, not a prediction of reach or quality. Verify claims and platform limits yourself.</p><ul class="x-tips">${s.tips.map(t=> `<li>${escapeHtml(t)}</li>`).join("")}</ul><div class="x-meta">Chars: ${s.meta.len}/${s.meta.limit} · Tags #${s.meta.tags} · Links ${s.meta.links} · Thread x${s.meta.threadLength}${s.meta.hasVideo?" · video":""}${s.meta.hasMedia?" · image":""}</div>`;
      const ring = el.querySelector(".x-score-ring");
      if (ring) ring.style.setProperty("--score", String(s.score));
      const counter = $("x-char-counter"); if (counter) { counter.textContent = `${s.meta.len} / ${s.meta.limit}`; counter.dataset.over = String(s.meta.len > s.meta.limit); counter.dataset.premium = String(state.premium); }
      const previewEl = $("x-preview-text"); if (previewEl) previewEl.textContent = getText() || "Your post will appear here — write a hook above.";
      const threadInfo = $("x-thread-info"); if (threadInfo) {
        if (state.thread) {
          const parts = splitIntoThread(getText(), s.meta.limit);
          threadInfo.hidden = false; threadInfo.innerHTML = parts.map((p,i)=> `<div class="x-thread-part"><strong>${i+1}/${parts.length}</strong> · ${countChars(p)} chars<div class="x-thread-text">${escapeHtml(p)}</div></div>`).join("");
        } else threadInfo.hidden = true;
      }
    };
    // hook/style/cta pickers
    const hookSel = $("x-hook"), styleSel = $("x-style"), ctaSel = $("x-cta");
    if (hookSel) { hookSel.innerHTML = `<option value="">— hook —</option>` + HOOKS.map(h=> `<option value="${h.id}">${escapeHtml(h.label)}</option>`).join(""); }
    if (styleSel) { styleSel.innerHTML = STYLES.map(s=> `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join(""); }
    if (ctaSel) { ctaSel.innerHTML = `<option value="">— CTA —</option>` + CTAS.map(c=> `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join(""); }
    $("x-text")?.addEventListener("input", () => { refreshScore(); });
    $("x-premium")?.addEventListener("change", e => { state.premium = !!e.target.checked; refreshScore(); });
    $("x-thread-toggle")?.addEventListener("change", e => { state.thread = !!e.target.checked; d.body.dataset.xThread = String(state.thread); refreshScore(); });
    $("x-poll-toggle")?.addEventListener("change", e => { state.hasPoll = !!e.target.checked; refreshScore(); });
    $("x-insert-hook")?.addEventListener("click", () => {
      const hid = hookSel?.value; const h = HOOKS.find(x=>x.id===hid);
      if (!h) { setStatus("Pick a hook first.", "error"); return; }
      const ta = $("x-text"); const tpl = h.prompt; ta.value = tpl + (ta.value ? `\n\n${ta.value}` : ""); ta.focus(); refreshScore();
    });
    $("x-insert-cta")?.addEventListener("click", () => {
      const cid = ctaSel?.value; const c = CTAS.find(x=>x.id===cid);
      if (!c) { setStatus("Pick a CTA first.", "error"); return; }
      const ta = $("x-text"); ta.value = (ta.value.trim() ? `${ta.value.trim()}\n\n${c.text}` : c.text); ta.focus(); refreshScore();
    });
    $("x-clear")?.addEventListener("click", () => { $("x-text").value=""; refreshScore(); setStatus("Cleared.", "ok"); });
    // template image
    const paletteSel = $("x-palette"), tplSel = $("x-img-template");
    if (tplSel) tplSel.innerHTML = IMAGE_TEMPLATES.map(t=> `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join("");
    if (paletteSel) paletteSel.innerHTML = Object.keys(PALETTES).map(k=> `<option value="${k}">${k}</option>`).join("");
    const renderImage = () => {
      const canvas = $("x-media-canvas"); if (!canvas) return;
      canvas.width = 1600; canvas.height = 900;
      const ctx = canvas.getContext("2d");
      drawPostImage(ctx, {
        W:1600,H:900,
        template: tplSel?.value || "gradient_quote",
        title: $("x-img-title")?.value || getText().split("\n")[0]?.slice(0,90) || "Your X post visual",
        subtitle: $("x-img-sub")?.value || "",
        palette: paletteSel?.value || "indigo",
        eyebrow: $("x-img-eyebrow")?.value || "DASH X STUDIO",
        footer: $("x-img-footer")?.value || "x.com/you  •  save → repost",
        threadBadge: $("x-img-badge")?.value || "",
        bars: [{label: "This post", pct:72}, {label:"Average", pct:44}, {label:"Before", pct:28}]
      });
      state.hasMedia = true; if (mediaPreview) mediaPreview.textContent = canvas.toDataURL("image/png").slice(0,48) + "…";
      refreshScore();
    };
    $("x-render-image")?.addEventListener("click", renderImage);
    $("x-download-image")?.addEventListener("click", () => {
      const c = $("x-media-canvas"); if (!c) return;
      const a = d.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `x-image-${Date.now()}.png`; a.click();
      setStatus("PNG downloaded — attach it to X (drag into composer or via Buffer/API).","ok");
    });
    $("x-copy-image")?.addEventListener("click", async () => {
      const c = $("x-media-canvas"); if (!c) return;
      try {
        const blob = await new Promise(res => c.toBlob(res, "image/png"));
        if (navigator.clipboard?.write && blob) { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); setStatus("Image copied — paste into X.", "ok"); return; }
      } catch {}
      setStatus("Clipboard blocked — download instead.", "error");
    });
    // file upload preview
    $("x-image-file")?.addEventListener("change", async e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > LIMITS.imageBytes) { setStatus(`Image too big (${Math.round(file.size/1024)} KB) — X caps at 5 MB.`, "error"); return; }
      if (!X_SPECS.image.formats.includes(file.type) && !["image/jpeg","image/jpg","image/png","image/webp","image/gif"].includes(file.type)) {
        setStatus(`Format ${file.type} may be rejected — use JPG/PNG/WebP/GIF.`, "error");
      }
      const url = URL.createObjectURL(file);
      state.images = [url]; // for preview; actual post uses file upload via API/tool flow
      const img = $("x-upload-preview"); if (img) { img.src = url; img.hidden = false; }
      setStatus(`Image loaded: ${file.name} · ${Math.round(file.size/1024)} KB. X allows up to 4 images per post.`, "ok");
      state.hasMedia = true; refreshScore();
    });
    $("x-video-file")?.addEventListener("change", e => {
      const file = e.target.files?.[0]; if (!file) return;
      const errs=[];
      if (file.size > LIMITS.videoBytes) errs.push(`Too big: ${Math.round(file.size/1024/1024)} MB > 512 MB`);
      if (!["video/mp4","video/quicktime","video/mov"].includes(file.type)) errs.push(`Format ${file.type} — use MP4/MOV`);
      if (errs.length) setStatus(errs.join(" · "), "error"); else setStatus(`Video ready: ${file.name} · ${Math.round(file.size/1024/1024)} MB — X: up to 140s (4h Premium), 512 MB, MP4/MOV.`, "ok");
      state.videoFile = file; state.hasMedia = false; state.hasVideo = !!file; refreshScore();
      const v = $("x-video-preview"); if (v) { v.src = URL.createObjectURL(file); v.hidden = false; }
    });

    // Publishing tabs
    $$("[data-x-tab]").forEach(btn => btn.addEventListener("click", () => {
      const tab = btn.dataset.xTab;
      $$("[data-x-tab]").forEach(b=> b.classList.toggle("is-active", b===btn));
      $$("[data-x-pane]").forEach(p=> p.hidden = p.dataset.xPane !== tab);
    }));
    $("x-open-intent")?.addEventListener("click", () => {
      const text = getText(); if (!text.trim()) { setStatus("Write text first.", "error"); return; }
      const url = xIntentUrl(text);
      window.open(url, "_blank", "noopener");
      setStatus("Opened X compose — attach downloaded image/video there manually (intent can't carry media).","ok");
    });
    $("x-copy-text")?.addEventListener("click", async () => {
      const t = getText(); if (!t) return; try { await navigator.clipboard.writeText(t); setStatus("Text copied — paste into X / Buffer / Typefully.","ok"); } catch { setStatus("Copy blocked — select and copy manually.","error"); }
    });
    $("x-copy-thread")?.addEventListener("click", async () => {
      const parts = splitIntoThread(getText(), state.premium? LIMITS.premium : LIMITS.text);
      const txt = parts.map((p,i)=> `${i+1}/${parts.length} ${p}`).join("\n\n---\n\n");
      try { await navigator.clipboard.writeText(txt); setStatus(`Thread copied (${parts.length} tweets).`, "ok"); } catch { setStatus("Copy blocked.", "error"); }
    });
    // X API publish (honest: will likely need proxy; we show message)
    $("x-api-publish")?.addEventListener("click", async () => {
      const token = $("x-api-token")?.value?.trim(); const text = getText();
      if (!text.trim()) { setStatus("Write text first.","error"); return; }
      try { setStatus("Posting via X API… (may need CORS proxy — see note below)","busy"); const res = await postViaXApi({ accessToken: token, text }); setStatus(`Posted! Tweet ID ${res.data?.id || res.id || "(see console)"}`,"ok"); console.log("[X API]", res); }
      catch (e) { setStatus(`${e.message} — Tip: X blocks browser CORS. Use the Vercel/Supabase proxy example in the X API pane or post via Web/Buffer.`, "error"); }
    });
    $("x-api-media-publish")?.addEventListener("click", async () => {
      try { await uploadMediaXApi({ accessToken: $("x-api-token")?.value, file: state.images[0] }); } catch (e) { setStatus(e.message,"error"); }
    });
    // Buffer
    $("x-buffer-send")?.addEventListener("click", async () => {
      const token = $("x-buffer-token")?.value?.trim(); const pids = ($("x-buffer-pids")?.value||"").split(",").map(s=>s.trim()).filter(Boolean); const text=getText();
      const at = $("x-buffer-when")?.value ? new Date($("x-buffer-when").value).toISOString() : null;
      try { setStatus("Queueing to Buffer…","busy"); const res = await postViaBuffer({ accessToken: token, profileIds: pids, text, scheduledAt: at }); setStatus("Buffer queued! Check Buffer → Queue.","ok"); console.log(res); }
      catch (e) { setStatus(e.message,"error"); }
    });
    // Webhook
    $("x-webhook-send")?.addEventListener("click", async () => {
      const url = $("x-webhook-url")?.value; const text=getText(); const parts = state.thread? splitIntoThread(text): [text];
      const payload = { text, thread: parts, images: state.images.length, video: !!state.videoFile, source:"dash-x-studio", createdAt: new Date().toISOString() };
      try { setStatus("Sending webhook…","busy"); await postViaWebhook({ url, payload }); setStatus("Webhook sent.","ok"); } catch (e) { setStatus(e.message,"error"); }
    });

    // Drafts & queue (local)
    const renderDrafts = () => {
      const list = loadDrafts(); if (!draftRoot) return;
      if (!list.length) { draftRoot.innerHTML = `<p class="x-muted">No drafts — save one to keep variants.</p>`; return; }
      draftRoot.innerHTML = list.map(d=> `<div class="x-queue-item"><div><strong>${escapeHtml((d.text||"").slice(0,64))||"(draft)"}</strong><div class="x-muted">${new Date(d.updatedAt).toLocaleString()} · ${(d.text||"").length} chars</div></div><div class="x-queue-actions"><button data-load-draft="${d.id}" class="modal-btn cancel">Load</button><button data-del-draft="${d.id}" class="modal-btn cancel">Delete</button></div></div>`).join("");
      draftRoot.querySelectorAll("[data-load-draft]").forEach(b=> b.addEventListener("click", ()=> {
        const found = loadDrafts().find(x=> x.id===b.dataset.loadDraft); if (found) { $("x-text").value = found.text||""; $("x-img-title").value = found.imgTitle||""; refreshScore(); setStatus("Draft loaded.","ok"); }
      }));
      draftRoot.querySelectorAll("[data-del-draft]").forEach(b=> b.addEventListener("click", ()=> { deleteDraft(b.dataset.delDraft); renderDrafts(); setStatus("Draft deleted.","ok"); }));
    };
    $("x-save-draft")?.addEventListener("click", () => {
      try {
        const doc = saveDraft({ text: getText(), imgTitle: $("x-img-title")?.value||"", style: styleSel?.value||"", hook: hookSel?.value||"" });
        renderDrafts(); setStatus(`Draft saved locally (${doc.id}).`,"ok");
      } catch (e) { setStatus(e.message, "error"); }
    });
    const renderQueue = () => {
      const list = loadQueue(); if (!queueRoot) return;
      if (!list.length) { queueRoot.innerHTML = `<p class="x-muted">Queue empty — schedule to publish later (local reminder; works while tab open, or export to Buffer/X scheduler for background delivery).</p>`; return; }
      queueRoot.innerHTML = list.map(q => `<div class="x-queue-item"><div><strong>${escapeHtml((q.text||"").slice(0,60))}</strong><div class="x-muted">${q.status} · ${q.scheduledAt? new Date(q.scheduledAt).toLocaleString(): "ASAP"} · via ${escapeHtml(q.via||"web")} ${q.error?`· <span style="color:var(--danger)">${escapeHtml(q.error)}</span>`:""}</div></div><div class="x-queue-actions"><button data-q-open="${q.id}" class="modal-btn cancel">Open intent</button><button data-q-del="${q.id}" class="modal-btn cancel">Cancel</button></div></div>`).join("");
      queueRoot.querySelectorAll("[data-q-open]").forEach(b=> b.addEventListener("click", ()=> {
        const q = loadQueue().find(x=> x.id===b.dataset.qOpen); if (q) window.open(xIntentUrl(q.text), "_blank");
      }));
      queueRoot.querySelectorAll("[data-q-del]").forEach(b=> b.addEventListener("click", ()=> { removeQueue(b.dataset.qDel); renderQueue(); }));
    };
    $("x-enqueue")?.addEventListener("click", () => {
      const text=getText(); if (!text.trim()) { setStatus("Write text first.","error"); return; }
      const when = $("x-schedule-when")?.value ? new Date($("x-schedule-when").value).toISOString() : new Date(Date.now()+ 1000*60*30).toISOString();
      const via = $("x-schedule-via")?.value || "web";
      try {
        enqueuePost({ text, scheduledAt: when, via, meta:{ premium: state.premium, hasMedia: state.hasMedia, hasVideo: !!state.videoFile } });
        renderQueue(); setStatus(`Local reminder saved for ${new Date(when).toLocaleString()}. It will not publish automatically.`,"ok");
      } catch (e) { setStatus(e.message, "error"); }
    });
    $("x-export-queue")?.addEventListener("click", () => {
      const q = loadQueue(); const blob = new Blob([JSON.stringify(q,null,2)], {type:"application/json"}); const a = d.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`x-queue-${Date.now()}.json`; a.click(); setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
    });
    $("x-export-csv")?.addEventListener("click", () => {
      const drafts = loadDrafts(); const rows = [["text","createdAt","style","hook"], ...drafts.map(x=>[`"${(x.text||"").replace(/"/g,'""')}"`, new Date(x.createdAt).toISOString(), x.style||"", x.hook||""])];
      const csv = rows.map(r=> r.join(",")).join("\n"); const blob=new Blob([csv],{type:"text/csv"}); const a=d.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`x-drafts-${Date.now()}.csv`; a.click();
    });

    // BYOK AI generate
    $("x-ai-generate")?.addEventListener("click", async () => {
      const provider = $("x-ai-provider")?.value || "groq"; const key = $("x-ai-key")?.value || ""; const topic = $("x-ai-topic")?.value || getText() || "";
      const style = styleSel?.value || "punchy"; const hook = hookSel?.value || "curiosity"; const cta = ctaSel?.value || "ask";
      if (!topic.trim()) { setStatus("Enter a topic in AI box or composer.","error"); return; }
      const prompt = buildPrompt("x_write", { topic, style, hook, cta, audience: $("x-ai-audience")?.value||"" });
      const btn = $("x-ai-generate"); btn.disabled=true; setStatus(`Asking ${PROVIDERS[provider]?.label||provider}… key goes only to that provider after your click.`,"busy");
      try {
        const raw = await generateWithProvider({ provider, key, prompt, model: $("x-ai-model")?.value||"" });
        let data; try { data = extractJson(raw); } catch { data = { posts: [{ text: raw.slice(0, 600) }] }; }
        const posts = data.posts || data.variants || (Array.isArray(data)? data: []);
        const container = $("x-ai-results"); if (container) {
          container.hidden=false; container.innerHTML = posts.slice(0,4).map((p,i)=> `<article class="x-variant"><div class="x-variant-num">#${i+1} · ${escapeHtml(p.hook||p.why||"")}</div><div class="x-variant-text">${escapeHtml(p.text||String(p).slice(0,280))}</div><button data-pick="${i}" class="modal-btn submit">Use this</button></article>`).join("") || `<div class="x-variant-text">${escapeHtml(raw.slice(0,800))}</div>`;
          container.querySelectorAll("[data-pick]").forEach(b=> b.addEventListener("click", ()=> {
            const chosen = posts[Number(b.dataset.pick)]; const t = chosen?.text || String(chosen||"");
            $("x-text").value = t; refreshScore(); setStatus("Variant loaded — tweak hook/CTA and check virality score.","ok");
          }));
        }
        setStatus("AI variants ready — pick one to load into composer.","ok");
      } catch (e) { setStatus(e.message + (e instanceof TypeError ? " Check network/CORS or try offline hooks." : ""),"error"); }
      finally { btn.disabled=false; }
    });
    $("x-ai-provider")?.addEventListener("change", e=>{
      const p = PROVIDERS[e.target.value]; if (p && $("x-ai-model")) $("x-ai-model").value = p.model; const k=$("x-ai-key"); if(k) k.value="";
    });

    renderDrafts(); renderQueue(); refreshScore(); renderImage();
    // periodic check for due queue items (local reminder only)
    setInterval(()=> {
      const now = Date.now(); let due=null;
      for (const q of loadQueue()) if (q.status==="scheduled" && q.scheduledAt && new Date(q.scheduledAt).getTime() <= now) { due=q; break; }
      if (due) {
        setStatus(`⏰ Scheduled post due: ${due.text.slice(0,80)} — opening X compose…`,"busy");
        updateQueue(due.id, { status:"due", error:"" });
        try { if (Notification && Notification.permission==="granted") new Notification("X Studio: post due", { body: due.text.slice(0,120) }); } catch {}
        window.open(xIntentUrl(due.text), "_blank");
        updateQueue(due.id, { status:"opened" }); renderQueue();
      }
    }, 30000);
    d.addEventListener("keydown", e=>{
      if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="enter") { $("x-open-intent")?.click(); }
    });
    } catch (err) {
      try { console.error("[XStudio] init failed", err); const el = doc.getElementById("x-status") || doc.getElementById("x-virality"); if (el) el.textContent = "Init error: " + (err.message || err); } catch {}
    }
  }

  function escapeHtml(s) {
    return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  return {
    VERSION,
    STORAGE,
    LIMITS,
    X_SPECS,
    HOOKS,
    CTAS,
    STYLES,
    PROVIDERS,
    IMAGE_TEMPLATES,
    PALETTES,
    clean,
    countChars,
    splitIntoThread,
    scorePost,
    buildPrompt,
    xIntentUrl,
    xIntentLegacyUrl,
    bufferPayload,
    safeStorage, loadDrafts, saveDraft, deleteDraft, loadQueue, saveQueue, enqueuePost, updateQueue, removeQueue,
    drawPostImage,
    wrapLines,
    imageTemplateKinds,
    generateWithProvider,
    extractJson,
    postViaXApi,
    uploadMediaXApi,
    postViaBuffer,
    postViaWebhook,
    initXStudio,
    aspectForX: (v)=> v==="9:16" ? [720,1280] : v==="1:1" ? [720,720] : [1280,720]
  };
});
