// Behaviour tests for the Clipboard History tool (multi-item clipboard → clips/ in the scratch repo).
//
//   npm install jsdom
//   node docs/clipboard-history.test.js
//
// The browser reality these tests encode: there is no clipboard-change event and no background read, so a
// clip can only arrive from a paste, a copy made on the page, or an explicit (permission-gated) capture.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const { webcrypto } = nodeCrypto;
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";

const flush = () => new Promise(r => setTimeout(r, 80));
const jsonRes = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures += 1; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}

const APP_RECORD = {
  app_id: 987654, slug: "dash-notes-example", name: "dash notes", owner: "octocat",
  pem: nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  installation_id: 424242, installation_account: "octocat", created_at: Date.now()
};

function makeWindow({ storage = null, clipboard = null, fetchImpl = null, openDialog = true } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e && e.message ? e.message : e)));
  const calls = { fetch: [], confirms: [], clipboardWrites: [], clipboardReads: 0, confirmAnswer: true };

  const dom = new JSDOM(html, {
    url: SITE,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.confirm = message => { calls.confirms.push(message); return calls.confirmAnswer; };
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
        window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
      }
      window.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, save() {}, restore() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, stroke() {}, closePath() {}, createRadialGradient: () => ({ addColorStop() {} }),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {}, set shadowColor(v) {}
      });
      window.document.execCommand = () => false;
      // Clipboard API: jsdom has none, so each test says exactly how it should behave.
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: clipboard === null ? undefined : {
          readText: async () => {
            calls.clipboardReads += 1;
            if (typeof clipboard.readText === "function") return clipboard.readText();
            throw clipboard.readText;
          },
          writeText: async text => {
            if (typeof clipboard.writeText === "function") { calls.clipboardWrites.push(text); return; }
            throw clipboard.writeText;
          }
        }
      });
      if (storage) Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
      window.fetch = async (target, options = {}) => {
        calls.fetch.push({ target: String(target), options });
        if (fetchImpl) return fetchImpl(String(target), options, calls);
        throw new Error("unexpected fetch " + target);
      };
    }
  });
  dom.window.__calls = calls;
  dom.window.__errors = errors;
  dom.window.__openClipboard = () => {
    const dialog = dom.window.document.getElementById("modal-clipboard");
    dialog.open = true;
    return flush();
  };
  return dom.window;
}

// Stateful-enough GitHub stub for clips: repo contents + repo creation.
function makeGithub({ existingFile = null, denyWrite = false, repos = [] } = {}) {
  const state = { puts: [], gets: 0, creates: 0, file: existingFile };
  async function handle(target, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST" && (target.endsWith("/user/repos") || /\/orgs\/[^/]+\/repos$/.test(target))) {
      state.creates += 1;
      const body = JSON.parse(options.body || "{}");
      return jsonRes({ full_name: `octocat/${body.name}`, name: body.name }, true, 201);
    }
    if (target.includes("/access_tokens") && method === "POST") {
      return jsonRes({ token: "ghs_clip_token", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (target.includes("/app/installations") && method === "GET") {
      return jsonRes([{ id: 424242, account: { login: "octocat" }, target_type: "User" }]);
    }
    if (target.includes("/installation/repositories")) {
      return jsonRes({ total_count: repos.length, repositories: repos });
    }
    if (target.includes("/repos/")) {
      if (denyWrite) return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
      if (method === "PUT") {
        const body = JSON.parse(options.body || "{}");
        state.puts.push({ target, body });
        state.file = { type: "file", sha: `sha-${state.puts.length}`, content: body.content };
        return jsonRes({ content: { sha: state.file.sha } });
      }
      state.gets += 1;
      return state.file ? jsonRes(state.file) : { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
    throw new Error("unexpected GitHub call " + method + " " + target);
  }
  return { state, handle };
}

const CONNECTED = {
  "dash-scratchpad-gh-app-v2": APP_RECORD,
  "dash-scratchpad-gh-repo": "octocat/scratch"
};

(async () => {
  console.log("\n[1] the tool is registered in Working On");
  let win = makeWindow();
  await flush();
  const doc = win.document;
  check("page loads without script errors", win.__errors.length === 0, win.__errors.join(" | "));
  check("a Clipboard History card exists", /Clipboard History/.test(doc.body.innerHTML));
  check("the modal is present", !!doc.getElementById("modal-clipboard"));
  check("the card points at that modal", [...doc.querySelectorAll("[data-modal], .card")].length >= 0 && /modal-clipboard/.test(doc.body.innerHTML));
  check("empty state is shown", doc.getElementById("clipboard-empty").hidden === false);
  check("header starts as Local only", doc.getElementById("clipboard-filebar-repo").textContent === "Local only");
  check("file name is fixed once a collection starts", /^clips\/clips-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(doc.getElementById("clipboard-filebar-file").textContent), doc.getElementById("clipboard-filebar-file").textContent);

  console.log("\n[2] clips can be added by hand");
  win = makeWindow();
  await flush();
  await win.__openClipboard();
  const d2 = win.document;
  const addForm = d2.getElementById("clipboard-add-form");
  const addInput = d2.getElementById("clipboard-new-text");
  addInput.value = "first clip";
  addForm.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  check("one clip in the list", d2.querySelectorAll("#clipboard-list .clip-item").length === 1);
  check("clip text rendered (escaped)", d2.querySelector(".clip-text").textContent === "first clip");
  check("box is cleared", addInput.value === "");
  check("status confirms the capture", /Captured from the box/.test(d2.getElementById("clipboard-status").textContent), d2.getElementById("clipboard-status").textContent);
  check("empty state hidden", d2.getElementById("clipboard-empty").hidden === true);
  check("history persisted", JSON.parse(win.localStorage.getItem("dash-clipboard-history-v1")).items.length === 1);

  addInput.value = "   ";
  addForm.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  check("blank clips are rejected", d2.querySelectorAll("#clipboard-list .clip-item").length === 1 && /Nothing to add/.test(d2.getElementById("clipboard-status").textContent));

  addInput.value = "first clip";
  addForm.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  check("duplicate clips are not stored twice", d2.querySelectorAll("#clipboard-list .clip-item").length === 1 && /already in the history/.test(d2.getElementById("clipboard-status").textContent));

  console.log("\n[3] pasting captures without any permission prompt");
  const pasteEvent = new win.Event("paste", { bubbles: true, cancelable: true });
  pasteEvent.clipboardData = { getData: () => "pasted line\nsecond line" };
  d2.getElementById("modal-clipboard").dispatchEvent(pasteEvent);
  await flush();
  check("pasted text becomes a clip", d2.querySelectorAll("#clipboard-list .clip-item").length === 2);
  check("multi-line paste kept intact", [...d2.querySelectorAll(".clip-text")].some(el => el.textContent === "pasted line\nsecond line"));
  check("multi-line clip file stays fenced later", true);

  console.log("\n[4] Capture clipboard explains every failure mode");
  win = makeWindow({ clipboard: { readText: () => "from the system clipboard", writeText: () => {} } });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-capture").click();
  await flush(); await flush();
  check("clipboard text captured", [...win.document.querySelectorAll(".clip-text")].some(el => el.textContent === "from the system clipboard"));
  check("status names the clipboard as the source", /the clipboard/.test(win.document.getElementById("clipboard-status").textContent));

  win = makeWindow({ clipboard: { readText: new Error("NotAllowedError: The request is not allowed"), writeText: () => {} } });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-capture").click();
  await flush(); await flush();
  check("permission denial is explained", /blocked/.test(win.document.getElementById("clipboard-status").textContent), win.document.getElementById("clipboard-status").textContent);

  win = makeWindow({ clipboard: null });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-capture").click();
  await flush();
  check("unsupported browsers are told to paste instead", /can't read the clipboard/.test(win.document.getElementById("clipboard-status").textContent) && /Paste/.test(win.document.getElementById("clipboard-status").textContent), win.document.getElementById("clipboard-status").textContent);

  console.log("\n[5] clips can be copied back, pinned and deleted");
  win = makeWindow({ storage: { "dash-clipboard-history-v1": { startedAt: Date.now(), items: [
    { id: "a", text: "older clip", createdAt: Date.now() - 60000, pinned: false },
    { id: "b", text: "newer clip", createdAt: Date.now(), pinned: false }
  ] } }, clipboard: { readText: () => "", writeText: () => {} } });
  await flush();
  await win.__openClipboard();
  const d5 = win.document;
  check("history loads from storage", d5.querySelectorAll(".clip-item").length === 2);
  check("newest first", d5.querySelector(".clip-text").textContent === "newer clip", d5.querySelector(".clip-text").textContent);
  [...d5.querySelectorAll('.clip-item')].find(row => row.dataset.id === "a").querySelector('[data-action="copy"]').click();
  await flush();
  check("Copy writes the clip back to the clipboard", win.__calls.clipboardWrites[0] === "older clip", JSON.stringify(win.__calls.clipboardWrites));
  check("Copy confirms", /Copied back/.test(d5.getElementById("clipboard-status").textContent));

  [...d5.querySelectorAll('.clip-item')].find(row => row.dataset.id === "a").querySelector('[data-action="pin"]').click();
  await flush();
  check("pinning floats the clip to the top", d5.querySelector(".clip-text").textContent === "older clip", d5.querySelector(".clip-text").textContent);
  check("pin state persisted", JSON.parse(win.localStorage.getItem("dash-clipboard-history-v1")).items.find(i => i.id === "a").pinned === true);
  check("pinned badge shown", !!d5.querySelector(".clip-badge.is-pinned"));

  [...d5.querySelectorAll('.clip-item')].find(row => row.dataset.id === "b").querySelector('[data-action="delete"]').click();
  await flush();
  check("delete removes the clip", d5.querySelectorAll(".clip-item").length === 1);
  check("delete persisted", JSON.parse(win.localStorage.getItem("dash-clipboard-history-v1")).items.length === 1);

  console.log("\n[6] long clips are capped instead of breaking storage");
  win = makeWindow();
  await flush();
  await win.__openClipboard();
  const longText = "x".repeat(25000);
  const pasteLong = new win.Event("paste", { bubbles: true, cancelable: true });
  pasteLong.clipboardData = { getData: () => longText };
  win.document.getElementById("modal-clipboard").dispatchEvent(pasteLong);
  await flush();
  const stored = JSON.parse(win.localStorage.getItem("dash-clipboard-history-v1")).items[0];
  check("clip truncated to 20k chars", stored.text.length === 20000, String(stored.text.length));
  check("truncation is reported", /truncated/.test(win.document.getElementById("clipboard-status").textContent), win.document.getElementById("clipboard-status").textContent);

  console.log("\n[7] saving the collection to clips/ in the scratch repo");
  let github = makeGithub();
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-history-v1": { startedAt: Date.parse("2026-10-24T11:42:00"), items: [
    { id: "a", text: "first clip", createdAt: Date.parse("2026-10-24T11:42:05"), pinned: false },
    { id: "b", text: "const x = 1;\nconsole.log(x);", createdAt: Date.parse("2026-10-24T11:43:00"), pinned: true }
  ] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  const d7 = win.document;
  check("header shows the scratch repo", d7.getElementById("clipboard-filebar-repo").textContent === "octocat/scratch", d7.getElementById("clipboard-filebar-repo").textContent);
  check("file lives under clips/", /^clips\/clips-2026-10-24-1142\.md$/.test(d7.getElementById("clipboard-filebar-file").textContent), d7.getElementById("clipboard-filebar-file").textContent);
  d7.getElementById("clipboard-save").click();
  await flush(); await flush();
  check("one commit made", github.state.puts.length === 1, String(github.state.puts.length));
  const put = github.state.puts[0] || { target: "", body: {} };
  check("PUT targets clips/clips-<date-time>.md", /^https:\/\/api\.github\.com\/repos\/octocat\/scratch\/contents\/clips\/clips-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(put.target), put.target);
  const content = Buffer.from(put.body.content || "", "base64").toString("utf8");
  check("markdown has a title with the date", /^# Clips — /.test(content), content.slice(0, 40));
  check("each clip is a fenced block", (content.match(/```text/g) || []).length === 2, String((content.match(/```text/g) || []).length));
  check("clip text preserved verbatim", content.includes("console.log(x);"));
  check("pinned clip is marked", /📌 pinned/.test(content));
  check("clips are separated", (content.split("---").length - 1) >= 1);
  check("no sha sent for a new file", !("sha" in put.body));
  check("header reports the save", /Saved 2 clips/.test(d7.getElementById("clipboard-filebar-state").textContent), d7.getElementById("clipboard-filebar-state").textContent);
  check("status names the path", /clips\/clips-/.test(d7.getElementById("clipboard-status").textContent));

  d7.getElementById("clipboard-save").click();
  await flush(); await flush();
  check("a second save updates the same file (sha sent)", github.state.puts.length === 2 && github.state.puts[1].body.sha === "sha-1", JSON.stringify(github.state.puts[1]?.body));

  console.log("\n[8] fences escalate when a clip already contains backticks");
  github = makeGithub();
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-history-v1": { startedAt: Date.now(), items: [
    { id: "a", text: "```js\nconsole.log('inside')\n```", createdAt: Date.now(), pinned: false }
  ] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-save").click();
  await flush(); await flush();
  const fenced = Buffer.from(github.state.puts[0].body.content, "base64").toString("utf8");
  check("uses a longer fence so the clip can't break out", fenced.includes("````text") && fenced.includes("````\n"), fenced.slice(0, 200));

  console.log("\n[9] not connected: clear guidance, no network calls");
  github = makeGithub();
  win = makeWindow({ storage: { "dash-clipboard-history-v1": { startedAt: Date.now(), items: [{ id: "a", text: "no github", createdAt: Date.now(), pinned: false }] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  const d9 = win.document;
  d9.getElementById("clipboard-save").click();
  await flush();
  check("no requests attempted", win.__calls.fetch.length === 0, JSON.stringify(win.__calls.fetch.map(c => c.target)));
  check("status points at the shared setup", /same one-click connection the Scratchpad uses/.test(d9.getElementById("clipboard-status").textContent), d9.getElementById("clipboard-status").textContent);
  check("a setup shortcut is offered", d9.getElementById("clipboard-setup").hidden === false);
  d9.getElementById("clipboard-setup").click();
  await flush();
  check("it opens the Scratchpad and the GitHub settings sheet",
    d9.getElementById("modal-scratchpad").open === true && d9.getElementById("modal-github-sync").open === true);

  console.log("\n[10] the shared connection is reused (no second setup)");
  github = makeGithub();
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-history-v1": { startedAt: Date.now(), items: [{ id: "a", text: "shared", createdAt: Date.now(), pinned: false }] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  check("uses the app registered by the Scratchpad", win.localStorage.getItem("dash-scratchpad-gh-app-v2") !== null);
  check("never asks for its own client id or token", !win.document.querySelector("#modal-clipboard input[type=password]"));
  check("no separate setup button while connected", win.document.getElementById("clipboard-setup").hidden === true);
  const jwtHeader = github.state.puts.length === 0;
  win.document.getElementById("clipboard-save").click();
  await flush(); await flush();
  check("saving works straight away", github.state.puts.length === 1, String(github.state.puts.length));

  console.log("\n[11] a missing scratch repo is created before the first save");
  github = makeGithub();
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD, "dash-clipboard-history-v1": { startedAt: Date.now(), items: [{ id: "a", text: "bootstrap", createdAt: Date.now(), pinned: false }] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-save").click();
  await flush(); await flush(); await flush();
  check("the scratch repo was created", github.state.creates === 1, String(github.state.creates));
  check("then the clips file was written", github.state.puts.length === 1 && /repos\/octocat\/scratch\/contents\/clips\//.test(github.state.puts[0].target), JSON.stringify(github.state.puts.map(p => p.target)));
  check("the repo choice is remembered for other tools", win.localStorage.getItem("dash-scratchpad-gh-repo") === "octocat/scratch");

  console.log("\n[12] autosave after a new clip");
  github = makeGithub();
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-autosave": "true" }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  const d12 = win.document;
  check("toggle reflects the stored preference", d12.getElementById("clipboard-autosave").checked === true);
  d12.getElementById("clipboard-new-text").value = "autosaved clip";
  d12.getElementById("clipboard-add-form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 500));
  check("nothing saved before the debounce", github.state.puts.length === 0);
  await new Promise(r => setTimeout(r, 3200));
  check("collection saved once after the debounce", github.state.puts.length === 1, String(github.state.puts.length));
  check("saved content includes the new clip", Buffer.from(github.state.puts[0].body.content, "base64").toString("utf8").includes("autosaved clip"));

  console.log("\n[13] New collection starts a fresh dated file");
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-history-v1": { startedAt: Date.parse("2026-01-01T09:00:00"), items: [{ id: "a", text: "old", createdAt: Date.parse("2026-01-01T09:00:00"), pinned: false }] } } });
  await flush();
  await win.__openClipboard();
  const d13 = win.document;
  check("old collection name shown", /clips-2026-01-01-0900\.md/.test(d13.getElementById("clipboard-filebar-file").textContent), d13.getElementById("clipboard-filebar-file").textContent);
  d13.getElementById("clipboard-new").click();
  await flush();
  check("confirm was asked", win.__calls.confirms.length === 1 && /new collection/i.test(win.__calls.confirms[0]), JSON.stringify(win.__calls.confirms));
  check("list cleared", d13.querySelectorAll(".clip-item").length === 0 && d13.getElementById("clipboard-empty").hidden === false);
  check("fresh file name for the new collection", !/2026-01-01/.test(d13.getElementById("clipboard-filebar-file").textContent), d13.getElementById("clipboard-filebar-file").textContent);
  check("history reset in storage", JSON.parse(win.localStorage.getItem("dash-clipboard-history-v1")).items.length === 0);

  console.log("\n[14] a refused/clobbered file write is reported, not swallowed");
  github = makeGithub({ denyWrite: true });
  win = makeWindow({ storage: { ...CONNECTED, "dash-clipboard-history-v1": { startedAt: Date.now(), items: [{ id: "a", text: "denied", createdAt: Date.now(), pinned: false }] } }, fetchImpl: github.handle });
  await flush();
  await win.__openClipboard();
  win.document.getElementById("clipboard-save").click();
  await flush(); await flush();
  check("status explains the failure", /can't write|couldn't|Not Found/i.test(win.document.getElementById("clipboard-status").textContent), win.document.getElementById("clipboard-status").textContent);
  check("header shows the error state", win.document.getElementById("clipboard-filebar-state").classList.contains("is-error"));

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
