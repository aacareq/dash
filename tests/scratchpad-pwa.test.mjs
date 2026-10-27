// Behavior tests for the Scratchpad PWA modules (no browser, no jsdom needed —
// the modules under test are pure logic plus a storage-interface-driven client).
//
//   node --test tests/
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";

import {
  renderMarkdown, toggleTaskLine, escapeHtml, datedFileName,
  encodeUtf8Base64, decodeUtf8Base64
} from "../assets/markdown.js";
import { filterEmoji, ALL_EMOJI, EMOJI_GROUPS } from "../assets/emoji.js";
import {
  MemoryStore, planLegacyMigration, classifySyncError, nextOutboxAction,
  makeOutboxEntry, LEGACY_KEYS, ACTIVE_NOTE_ID
} from "../assets/notes-store.js";
import {
  GitHubAppClient, GH_KEYS, SCRATCH_REPO, pkcs1ToPkcs8, base64UrlFromText
} from "../assets/github-app.js";
import { SyncEngine } from "../assets/sync-engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- markdown ---------------------------------------------------------------------------
test("markdown: escapes HTML before decorating (XSS boundary)", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  const linked = renderMarkdown("[x](javascript:alert(1))");
  // Non-http(s) links never become anchors — the javascript: URL stays inert text.
  assert.ok(!linked.includes('href="javascript:'));
  assert.ok(linked.includes("javascript:alert(1)"));
  const safeLink = renderMarkdown("[dash](https://example.com/a)");
  assert.ok(safeLink.includes('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">dash</a>'));
});

test("markdown: headings, bold and task lines keep stable line indices", () => {
  const src = "# Title\n\n- [ ] first task\n- [x] done task\n\n**bold** and *italic*";
  const html = renderMarkdown(src);
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  const taskMatch = html.match(/data-md-line="2"[^>]*\/>/);
  assert.ok(taskMatch, "first task is on source line 2");
  assert.ok(html.includes('data-md-line="3"') && html.includes("checked"));
});

test("markdown: fenced code is escaped but not decorated", () => {
  const html = renderMarkdown("```\n<b>not html</b>\n**not bold**\n```");
  assert.ok(html.includes("<pre><code>&lt;b&gt;not html&lt;/b&gt;\n**not bold**</code></pre>"));
});

test("markdown: toggleTaskLine flips only the named line", () => {
  const src = "- [ ] one\n- [ ] two";
  const next = toggleTaskLine(src, 1, true);
  assert.equal(next, "- [ ] one\n- [x] two");
  const back = toggleTaskLine(next, 1, false);
  assert.equal(back, src);
  assert.equal(toggleTaskLine(src, 99, true), src, "unknown line is a no-op");
});

test("markdown: dated filename and utf-8 base64 round trip", () => {
  assert.match(datedFileName(new Date(2026, 9, 27, 15, 4)), /^notes-2026-10-27-1504\.md$/);
  const unicode = "café — 🚀";
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(unicode)), unicode);
  assert.equal(escapeHtml(`a&b<c>"d"'`), "a&amp;b&lt;c&gt;&quot;d&quot;&#39;");
});

// ---- emoji ------------------------------------------------------------------------------
test("emoji: keyword search and grouped data", () => {
  assert.ok(EMOJI_GROUPS.length >= 5);
  assert.ok(ALL_EMOJI.every(item => item.char && item.keywords));
  const fire = filterEmoji("fire");
  assert.ok(fire.some(item => item.char === "🔥"));
  assert.equal(filterEmoji("zzz-no-match").length, 0);
  assert.equal(filterEmoji("").length, ALL_EMOJI.length);
});

// ---- storage: migration + outbox rules --------------------------------------------------
test("migration: plans kv entries and the note body from a localStorage snapshot", () => {
  const snapshot = {
    [LEGACY_KEYS.note]: "my old notes",
    [LEGACY_KEYS.app]: JSON.stringify({ app_id: 1, pem: "p" }),
    [LEGACY_KEYS.repo]: "octocat/scratch",
    [LEGACY_KEYS.preview]: "true",
    "unrelated-key": "ignored",
    [LEGACY_KEYS.path]: "" // empty values are skipped
  };
  const plan = planLegacyMigration(snapshot);
  assert.equal(plan.noteBody, "my old notes");
  const keys = plan.kvEntries.map(entry => entry.key);
  assert.deepEqual(keys, [LEGACY_KEYS.preview, LEGACY_KEYS.app, LEGACY_KEYS.repo]);
});

test("migration: empty snapshot migrates nothing", () => {
  const plan = planLegacyMigration({});
  assert.deepEqual(plan.kvEntries, []);
  assert.equal(plan.noteBody, "");
});

test("outbox: error classification matrix", () => {
  assert.equal(classifySyncError({ status: 401 }), "auth");
  assert.equal(classifySyncError({ status: 403 }), "auth");
  assert.equal(classifySyncError({ status: 404 }), "auth");
  assert.equal(classifySyncError({ status: 409, message: "does not match" }), "conflict");
  assert.equal(classifySyncError({ status: 422, message: "is a directory" }), "fatal");
  assert.equal(classifySyncError({ status: 429 }), "transient");
  assert.equal(classifySyncError({ status: 502 }), "transient");
  assert.equal(classifySyncError({ name: "AbortError" }), "transient");
  assert.equal(classifySyncError({ message: "Failed to fetch" }), "transient");
});

test("outbox: next action depends on remote sha", () => {
  const entry = makeOutboxEntry({ repo: "o/r", path: "n.md", content: "x", sha: "sha-1" });
  assert.ok(entry.id && entry.createdAt && entry.attempts === 0);
  assert.equal(nextOutboxAction(entry, null), "create");
  assert.equal(nextOutboxAction(entry, { sha: "sha-1" }), "put");
  assert.equal(nextOutboxAction(entry, { sha: "sha-2" }), "conflict");
});

test("MemoryStore: notes, kv and outbox round trip", async () => {
  const store = new MemoryStore();
  await store.open();
  assert.equal(await store.kvGet("missing"), null);
  await store.kvSet("k", "v");
  assert.equal(await store.kvGet("k"), "v");
  await store.putNote({ id: ACTIVE_NOTE_ID, body: "hello" });
  assert.equal((await store.getNote(ACTIVE_NOTE_ID)).body, "hello");
  const queued = makeOutboxEntry({ repo: "o/r", path: "n.md", content: "c" });
  await store.enqueueOutbox(queued);
  assert.equal((await store.listOutbox()).length, 1);
  await store.updateOutbox(queued.id, { attempts: 2 });
  assert.equal((await store.listOutbox())[0].attempts, 2);
  await store.removeOutbox(queued.id);
  assert.equal((await store.listOutbox()).length, 0);
});

// ---- GitHub App client ------------------------------------------------------------------
function makeFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return handler(url, options, calls);
  };
  return { fetchImpl, calls };
}
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => payload
});

test("GitHub client: connection kinds and SHA memory", async () => {
  const store = new MemoryStore();
  const gh = new GitHubAppClient(store);
  assert.equal((await gh.connection()).kind, "none");

  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_x", login: "octocat" }));
  const tokenConn = await gh.connection();
  assert.equal(tokenConn.kind, "token");
  assert.equal(tokenConn.label, "octocat");

  await gh.writeApp({ app_id: 7, pem: "pem", installation_id: 42, installation_account: "octocat" });
  const appConn = await gh.connection();
  assert.equal(appConn.kind, "app");
  assert.equal(appConn.installationId, 42);
  assert.ok(appConn.ready);

  await gh.rememberSha("o/r@default:n.md", "sha-9");
  assert.equal(await gh.storedSha("o/r@default:n.md"), "sha-9");
  await gh.rememberSha("o/r@default:n.md", null);
  assert.equal(await gh.storedSha("o/r@default:n.md"), null);
});

test("GitHub client: authorizedFetch uses the pasted token", async () => {
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_x" }));
  const { fetchImpl, calls } = makeFakeFetch(() => jsonResponse({ ok: true }));
  const gh = new GitHubAppClient(store, { fetchImpl });
  await gh.authorizedFetch("/user/repos");
  assert.equal(calls[0].url, "https://api.github.com/user/repos");
  assert.match(calls[0].options.headers.Authorization, /^Bearer ghp_x$/);
});

test("GitHub client: writeRepoFile sends base64 content and sha", async () => {
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_x" }));
  const { fetchImpl, calls } = makeFakeFetch(() => jsonResponse({ content: { sha: "new-sha" } }));
  const gh = new GitHubAppClient(store, { fetchImpl });
  const result = await gh.writeRepoFile({ repo: "o/r", path: "notes/n.md", content: "héllo", sha: "old" });
  assert.equal(result.content.sha, "new-sha");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.sha, "old");
  assert.equal(body.content, encodeUtf8Base64("héllo"));
  assert.ok(calls[0].url.endsWith("/repos/o/r/contents/notes/n.md"));
});

test("GitHub client: readRepoFile returns null on 404 and throws on directories", async () => {
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_x" }));
  const gh404 = new GitHubAppClient(store, { fetchImpl: () => jsonResponse({}, 404) });
  assert.equal(await gh404.readRepoFile("o/r", "n.md"), null);

  const ghDir = new GitHubAppClient(store, { fetchImpl: () => jsonResponse({ type: "dir" }) });
  await assert.rejects(() => ghDir.readRepoFile("o/r", "n.md"), /directory/);
});

test("GitHub client: ensureScratchRepo posts a private auto_init repo", async () => {
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_x" }));
  const { fetchImpl, calls } = makeFakeFetch(() => jsonResponse({ full_name: `octocat/${SCRATCH_REPO}` }));
  const gh = new GitHubAppClient(store, { fetchImpl });
  const result = await gh.ensureScratchRepo();
  assert.equal(result.ok, true);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.name, SCRATCH_REPO);
  assert.equal(body.private, true);
  assert.equal(body.auto_init, true);
});

test("GitHub client: manifest requests least-privilege permissions", () => {
  const gh = new GitHubAppClient(new MemoryStore());
  const manifest = gh.buildManifest("https://example.com/dash/scratchpad.html");
  assert.equal(manifest.redirect_url, "https://example.com/dash/scratchpad.html");
  assert.deepEqual(manifest.default_permissions, {
    contents: "write", metadata: "read", repository_creation: "write"
  });
  assert.deepEqual(manifest.default_events, []);
});

test("GitHub client: signs an RS256 app JWT from a PKCS#1 PEM", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1Der = privateKey.export({ type: "pkcs1", format: "der" });
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${pkcs1Der.toString("base64")}\n-----END RSA PRIVATE KEY-----\n`;
  // The PKCS#1 → PKCS#8 wrapper must produce an importable key.
  const wrapped = pkcs1ToPkcs8(pkcs1Der);
  assert.ok(wrapped instanceof Uint8Array && wrapped.length > pkcs1Der.length);

  const store = new MemoryStore();
  const gh = new GitHubAppClient(store);
  const jwt = await gh.appJwt({ app_id: 99, pem });
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(decoded.iss, "99");
  assert.ok(decoded.exp - decoded.iat > 400);
  assert.equal(base64UrlFromText("ab+c/"), "YWIrYy8");
});

// ---- page/module wiring -----------------------------------------------------------------
test("scratchpad.html exposes every id the controller queries", () => {
  const html = readFileSync(join(ROOT, "scratchpad.html"), "utf8");
  const js = readFileSync(join(ROOT, "assets/scratchpad.js"), "utf8");
  const ids = new Set();
  for (const match of js.matchAll(/\$\("([\w-]+)"\)/g)) ids.add(match[1]);
  for (const match of js.matchAll(/getElementById\("([\w-]+)"\)/g)) ids.add(match[1]);
  const missing = [...ids].filter(id => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `missing ids: ${missing.join(", ")}`);
});

test("service worker precaches only files that exist", () => {
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const entries = [...sw.matchAll(/"(\.\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(entries.includes("./scratchpad.html"));
  assert.ok(entries.includes("./manifest.webmanifest"));
  for (const entry of entries) {
    const relative = entry.replace(/^\.\//, "");
    assert.ok(existsSync(join(ROOT, relative)), `precached ${entry} is missing on disk`);
  }
});

// ---- SyncEngine: offline queue lifecycle ------------------------------------------------
function makeConnectedGh(store, { offline = false } = {}) {
  const remote = new Map(); // "repo:path" -> { sha, content }
  let counter = 0;
  const fetchImpl = async (url, options = {}) => {
    if (offline) throw new TypeError("Failed to fetch");
    if (url.includes("/access_tokens")) return jsonResponse({ token: "installation-token" });
    if (url.includes("/installation/repositories")) return jsonResponse({ repositories: [] });
    if (url.includes("/contents/")) {
      const key = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      if ((options.method || "GET") === "PUT") {
        const body = JSON.parse(options.body);
        const existing = remote.get(key);
        if (body.sha && existing && body.sha !== existing.sha) {
          return jsonResponse({ message: "sha does not match" }, 409);
        }
        counter += 1;
        const record = { sha: `sha-${counter}`, content: decodeUtf8Base64(body.content) };
        remote.set(key, record);
        return jsonResponse({ content: { sha: record.sha } });
      }
      const record = remote.get(key);
      if (!record) return jsonResponse({}, 404);
      return jsonResponse({ type: "file", sha: record.sha, content: encodeUtf8Base64(record.content) });
    }
    return jsonResponse({}, 404);
  };
  const gh = new GitHubAppClient(store, { fetchImpl });
  return { gh, remote };
}

async function connectedStore() {
  // Pasted-token connection: exercises the same Contents path without minting an
  // app JWT (the RS256 path has its own test below with a real generated key).
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: "ghp_test", login: "octocat" }));
  return store;
}

test("engine: create then update commits and remembers the sha", async () => {
  const store = await connectedStore();
  const { gh, remote } = makeConnectedGh(store);
  const engine = new SyncEngine(store, gh);
  const target = { repo: "octocat/scratch", path: "notes-1.md", branch: "", content: "first" };

  const created = await engine.saveNote(target);
  assert.equal(created.status, "created");
  assert.equal(remote.get("notes-1.md").content, "first");

  const updated = await engine.saveNote({ ...target, content: "second" });
  assert.equal(updated.status, "updated");
  assert.equal(remote.get("notes-1.md").content, "second");
  assert.equal((await store.listOutbox()).length, 0);
  assert.equal(await gh.storedSha(engine.fileKey(target.repo, target.path, "")), "sha-2");
});

test("engine: offline edits queue, merge per file, and flush on reconnect", async () => {
  const store = await connectedStore();
  const offline = makeConnectedGh(store, { offline: true });
  const engine = new SyncEngine(store, offline.gh);
  const target = { repo: "octocat/scratch", path: "notes-2.md", branch: "", content: "v1" };

  assert.equal((await engine.saveNote(target)).status, "queued");
  assert.equal((await store.listOutbox()).length, 1);
  assert.equal((await engine.saveNote({ ...target, content: "v2 newest" })).status, "queued");
  const queued = await store.listOutbox();
  assert.equal(queued.length, 1, "repeated offline edits collapse into one pending commit");
  assert.equal(queued[0].content, "v2 newest");

  // Reconnect: a new client over the same persisted store and shared remote state.
  const online = makeConnectedGh(store);
  online.remote.clear(); // nothing was committed while offline
  const onlineEngine = new SyncEngine(store, online.gh);
  const flush = await onlineEngine.flush();
  assert.equal(flush.status, "flushed");
  assert.equal(flush.delivered, 1);
  assert.equal((await store.listOutbox()).length, 0);
  assert.equal(online.remote.get("notes-2.md").content, "v2 newest");
});

test("engine: a remote change pauses the save until forced", async () => {
  const store = await connectedStore();
  const { gh, remote } = makeConnectedGh(store);
  const engine = new SyncEngine(store, gh);
  const target = { repo: "octocat/scratch", path: "notes-3.md", content: "local" };
  await engine.saveNote(target);

  // Someone else edits the same file on GitHub.
  remote.set("notes-3.md", { sha: "sha-foreign", content: "remote edit" });

  const clash = await engine.saveNote({ ...target, content: "local edit" });
  assert.equal(clash.status, "conflict");
  assert.equal(engine.conflictPaused, true);

  const forced = await engine.saveNote({ ...target, content: "local edit", forced: true });
  assert.equal(forced.status, "updated");
  assert.equal(engine.conflictPaused, false);
  assert.equal(remote.get("notes-3.md").content, "local edit");
});

test("engine: flush stops at a conflict instead of overwriting", async () => {
  const store = await connectedStore();
  const offline = makeConnectedGh(store, { offline: true });
  const engine = new SyncEngine(store, offline.gh);
  await engine.saveNote({ repo: "octocat/scratch", path: "notes-4.md", content: "offline" });

  const online = makeConnectedGh(store);
  online.remote.set("notes-4.md", { sha: "sha-other", content: "already there" });
  const result = await new SyncEngine(store, online.gh).flush();
  assert.equal(result.status, "conflict");
  assert.equal((await store.listOutbox()).length, 1, "the conflicting entry stays queued");
});

test("engine: pull reports missing vs loaded, and honors disconnects", async () => {
  const store = await connectedStore();
  const { gh } = makeConnectedGh(store);
  const engine = new SyncEngine(store, gh);
  const target = { repo: "octocat/scratch", path: "notes-5.md", branch: "" };

  assert.equal((await engine.pull(target)).status, "missing");
  await engine.saveNote({ ...target, content: "hello" });
  const loaded = await engine.pull(target);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.content, "hello");

  const blankStore = new MemoryStore();
  const blank = new SyncEngine(blankStore, new GitHubAppClient(blankStore));
  assert.equal((await blank.saveNote({ ...target, content: "x" })).status, "disconnected");
  assert.equal((await blank.pull(target)).status, "disconnected");
  await blankStore.enqueueOutbox(makeOutboxEntry({ repo: "o/r", path: "p.md", content: "c" }));
  assert.equal((await blank.flush()).status, "disconnected");
});

test("manifest is installable: required fields and icon files", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.webmanifest"), "utf8"));
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(["standalone", "fullscreen", "minimal-ui"].includes(manifest.display));
  assert.equal(manifest.start_url, "./scratchpad.html");
  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(ROOT, icon.src.replace(/^\.\//, ""))), `icon ${icon.src} missing`);
  }
});
