// BYOK AI assistant for expanding notebook sections.
// Reuses the provider patterns from notes-workspace.js but simplified for notebook.
// Supports Groq, OpenRouter, Google Gemini — all BYOK.

const PROVIDERS = {
  groq: { label: "Groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", defaultModel: "llama-3.1-8b-instant" },
  openrouter: { label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", defaultModel: "meta-llama/llama-3.1-8b-instruct:free" },
  google: { label: "Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta/models", defaultModel: "gemini-2.0-flash-lite" }
};

export function providerLabels() { return Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])); }
export function providerOptions() { return Object.entries(PROVIDERS).map(([value, { label }]) => ({ value, label })); }

export function getStoredKey(provider) {
  try {
    const raw = localStorage.getItem("zc.byok.v1");
    if (!raw) return "";
    const obj = JSON.parse(raw);
    return obj?.[provider] || "";
  } catch { return ""; }
}

export function buildExpandPrompt({ sectionTitle, sectionContent, instruction = "" }) {
  const base = `You are a helpful writing assistant. Expand the markdown section titled "${sectionTitle}" below into clear, detailed content.
Keep the original heading. Use sub-headings (###), bullets, and examples where helpful. Stay on topic. Do not invent citations.

Current section content:
---
${sectionContent || "(empty — create from scratch)"}
---

${instruction ? `Additional instruction: ${instruction}` : "Expand with concrete detail and practical guidance."}

Return only the expanded markdown for this section, starting with the heading.`;
  return base;
}

export async function expandSection({ provider, apiKey, model, sectionTitle, sectionContent, instruction }, { signal } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error(`Missing ${cfg.label} API key`);

  const prompt = buildExpandPrompt({ sectionTitle, sectionContent, instruction });
  const mdl = (model || cfg.defaultModel).trim();

  if (provider === "google") {
    const url = `${cfg.endpoint}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
      }),
      signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `Gemini error ${res.status}`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("Gemini returned no content");
    return text.trim();
  }

  // OpenAI-compatible (Groq, OpenRouter)
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "Dash Notebook";
  }
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: mdl,
      messages: [
        { role: "system", content: "You are a concise, helpful markdown writing assistant." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1400
    }),
    signal
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `${cfg.label} error ${res.status}`);
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(`${cfg.label} returned no content`);
  return text.trim();
}

// Optional: summarize tasks for inline aggregation via AI
export function buildTasksPrompt(tasks) {
  if (!tasks.length) return "";
  return `Given these task items from a note, suggest 3 grouped next-action lists and flag any vague tasks:\n\n${tasks.map(t => `- [${t.checked ? "x" : " "}] ${t.text} (${t.group})`).join("\n")}`;
}

export async function askWithContext({ provider, apiKey, model, question, excerpts }, { signal } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error(`Missing ${cfg.label} key`);
  const mdl = (model || cfg.defaultModel).trim();
  const contextBlock = excerpts.slice(0, 4).map((e, i) => `Excerpt ${i + 1} (${e.path}):\n${e.body.slice(0, 3000)}`).join("\n\n---\n\n");
  const prompt = `Use only the excerpts below to answer. If the answer isn't in them, say so.

Excerpts:
${contextBlock}

Question: ${question}

Answer in markdown, citing which excerpt you used.`;
  if (provider === "google") {
    const url = `${cfg.endpoint}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini error ${res.status}`);
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  }
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (provider === "openrouter") { headers["HTTP-Referer"] = location.origin; headers["X-Title"] = "Dash Notebook"; }
  const res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify({ model: mdl, messages: [{ role: "system", content: "Answer using only the provided excerpts." }, { role: "user", content: prompt }], temperature: 0.3 }), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `${cfg.label} error ${res.status}`);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

export const PROVIDER_META = PROVIDERS;
