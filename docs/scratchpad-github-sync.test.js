// Behaviour tests for the Scratchpad → GitHub "zero-config" saving flow.
//
//   npm install jsdom
//   node docs/scratchpad-github-sync.test.js
//
// Loads index.html in jsdom against a stubbed GitHub and exercises the whole chain that makes the feature
// friction-free: the app manifest (nothing to copy/paste), the CORS callback that hands back the app's
// private key, signing RS256 app JWTs, minting installation tokens, resolving the installation, saves
// (create → update → conflict → overwrite), pulls, autosave, local-only notes, and the pasted-token fallback.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const { webcrypto } = nodeCrypto;
const rawHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";

// jsdom can't intercept navigation, so swap the single redirect call site for a capture hook after asserting
// the page still only has the one (the GitHub App install redirect).
const ASSIGN_SITE = "window.location.assign(`";
const assignCount = rawHtml.split(ASSIGN_SITE).length - 1;
if (assignCount !== 1) throw new Error("expected exactly one window.location.assign redirect, found " + assignCount);
const html = rawHtml.replace(ASSIGN_SITE, "window.__captureAssign(`");

const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const flush = () => new Promise(r => setTimeout(r, 80));
const jsonRes = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures += 1; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}

// A throwaway RSA key stands in for the one GitHub generates for a manifest app.
const appKey = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPem = appKey.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const appPublicKey = appKey.publicKey;

function makeWindow({ url = SITE, pending = null, storage = null, session = null, fetchImpl = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e && e.message ? e.message : e)));
  const vcs = { assigned: [], submits: [], fetchCalls: [], confirmAnswer: true, replacedUrl: null };

  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.confirm = () => vcs.confirmAnswer;
      window.__captureAssign = target => vcs.assigned.push(target);
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
        window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
      }
      // The manifest step is a real form POST to github.com; capture it instead of navigating.
      window.HTMLFormElement.prototype.submit = function submit() {
        // jsdom's FormData can't be built from a detached form, so read the named inputs directly.
        vcs.submits.push({ action: this.action, entries: [...this.querySelectorAll("input[name]")].map(input => [input.name, input.value]) });
      };
      // Minimal canvas stub: the seasonal layer shouldn't pollute the error log.
      window.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, save() {}, restore() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, stroke() {}, closePath() {}, createRadialGradient: () => ({ addColorStop() {} }),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {}, set shadowColor(v) {}
      });
      window.history.replaceState = (state, title, target) => { vcs.replacedUrl = target; };
      if (pending) window.sessionStorage.setItem("dash-scratchpad-gh-app-pending-v2", JSON.stringify(pending));
      if (session) Object.entries(session).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      if (storage) Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
      window.fetch = async (target, options = {}) => {
        vcs.fetchCalls.push({ target: String(target), options });
        if (fetchImpl) return fetchImpl(String(target), options, vcs);
        throw new Error("fetch not stubbed for " + target);
      };
    }
  });
  dom.window.__vc = vcs;
  dom.window.__errors = errors;
  return dom.window;
}

// Verifies an RS256 JWT the way api.github.com does, using the app's public half.
function verifyAppJwt(jwt) {
  const [h, p, s] = String(jwt || "").split(".");
  if (!h || !p || !s) return { ok: false, reason: "malformed" };
  const header = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  const signature = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = header.alg === "RS256" && nodeCrypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: appPublicKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, signature);
  const now = Math.floor(Date.now() / 1000);
  return { ok, header, payload, issuedAtSane: payload.iat <= now && payload.exp > now && payload.exp - payload.iat <= 600 };
}

const APP_RECORD = { app_id: 987654, slug: "dash-notes-example", name: "dash notes", owner: "octocat", pem: appPem, installation_id: 424242, installation_account: "octocat", created_at: Date.now() };
const INSTALL = { id: 424242, account: { login: "octocat" }, target_type: "User" };
const REPOS = { total_count: 2, repositories: [{ full_name: "octocat/notes" }, { full_name: "octocat/private-notes" }] };

// A tiny stateful GitHub: manifest conversion, installations, installation tokens, contents.
function makeGithub({ existing = null } = {}) {
  const state = { conversions: 0, tokenMints: 0, puts: [], file: existing, lastJwt: null, lastInstallJwt: null, issuedTokens: [] };
  async function handle(target, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if (target.startsWith("https://api.github.com/app-manifests/")) {
      state.conversions += 1;
      return jsonRes({ id: 987654, slug: "dash-notes-example", name: "dash notes", owner: { login: "octocat" }, pem: appPem, html_url: "https://github.com/apps/dash-notes-example", client_id: "Iv1.abc", client_secret: "shhh", webhook_secret: null });
    }
    if (target.includes("/app/installations") && method === "GET") {
      state.lastJwt = options.headers?.Authorization?.replace("Bearer ", "");
      return jsonRes([INSTALL]);
    }
    if (target.includes("/access_tokens") && method === "POST") {
      state.tokenMints += 1;
      state.lastInstallJwt = options.headers?.Authorization?.replace("Bearer ", "");
      const token = "ghs_minted_" + state.tokenMints;
      state.issuedTokens.push(token);
      return jsonRes({ token, expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
    }
    if (target.includes("/installation/repositories")) {
      state.listAuth = options.headers?.Authorization?.replace("Bearer ", "");
      return jsonRes(REPOS);
    }
    if (target.includes("/repos/")) {
      if (method === "PUT") {
        const body = JSON.parse(options.body);
        state.puts.push({ target, body, auth: options.headers?.Authorization });
        state.file = { type: "file", sha: "sha-" + state.puts.length, content: body.content };
        return jsonRes({ content: { sha: state.file.sha } });
      }
      return state.file ? jsonRes(state.file) : { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
    if (target.endsWith("/user")) return jsonRes({ login: "octocat" });
    throw new Error("unexpected GitHub call " + method + " " + target);
  }
  return { state, handle };
}

(async () => {
  console.log("\n[1] the panel needs no configuration: one button, no fields to fill in");
  let win = makeWindow();
  await flush();
  const doc = win.document;
  check("page loads without script errors", win.__errors.length === 0, win.__errors.join(" | "));
  check("Set up button is offered", doc.getElementById("scratchpad-gh-setup").hidden === false);
  check("install/re-check/disconnect stay hidden until there's an app",
    doc.getElementById("scratchpad-gh-install").hidden && doc.getElementById("scratchpad-gh-check").hidden && doc.getElementById("scratchpad-gh-forget").hidden);
  check("repo/path/save controls hidden until connected", doc.getElementById("scratchpad-gh-target").hidden === true);
  check("no Client ID field anywhere", !doc.getElementById("scratchpad-gh-client-id") && !doc.querySelector('#modal-scratchpad input[placeholder^="Iv1"]'));
  check("no Personal access token prompt on the main path", doc.getElementById("scratchpad-gh-fallback").closest("details").open === false);
  check("hint promises no copying/pasting", /copy or paste/i.test(doc.getElementById("scratchpad-gh-hint").textContent),
    doc.getElementById("scratchpad-gh-hint").textContent);

  console.log("\n[2] Set up GitHub saving registers an app from a manifest (no manual app creation)");
  doc.getElementById("scratchpad-gh-setup").click();
  await flush();
  check("posts a manifest to GitHub's app-new endpoint", win.__vc.submits.length === 1, JSON.stringify(win.__vc.submits));
  const submission = win.__vc.submits[0] || { action: "", entries: [] };
  const actionUrl = new URL(submission.action);
  check("action is github.com/settings/apps/new", actionUrl.origin === "https://github.com" && actionUrl.pathname === "/settings/apps/new");
  check("a CSRF state accompanies the manifest", (actionUrl.searchParams.get("state") || "").length >= 16);
  const manifestField = submission.entries.find(([k]) => k === "manifest");
  const manifest = JSON.parse(manifestField ? manifestField[1] : "{}");
  check("manifest redirects back to this page", manifest.redirect_url === SITE && (manifest.callback_urls || []).includes(SITE), JSON.stringify(manifest.redirect_url));
  check("app requests only Contents write", JSON.stringify(manifest.default_permissions) === JSON.stringify({ contents: "write", metadata: "read" }), JSON.stringify(manifest.default_permissions));
  check("app is private with no webhook events", manifest.public === false && Array.isArray(manifest.default_events) && manifest.default_events.length === 0);
  check("manifest returns the page after the install screen", manifest.setup_url === SITE, JSON.stringify(manifest.setup_url));
  const pendingState = JSON.parse(win.sessionStorage.getItem("dash-scratchpad-gh-app-pending-v2") || "{}");
  check("pending state stored for the callback", pendingState.state === actionUrl.searchParams.get("state"));

  console.log("\n[3] returning from GitHub exchanges the code for the app's key, then starts the install");
  const callbackState = "state-from-github-1234";
  let github = makeGithub();
  win = makeWindow({
    url: SITE + "?code=manifest-code&state=" + callbackState,
    pending: { state: callbackState, redirectUrl: SITE, startedAt: Date.now() },
    fetchImpl: github.handle
  });
  await flush(); await flush(); await flush();
  const d2 = win.document;
  check("conversion endpoint called once", github.state.conversions === 1);
  check("conversion was a CORS-safe POST", win.__vc.fetchCalls.some(c => c.target === "https://api.github.com/app-manifests/manifest-code/conversions" && (c.options.method || "GET") === "POST"));
  const savedApp = JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-app-v2") || "null");
  check("app id + private key stored (client secret ignored)", savedApp && savedApp.app_id === 987654 && /BEGIN RSA PRIVATE KEY/.test(savedApp.pem) && !("client_secret" in savedApp), JSON.stringify(savedApp && Object.keys(savedApp)));
  check("app is not considered installed yet", savedApp && savedApp.installation_id === null);
  check("redirects to the app's install screen automatically", win.__vc.assigned.length === 1 && win.__vc.assigned[0] === "https://github.com/apps/dash-notes-example/installations/new", JSON.stringify(win.__vc.assigned));
  check("scratchpad modal opened to show progress", d2.getElementById("modal-scratchpad").open === true);
  check("URL cleaned of code/state", /^https:\/\/aacareq\.github\.io\/dash\/index\.html$/.test(win.__vc.replacedUrl || ""), win.__vc.replacedUrl);

  console.log("\n[4] back from the install screen, the installation is discovered and remembered");
  github = makeGithub();
  win = makeWindow({
    storage: { "dash-scratchpad-gh-app-v2": { ...APP_RECORD, installation_id: null } },
    pending: { state: "install", startedAt: Date.now() },
    fetchImpl: github.handle
  });
  await flush(); await flush(); await flush();
  const d3 = win.document;
  const installed = JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-app-v2"));
  check("installation id persisted", installed.installation_id === 424242, JSON.stringify(installed.installation_id));
  check("installation account recorded", installed.installation_account === "octocat");
  check("badge says connected", /Connected/.test(d3.getElementById("scratchpad-gh-account").textContent), d3.getElementById("scratchpad-gh-account").textContent);
  check("repo picker is populated", [...d3.querySelectorAll("#scratchpad-gh-repo option")].map(o => o.value).join(",") === "octocat/notes,octocat/private-notes");
  check("save controls revealed", d3.getElementById("scratchpad-gh-target").hidden === false);
  check("Set up button retired", d3.getElementById("scratchpad-gh-setup").hidden === true);
  check("a real app JWT was signed for the installations call", verifyAppJwt(github.state.lastJwt).ok && verifyAppJwt(github.state.lastJwt).issuedAtSane,
    JSON.stringify(verifyAppJwt(github.state.lastJwt)));
  check("JWT identifies the app (iss = app id)", String(verifyAppJwt(github.state.lastJwt).payload.iss) === "987654");
  check("saving is done with a minted installation token", /^ghs_/.test(github.state.listAuth || ""), github.state.listAuth);

  console.log("\n[5] saving notes: create, then update in place, all with self-minted tokens");
  github = makeGithub();
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush();
  const d4 = win.document;
  d4.getElementById("scratchpad-text").value = "line one\nline two ✓";
  d4.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d4.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d4.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("one commit made", github.state.puts.length === 1, JSON.stringify(github.state.puts));
  check("commit targets the chosen file", github.state.puts[0]?.target === "https://api.github.com/repos/octocat/notes/contents/notes/scratchpad.md");
  check("create carries no sha", github.state.puts[0] && !("sha" in github.state.puts[0].body));
  check("content is the notes, base64'd", github.state.puts[0] && Buffer.from(github.state.puts[0].body.content, "base64").toString("utf8") === "line one\nline two ✓");
  check("commit message mentions scratchpad", /Scratchpad notes/.test(github.state.puts[0]?.body.message || ""));
  check("commit used an installation token, never a long-lived one", /^Bearer ghs_/.test(github.state.puts[0]?.auth || ""), github.state.puts[0]?.auth);
  d4.getElementById("scratchpad-text").value = "line one\nline two ✓\nthree";
  d4.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("second save updates the same file (sha sent)", github.state.puts.length === 2 && github.state.puts[1].body.sha === "sha-1", JSON.stringify(github.state.puts[1]?.body));
  check("status reports an update", /Updated/.test(d4.getElementById("scratchpad-gh-file-status").textContent), d4.getElementById("scratchpad-gh-file-status").textContent);
  check("installation token minted once and reused", github.state.tokenMints === 1, String(github.state.tokenMints));

  console.log("\n[6] a file that changed on GitHub pauses the save, then Overwrite anyway wins");
  github = makeGithub({ existing: { type: "file", sha: "someone-else", content: Buffer.from("their notes").toString("base64") } });
  win = makeWindow({
    storage: {
      "dash-scratchpad-gh-app-v2": APP_RECORD,
      "dash-scratchpad-gh-file-shas-v1": { "octocat/notes@default:notes/scratchpad.md": "old-sha" }
    },
    fetchImpl: github.handle
  });
  await flush(); await flush();
  const d5 = win.document;
  d5.getElementById("scratchpad-text").value = "my notes";
  d5.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d5.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d5.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("nothing was written while the conflict stands", github.state.puts.length === 0);
  check("conflict explained", /changed on GitHub/.test(d5.getElementById("scratchpad-gh-file-status").textContent), d5.getElementById("scratchpad-gh-file-status").textContent);
  check("Overwrite anyway appears", d5.getElementById("scratchpad-gh-overwrite").hidden === false);
  d5.getElementById("scratchpad-gh-overwrite").click();
  await flush(); await flush();
  check("overwrite commits with the fresh sha", github.state.puts.length === 1 && github.state.puts[0].body.sha === "someone-else", JSON.stringify(github.state.puts[0]?.body));
  check("Overwrite anyway hides again", d5.getElementById("scratchpad-gh-overwrite").hidden === true);

  console.log("\n[7] pull latest, and autosave after typing stops");
  github = makeGithub({ existing: { type: "file", sha: "remote-sha", content: Buffer.from("# Remote notes").toString("base64") } });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush();
  const d6 = win.document;
  d6.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d6.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d6.getElementById("scratchpad-gh-pull").click();
  await flush(); await flush();
  check("editor filled from GitHub", d6.getElementById("scratchpad-text").value === "# Remote notes");
  check("local copy mirrors the pull", win.localStorage.getItem("dash-scratchpad") === "# Remote notes");
  check("sha remembered for the next save", JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-file-shas-v1") || "{}")["octocat/notes@default:notes/scratchpad.md"] === "remote-sha");

  github = makeGithub();
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush();
  const d7 = win.document;
  d7.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d7.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  const autosave = d7.getElementById("scratchpad-gh-autosave");
  autosave.checked = true;
  autosave.dispatchEvent(new win.Event("change", { bubbles: true }));
  const ta = d7.getElementById("scratchpad-text");
  ta.value = "autosaved note";
  ta.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  check("nothing committed before the debounce elapses", github.state.puts.length === 0);
  await new Promise(r => setTimeout(r, 3200));
  check("autosave committed once", github.state.puts.length === 1, String(github.state.puts.length));
  check("autosave status says so", /autosave/i.test(d7.getElementById("scratchpad-gh-file-status").textContent), d7.getElementById("scratchpad-gh-file-status").textContent);
  check("local notes still saved", win.localStorage.getItem("dash-scratchpad") === "autosaved note");

  console.log("\n[8] a returning visitor never signs in again: no redirect, no interaction");
  github = makeGithub();
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush();
  check("no navigation was attempted on load", win.__vc.assigned.length === 0, JSON.stringify(win.__vc.assigned));
  check("no setup/install prompt is shown", win.document.getElementById("scratchpad-gh-setup").hidden && win.document.getElementById("scratchpad-gh-install").hidden);
  check("repo picker ready without clicking anything", win.document.querySelectorAll("#scratchpad-gh-repo option").length === 2);
  check("connection verified in the background", github.state.lastJwt !== null && verifyAppJwt(github.state.lastJwt).ok);
  const staleApp = { ...APP_RECORD, installation_token: "ghs_stale", installation_token_expires_at: Date.now() - 1000, installation_token_id: 424242 };
  github = makeGithub();
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": staleApp }, fetchImpl: github.handle });
  await flush(); await flush();
  check("an expired cached installation token is re-minted on demand", github.state.tokenMints === 1 && /^ghs_minted/.test(github.state.listAuth || ""), github.state.listAuth);

  console.log("\n[8b] GitHub's install redirect is honoured even without a pending setup");
  github = makeGithub();
  win = makeWindow({
    url: SITE + "?installation_id=424242&setup_action=install",
    storage: { "dash-scratchpad-gh-app-v2": { ...APP_RECORD, installation_id: null } },
    fetchImpl: github.handle
  });
  await flush(); await flush(); await flush();
  const d8b = win.document;
  check("installation recorded from the redirect", JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-app-v2")).installation_id === 424242);
  check("install params stripped from the URL", /^https:\/\/aacareq\.github\.io\/dash\/index\.html$/.test(win.__vc.replacedUrl || ""), win.__vc.replacedUrl);
  check("connected without clicking anything", /Connected/.test(d8b.getElementById("scratchpad-gh-account").textContent), d8b.getElementById("scratchpad-gh-account").textContent);

  console.log("\n[9] a tampered or mismatched manifest state is ignored");
  github = makeGithub();
  win = makeWindow({
    url: SITE + "?code=manifest-code&state=not-mine",
    pending: { state: "expected-state", redirectUrl: SITE, startedAt: Date.now() },
    fetchImpl: github.handle
  });
  await flush(); await flush();
  check("no conversion attempted", github.state.conversions === 0);
  check("no app stored", win.localStorage.getItem("dash-scratchpad-gh-app-v2") === null);

  console.log("\n[10] works offline (no GitHub at all), and the pasted-token fallback still works");
  win = makeWindow();
  await flush();
  const d8 = win.document;
  const ta2 = d8.getElementById("scratchpad-text");
  ta2.value = "plain local note";
  ta2.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  check("local autosave wrote localStorage", win.localStorage.getItem("dash-scratchpad") === "plain local note");
  check("local status confirms the save", /Saved locally/.test(d8.getElementById("scratchpad-status").textContent));

  win = makeWindow({ fetchImpl: async target => (target.endsWith("/user") ? jsonRes({ login: "tokenuser" }) : jsonRes(REPOS)) });
  await flush();
  const d9 = win.document;
  d9.getElementById("scratchpad-gh-token").value = "github_pat_example";
  d9.getElementById("scratchpad-gh-token-save").click();
  await flush(); await flush(); await flush();
  check("token validated against /user", /@tokenuser/.test(d9.getElementById("scratchpad-gh-status").textContent), d9.getElementById("scratchpad-gh-status").textContent);
  check("token mode reveals the save controls", d9.getElementById("scratchpad-gh-target").hidden === false);
  check("token mode offers Remove", d9.getElementById("scratchpad-gh-token-clear").hidden === false);
  check("token recorded in storage", JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-token-v1") || "{}").access_token === "github_pat_example");

  console.log("\n[11] Disconnect forgets the app credentials");
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: makeGithub().handle });
  await flush(); await flush();
  win.document.getElementById("scratchpad-gh-forget").click();
  await flush();
  check("app record removed", win.localStorage.getItem("dash-scratchpad-gh-app-v2") === null);
  check("Set up button returns", win.document.getElementById("scratchpad-gh-setup").hidden === false);
  check("save controls hidden again", win.document.getElementById("scratchpad-gh-target").hidden === true);

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
