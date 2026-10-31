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
  makeOutboxEntry, LEGACY_KEYS, ACTIVE_NOTE_ID,
  withLocalStorageMirror, MIRRORED_KEYS
} from "../assets/notes-store.js";
import {
  GitHubAppClient, GH_KEYS, SCRATCH_REPO, pkcs1ToPkcs8, base64UrlFromText,
  connectionFileFor, connectionFileText, connectionFileName,
  parseConnectionInput, parsePrivateKey
} from "../assets/github-app.js";
import { SyncEngine } from "../assets/sync-engine.js";
import { NoteManager, todayNoteFileName, NOTES_INDEX_KEY } from "../assets/notes-manager.js";
import { isEmbedded, isIos, isStandaloneDisplay } from "../assets/environment.js";

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

test("markdown: pipe tables render with header, rows and alignment", () => {
  const html = renderMarkdown([
    "| Tool | Cost | Where |",
    "| :--- | ---: | :-: |",
    "| **Scratchpad** | free | here |",
    "| Clipboard | free | here too |"
  ].join("\n"));
  assert.ok(html.includes('<div class="md-table"><table>'));
  assert.ok(html.includes("<thead><tr>"));
  assert.ok(html.includes('<th style="text-align:left">Tool</th>'));
  assert.ok(html.includes('<th style="text-align:right">Cost</th>'));
  assert.ok(html.includes('<th style="text-align:center">Where</th>'));
  assert.ok(html.includes("<tbody>"));
  assert.ok(html.includes("<strong>Scratchpad</strong>"), "cell content is decorated like any other inline text");
  assert.equal((html.match(/<tr>/g) || []).length, 3, "one header row + two body rows");
});

test("markdown: table cells escape HTML and honour \\| and ragged rows", () => {
  const html = renderMarkdown([
    "| Note | Detail |",
    "| --- | --- |",
    "| <img src=x onerror=alert(1)> | a \\| b |",
    "| only one cell"
  ].join("\n"));
  assert.ok(!html.includes("<img"), "pasted HTML never becomes an element");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("<td>a | b</td>"), "an escaped pipe stays inside its cell");
  assert.ok(html.includes("<td>only one cell</td><td></td>"), "short rows are padded, not dropped");
});

test("markdown: a header row without a separator stays a paragraph", () => {
  const html = renderMarkdown("| just | text |\nno separator here");
  assert.ok(!html.includes("md-table"));
  assert.ok(html.includes("<p>| just | text |</p>"));
});

test("markdown: the dashboard dialog and the PWA render tables identically", () => {
  // Two copies of the renderer exist (index.html inline, assets/markdown.js). Extract the inline one and
  // compare bytes, so a table can never render differently depending on which surface you open.
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const start = html.indexOf("function renderScratchpadMarkdown");
  const end = html.indexOf("// ---- Scratchpad emoji picker", start);
  const dialogRender = new Function(html.slice(start, end) + "; return renderScratchpadMarkdown;")();
  const samples = [
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    "| A | B |\n|:--|--:|\n| `x` | **y** |\n| <b>z</b> | [l](https://example.com) |",
    "before\n\n| one |\n| --- |\n| two |\n\nafter",
    "# heading\n| a | b |\n| :-: | :-: |\n| 1 | 2 |"
  ];
  samples.forEach(sample => assert.equal(dialogRender(sample), renderMarkdown(sample), sample));
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

// ---- environment helpers ---------------------------------------------------------------
test("environment: embed detection honors the param and frame state", () => {
  assert.equal(isEmbedded({ search: "?embed=1", framed: false }), true);
  assert.equal(isEmbedded({ search: "", framed: true }), true);
  assert.equal(isEmbedded({ search: "?x=1", framed: false }), false);
  assert.equal(isEmbedded({ search: "?embed=0", framed: false }), false);
  assert.equal(isIos("Mozilla (iPhone; CPU iPhone OS 17)"), true);
  assert.equal(isIos("Mozilla (Macintosh)"), false);
  assert.equal(isStandaloneDisplay(true), true);
  assert.equal(isStandaloneDisplay(false), false);
  assert.equal(isStandaloneDisplay(), false);
});

// ---- dashboard integration -------------------------------------------------------------
test("dashboard links the manifest and registers the PWA module", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /<script type="module" src="assets\/dashboard-pwa\.js"><\/script>/);
  assert.match(html, /id="install-app"/);
  assert.match(html, /id="ios-hint"/);
  assert.match(html, /id="sw-update-toast"/);
});

test("dashboard scratchpad dialog keeps one dialog and adds the embed toggle + iframe", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.equal((html.match(/id="modal-scratchpad"/g) || []).length, 1);
  for (const id of [
    "scratchpad-inline-view", "scratchpad-embed-view", "scratchpad-app-frame",
    "btn-scratchpad-view-inline", "btn-scratchpad-view-app"
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `missing #${id}`);
  }
  const frame = html.match(/<iframe id="scratchpad-app-frame"[^>]*>/)[0];
  assert.match(frame, /src="about:blank"/, "iframe is empty until first switched to app view");
  assert.match(frame, /loading="lazy"/);
});

test("dashboard module points the lazy iframe at the embedded PWA", () => {
  const js = readFileSync(join(ROOT, "assets/dashboard-pwa.js"), "utf8");
  assert.match(js, /scratchpad\.html\?embed=1/);
  assert.match(js, /setupPwaInstall/);
  assert.match(js, /dialog\.addEventListener\("close"/);
});

test("embedded PWA redirects one-time GitHub setup to a top-level tab", () => {
  const js = readFileSync(join(ROOT, "assets/scratchpad.js"), "utf8");
  assert.match(js, /isEmbedded\(/);
  assert.match(js, /window\.open\(gh\.pageUrl\(\), "_blank", "noopener"\)/);
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

// ---- localStorage mirror: GitHub App persistence across surfaces ----------------------
function fakeLegacy(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    dump: () => Object.fromEntries(map)
  };
}

test("mirror: write-through keeps the dashboard dialog's localStorage converged", async () => {
  const legacy = fakeLegacy();
  const store = withLocalStorageMirror(new MemoryStore(), legacy);
  await store.kvSet(GH_KEYS.app, JSON.stringify({ app_id: 1, pem: "p" }));
  assert.equal(legacy.getItem(GH_KEYS.app), JSON.stringify({ app_id: 1, pem: "p" }));
  // Non-mirrored keys never touch localStorage.
  await store.kvSet("dash-scratchpad-notes-index", "[]");
  assert.equal(legacy.getItem("dash-scratchpad-notes-index"), null);
  await store.kvDelete(GH_KEYS.app);
  assert.equal(legacy.getItem(GH_KEYS.app), null);
});

test("mirror: an app created in the dialog is adopted even after migration ran", async () => {
  const legacy = fakeLegacy({ [GH_KEYS.app]: JSON.stringify({ app_id: 9, pem: "pem", installation_id: 3 }) });
  const store = withLocalStorageMirror(new MemoryStore(), legacy);
  // IndexedDB has nothing (fresh PWA profile, migration marker already set elsewhere).
  assert.equal(await store.kvGet("unrelated-key"), null);
  const adopted = JSON.parse(await store.kvGet(GH_KEYS.app));
  assert.equal(adopted.app_id, 9);
  assert.equal(adopted.installation_id, 3);
  // Adoption is one-way into IndexedDB; subsequent reads need no legacy lookup.
  legacy.removeItem(GH_KEYS.app);
  assert.equal(JSON.parse(await store.kvGet(GH_KEYS.app)).app_id, 9);
  assert.ok(MIRRORED_KEYS.has(GH_KEYS.app));
});

test("mirror: without a legacy store the wrapper is a pass-through", async () => {
  const base = new MemoryStore();
  assert.equal(withLocalStorageMirror(base, null), base);
});

// ---- NoteManager: today's note vs separate notes --------------------------------------
test("note manager: today's note is stable per date and distinct from a new dated note", async () => {
  const clock = (() => { let t = new Date(2026, 9, 27, 9, 5); return () => t; })();
  const store = new MemoryStore();
  const notes = new NoteManager(store, { now: clock });
  assert.equal(todayNoteFileName(clock()), "notes-2026-10-27.md");

  const today = await notes.openToday();
  assert.equal(today.path, "notes-2026-10-27.md");
  await notes.setBody("morning thought");
  // Reopening "today" later in the day returns the SAME record, body intact.
  const again = await notes.openToday();
  assert.equal(again.id, today.id);
  assert.equal(again.body, "morning thought");

  const another = await notes.newDatedNote();
  assert.match(another.path, /^notes-2026-10-27-0905\.md$/);
  assert.notEqual(another.id, today.id);
  await notes.setBody("separate note");

  // Switching back restores today's note untouched.
  const back = await notes.openToday();
  assert.equal(back.body, "morning thought");
});

test("note manager: switching notes persists the previous one and keeps an index", async () => {
  const store = new MemoryStore();
  let tick = new Date(2026, 9, 27, 14, 30).getTime();
  const notes = new NoteManager(store, { now: () => new Date(tick++) });
  await notes.boot({ fallbackPath: "notes-2026-10-27.md" });
  await notes.setBody("first");
  await notes.newDatedNote();
  const index = JSON.parse(await store.kvGet(NOTES_INDEX_KEY));
  assert.equal(index.length, 2);
  assert.equal(index[0].path, notes.current.path, "most recent note floats to the top");
  // The first note's body survived the switch.
  const first = await store.getNote("note:notes-2026-10-27.md");
  assert.equal(first.body, "first");
  // A fresh manager reopens the most recent note.
  const reopened = new NoteManager(store, { now: () => new Date(2026, 9, 28, 8, 0) });
  const booted = await reopened.boot({ fallbackPath: todayNoteFileName(new Date(2026, 9, 28)) });
  assert.equal(booted.path, notes.current.path);
});

test("note manager: rejects blank paths", async () => {
  const notes = new NoteManager(new MemoryStore());
  await assert.rejects(() => notes.switchTo("  "), /required/);
});

// ---- dashboard card + page wiring ------------------------------------------------------
test("dashboard scratchpad card carries a new-tab App anchor", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.match(script, /card-action card-action-link/);
  assert.match(script, /appLink\.href = "scratchpad\.html"/);
  assert.match(script, /appLink\.target = "_blank"/);
  assert.match(script, /appLink\.rel = "noopener noreferrer"/);
  assert.match(script, /item\.modal === "modal-scratchpad"/);
});

test("scratchpad page exposes the note switcher buttons", () => {
  const html = readFileSync(join(ROOT, "scratchpad.html"), "utf8");
  for (const id of ["note-open-today", "note-new-dated", "note-current"]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `missing #${id}`);
  }
});

test("service worker precaches the note manager and bumped its cache version", () => {
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  // The version itself moves every time a precached asset changes; what must not go backwards is
  // that it is at least as new as the release that introduced the sheet UI, the ⋯ menu and tables.
  const version = Number(/CACHE_VERSION = "dash-scratch-v(\d+)"/.exec(sw)?.[1]);
  assert.ok(version >= 4, `sw.js CACHE_VERSION is dash-scratch-v${version}, expected v4 or later`);
  assert.match(sw, /"\.\/assets\/notes-manager\.js"/);
});

// ---- reconnect kit ---------------------------------------------------------------------
// The app's private key lives only in one browser's storage at one address, so a new device,
// browser or preview URL used to mean "Create GitHub App" again. A connection file (or the same
// key re-downloaded from GitHub) is enough to adopt the existing app instead.

const connectionApp = () => ({
  app_id: 987654,
  slug: "dash-notes-example",
  name: "dash notes",
  owner: "octocat",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBAK\n-----END RSA PRIVATE KEY-----",
  html_url: "https://github.com/apps/dash-notes-example",
  installation_id: 424242,
  installation_token: "ghs_should_not_be_exported",
  connection_saved_at: 123
});

test("connection file: exports the key and identity, never cached tokens or shas", () => {
  const file = connectionFileFor(connectionApp());
  assert.equal(file.kind, "dash-github-connection");
  assert.equal(file.version, 1);
  assert.equal(file.app_id, 987654);
  assert.equal(file.slug, "dash-notes-example");
  assert.equal(file.owner, "octocat");
  assert.match(file.pem, /BEGIN RSA PRIVATE KEY/);
  assert.ok(!("installation_token" in file), "a cached installation token is short-lived and must not travel");
  assert.ok(!("installation_id" in file), "the installation is re-discovered by the app, not carried in the file");
  assert.ok(file.note && /password manager/i.test(file.note));
  assert.equal(connectionFileName(connectionApp()), "dash-github-connection-dash-notes-example.json");
  assert.equal(connectionFileName({ app_id: 5 }), "dash-github-connection-5.json");
  // (exported_at is a fresh timestamp per call, so compare everything else)
  const { exported_at: _ignored, ...fromText } = JSON.parse(connectionFileText(connectionApp()));
  const { exported_at: _ignoredToo, ...fromObject } = file;
  assert.deepEqual(fromText, fromObject);
});

test("connection file: parses back into an adoptable app", () => {
  const parsed = parseConnectionInput(connectionFileText(connectionApp()));
  assert.equal(parsed.app_id, 987654);
  assert.equal(parsed.slug, "dash-notes-example");
  assert.equal(parsed.owner, "octocat");
  assert.match(parsed.pem, /BEGIN RSA PRIVATE KEY/);
});

test("connection file: accepts GitHub's own manifest-conversion JSON", () => {
  const conversion = JSON.stringify({
    id: 4321, slug: "my-notes", name: "dash notes", owner: { login: "octocat" },
    pem: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    html_url: "https://github.com/apps/my-notes", client_secret: "shhh"
  });
  const parsed = parseConnectionInput(conversion);
  assert.equal(parsed.app_id, 4321);
  assert.equal(parsed.owner, "octocat");
  assert.equal(parsed.html_url, "https://github.com/apps/my-notes");
});

test("connection file: a bare .pem works when the App ID is supplied separately", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";
  assert.equal(parseConnectionInput(pem, { appId: "777" }).app_id, 777);
  // A pasted key body without its header is rebuilt rather than rejected.
  const body = Buffer.alloc(120, 7).toString("base64");
  assert.match(parsePrivateKey(body), /^-----BEGIN RSA PRIVATE KEY-----\n[\s\S]+\n-----END RSA PRIVATE KEY-----$/);
  // Surrounding text (a whole settings page, say) still yields the key.
  assert.match(parsePrivateKey(`App ID: 1\n${pem}`), /BEGIN RSA PRIVATE KEY/);
});

test("connection file: explains what is wrong instead of failing opaquely", () => {
  assert.throws(() => parseConnectionInput(""), /connection file, or paste/i);
  assert.throws(() => parseConnectionInput("not a key"), /doesn't look like a private key/i);
  assert.throws(() => parseConnectionInput("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), /numeric ID/i);
  assert.throws(() => parseConnectionInput("{oops", { appId: 1 }), /valid JSON/i);
  assert.throws(() => parsePrivateKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----"), /passphrase/i);
});

test("adoptApp: GitHub confirms the pair, and its answer becomes the record", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const store = new MemoryStore();
  const { fetchImpl, calls } = makeFakeFetch(() => jsonResponse({
    id: 5150, slug: "recovered-app", name: "dash notes", owner: { login: "octocat" },
    html_url: "https://github.com/apps/recovered-app"
  }));
  const gh = new GitHubAppClient(store, { fetchImpl });
  const record = await gh.adoptApp({ app_id: 5150, pem });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/app");
  const jwt = calls[0].options.headers.Authorization.replace("Bearer ", "");
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.equal(payload.iss, "5150", "the JWT is signed as the app being adopted");

  assert.equal(record.slug, "recovered-app");
  assert.equal(record.owner, "octocat");
  assert.equal(record.installation_id, null, "the installation is resolved afterwards");
  assert.equal((await gh.readApp()).app_id, 5150);
  assert.equal((await gh.connection()).kind, "app");
  assert.equal((await gh.connection()).ready, false);
});

test("adoptApp: a wrong App ID fails without clobbering a working connection", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const store = new MemoryStore();
  await store.kvSet(GH_KEYS.app, JSON.stringify({ app_id: 1, pem: "existing", installation_id: 11 }));

  const gh = new GitHubAppClient(store, { fetchImpl: () => jsonResponse({ message: "Bad credentials" }, 401) });
  await assert.rejects(() => gh.adoptApp({ app_id: 2, pem }), /GitHub rejected that App ID \+ private key/);
  assert.equal(JSON.parse(await store.kvGet(GH_KEYS.app)).app_id, 1, "the first app is untouched");

  const missing = new GitHubAppClient(store, { fetchImpl: () => jsonResponse({ message: "Not Found" }, 404) });
  await assert.rejects(() => missing.adoptApp({ app_id: 3, pem }), /may have been deleted/);
});

test("markConnectionSaved: remembers the key was downloaded", async () => {
  const store = new MemoryStore();
  const gh = new GitHubAppClient(store);
  assert.equal(await gh.markConnectionSaved(), null);
  await gh.writeApp({ app_id: 9, pem: "pem", installation_id: 3 });
  const next = await gh.markConnectionSaved(1700000000000);
  assert.equal(next.connection_saved_at, 1700000000000);
  assert.equal((await gh.readApp()).connection_saved_at, 1700000000000);
});
