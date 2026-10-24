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
      // jsdom has no execCommand, so the toolbar's fallback path (setRangeText) is what gets exercised here.
      window.document.execCommand = () => false;
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
const USER_INSTALL = { id: 424242, account: { login: "octocat" }, target_type: "User" };
const ORG_INSTALL = { id: 424242, account: { login: "octocat" }, target_type: "Organization" };
const REPOS = { total_count: 2, repositories: [{ full_name: "octocat/notes" }, { full_name: "octocat/private-notes" }] };

// A tiny stateful GitHub: manifest conversion, installations, installation tokens, repo creation, contents.
function makeGithub({ existing = null, reposWithoutScratch = false, reposWithScratch = false, denyCreate = false, orgAccount = false } = {}) {
  const state = {
    conversions: 0, tokenMints: 0, puts: [], file: existing, lastJwt: null, lastInstallJwt: null, issuedTokens: [],
    createdRepos: [], createAttempts: 0
  };
  const repoList = () => {
    if (reposWithScratch) return [{ full_name: "octocat/notes", name: "notes" }, { full_name: "octocat/scratch", name: "scratch" }];
    if (reposWithoutScratch) {
      const created = state.createdRepos.length ? [{ full_name: "octocat/scratch", name: "scratch" }] : [];
      return [{ full_name: "octocat/notes", name: "notes" }, ...created];
    }
    // By default the notes repo already exists, so scratch creation only fires in the tests that ask for it.
    return [{ full_name: "octocat/notes", name: "notes" }, { full_name: "octocat/private-notes", name: "private-notes" }, { full_name: "octocat/scratch", name: "scratch" }];
  };
  async function handle(target, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if ((target === "https://api.github.com/user/repos" || /^https:\/\/api\.github\.com\/orgs\/[^/]+\/repos$/.test(target)) && method === "POST") {
      state.createAttempts += 1;
      if (denyCreate) {
        return { ok: false, status: 403, json: async () => ({ message: "Resource not accessible by integration" }) };
      }
      const body = JSON.parse(options.body || "{}");
      state.createdRepos.push({
        ...body,
        path: target.replace("https://api.github.com", ""),
        full_name: `${orgAccount ? "octocat" : "octocat"}/${body.name}`
      });
      return jsonRes({ full_name: `octocat/${body.name}`, name: body.name, private: true, default_branch: "main" }, true, 201);
    }
    if (target.startsWith("https://api.github.com/app-manifests/")) {
      state.conversions += 1;
      return jsonRes({ id: 987654, slug: "dash-notes-example", name: "dash notes", owner: { login: "octocat" }, pem: appPem, html_url: "https://github.com/apps/dash-notes-example", client_id: "Iv1.abc", client_secret: "shhh", webhook_secret: null });
    }
    if (target.includes("/app/installations") && method === "GET") {
      state.lastJwt = options.headers?.Authorization?.replace("Bearer ", "");
      return jsonRes([orgAccount ? ORG_INSTALL : USER_INSTALL]);
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
      return jsonRes({ total_count: repoList().length, repositories: repoList() });
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
  check("app requests only what it needs (contents + least-privilege repo creation)",
    JSON.stringify(manifest.default_permissions) === JSON.stringify({ contents: "write", metadata: "read", repository_creation: "write" }),
    JSON.stringify(manifest.default_permissions));
  check("app does not ask for full repository administration", !("administration" in (manifest.default_permissions || {})));
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
  check("repo picker is populated", [...d3.querySelectorAll("#scratchpad-gh-repo option")].map(o => o.value).join(",") === "octocat/notes,octocat/private-notes,octocat/scratch", [...d3.querySelectorAll("#scratchpad-gh-repo option")].map(o => o.value).join(","));
  check("the notes repo (scratch) is preselected", d3.getElementById("scratchpad-gh-repo").value === "octocat/scratch", d3.getElementById("scratchpad-gh-repo").value);
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
  check("repo picker ready without clicking anything", win.document.querySelectorAll("#scratchpad-gh-repo option").length === 3, String(win.document.querySelectorAll("#scratchpad-gh-repo option").length));
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

  win = makeWindow({ fetchImpl: async target => (target.endsWith("/user") ? jsonRes({ login: "tokenuser" }) : jsonRes({ total_count: 1, repositories: [{ full_name: "tokenuser/notes", name: "notes" }] })) });
  await flush();
  const d9 = win.document;
  d9.getElementById("scratchpad-gh-token").value = "github_pat_example";
  d9.getElementById("scratchpad-gh-token-save").click();
  await flush(); await flush(); await flush();
  check("token validated against /user", /tokenuser/.test(d9.getElementById("scratchpad-gh-account").textContent), d9.getElementById("scratchpad-gh-account").textContent);
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

  console.log("\n[12] the note file is named with the date and time");
  win = makeWindow();
  await flush();
  check("file path defaults to a dated markdown name", /^notes-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(win.document.getElementById("scratchpad-gh-path").value),
    win.document.getElementById("scratchpad-gh-path").value);
  const datedStem = win.document.getElementById("scratchpad-gh-path").value;
  win.document.getElementById("scratchpad-gh-path").value = "notes/custom.md";
  win.document.getElementById("scratchpad-gh-path").dispatchEvent(new win.Event("change", { bubbles: true }));
  win.document.getElementById("scratchpad-gh-new-file").click();
  await flush();
  const regenerated = win.document.getElementById("scratchpad-gh-path").value;
  check("New dated file regenerates the name", /^notes-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(regenerated) && regenerated !== "notes/custom.md", regenerated);
  check("the new name is remembered", win.localStorage.getItem("dash-scratchpad-gh-path") === regenerated);
  check("dated name was produced by the helper", typeof datedStem === "string" && datedStem.startsWith("notes-"));

  console.log("\n[13] markdown toolbar edits the note");
  win = makeWindow();
  await flush();
  const d13 = win.document;
  const ta13 = d13.getElementById("scratchpad-text");
  const click = name => d13.querySelector(`.md-toolbar [data-md="${name}"]`).click();
  const setSelection = (start, end = start) => { ta13.setSelectionRange(start, end); };
  d13.querySelector('[data-md="bold"]').dispatchEvent(new win.Event("mousedown", { bubbles: true, cancelable: true }));

  ta13.value = "hello world";
  setSelection(6, 11);
  click("bold");
  check("bold wraps the selection", ta13.value === "hello **world**", JSON.stringify(ta13.value));
  check("selection left on the bolded text", ta13.selectionStart === 8 && ta13.selectionEnd === 13, `${ta13.selectionStart}-${ta13.selectionEnd}`);
  click("bold");
  check("bold again unwraps", ta13.value === "hello world", JSON.stringify(ta13.value));

  ta13.value = "slanted";
  setSelection(0, 7);
  click("italic");
  check("italic wraps the selection", ta13.value === "*slanted*", JSON.stringify(ta13.value));
  ta13.value = "gone";
  setSelection(0, 4);
  click("strike");
  check("strikethrough wraps the selection", ta13.value === "~~gone~~", JSON.stringify(ta13.value));

  ta13.value = "insert here";
  setSelection(7);
  click("bold");
  check("empty selection inserts a placeholder and selects it", ta13.value === "insert **bold text**here" && ta13.selectionStart === 9 && ta13.selectionEnd === 18, JSON.stringify(ta13.value));

  ta13.value = "Title";
  setSelection(0, 5);
  click("h1");
  check("H1 prefixes the line", ta13.value === "# Title", JSON.stringify(ta13.value));
  click("h2");
  check("H2 replaces the level instead of stacking", ta13.value === "## Title", JSON.stringify(ta13.value));
  click("h3");
  check("H3 replaces the level", ta13.value === "### Title", JSON.stringify(ta13.value));
  click("h3");
  check("clicking the same heading toggles it off", ta13.value === "Title", JSON.stringify(ta13.value));

  ta13.value = "one\ntwo";
  setSelection(0, 7);
  click("ul");
  check("bulleted list prefixes every selected line", ta13.value === "- one\n- two", JSON.stringify(ta13.value));
  click("task");
  check("task list replaces the bullet marker", ta13.value === "- [ ] one\n- [ ] two", JSON.stringify(ta13.value));
  click("ol");
  check("numbered list converts and counts up", ta13.value === "1. one\n2. two", JSON.stringify(ta13.value));
  click("ol");
  check("numbered list toggles off", ta13.value === "one\ntwo", JSON.stringify(ta13.value));

  ta13.value = "";
  setSelection(0);
  click("hr");
  check("divider inserted", /^---\n?$/.test(ta13.value), JSON.stringify(ta13.value));

  ta13.value = "local edit";
  setSelection(6);
  click("bold");
  check("toolbar edits count as typing (local autosave fires)",
    await new Promise(resolve => setTimeout(() => resolve(win.localStorage.getItem("dash-scratchpad") === "local **bold text**edit"), 600)),
    win.localStorage.getItem("dash-scratchpad"));

  const boldButton = d13.querySelector('[data-md="bold"]');
  const press = new win.KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
  ta13.value = "hotkey";
  setSelection(0, 6);
  ta13.dispatchEvent(press);
  check("Ctrl+B bolds", ta13.value === "**hotkey**", JSON.stringify(ta13.value));
  check("Ctrl+B is prevented from reaching the browser", press.defaultPrevented === true);

  console.log("\n[14] live markdown preview, with tickable task checkboxes");
  win = makeWindow();
  await flush();
  const d14 = win.document;
  const ta14 = d14.getElementById("scratchpad-text");
  const preview = d14.getElementById("scratchpad-preview");
  const toggle = d14.getElementById("scratchpad-preview-toggle");
  check("preview starts hidden", preview.hidden === true && toggle.getAttribute("aria-pressed") === "false");
  ta14.value = "# Heading\n\nSome **bold**, *italic* and ~~struck~~ text.\n\n- bullet\n1. numbered\n\n- [ ] open task\n- [x] done task\n\n---";
  toggle.click();
  await flush();
  check("preview shows", preview.hidden === false && toggle.getAttribute("aria-pressed") === "true");
  check("heading rendered", preview.querySelector("h1") && preview.querySelector("h1").textContent === "Heading", preview.innerHTML.slice(0, 120));
  check("bold / italic / strike rendered", preview.querySelector("strong") && preview.querySelector("em") && preview.querySelector("del"));
  check("lists rendered", preview.querySelector("ul li") && preview.querySelector("ol li"));
  check("divider rendered", !!preview.querySelector("hr"));
  const boxes = preview.querySelectorAll('input[type="checkbox"][data-md-line]');
  check("task checkboxes rendered with their line numbers", boxes.length === 2, String(boxes.length));
  check("checked task reflects the source", boxes[1].checked === true && boxes[0].checked === false);
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new win.Event("change", { bubbles: true }));
  await flush();
  check("ticking a preview checkbox edits the source", /- \[x\] open task/.test(ta14.value), JSON.stringify(ta14.value));
  check("the other task is untouched", /- \[x\] done task/.test(ta14.value));
  check("edit propagates to local autosave", await new Promise(r => setTimeout(() => r(win.localStorage.getItem("dash-scratchpad").includes("- [x] open task")), 600)));

  ta14.value = '<img src=x onerror="alert(1)"> **ok**';
  ta14.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  check("raw HTML in notes is escaped, not executed", preview.querySelector("img") === null && /&lt;img/.test(preview.innerHTML), preview.innerHTML.slice(0, 100));

  console.log("\n[15] a missing `scratch` repo is created automatically");
  github = makeGithub({ reposWithoutScratch: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush(); await flush();
  check("POST /user/repos asked for a private scratch repo", github.state.createdRepos.length === 1 && github.state.createdRepos[0].name === "scratch" && github.state.createdRepos[0].private === true, JSON.stringify(github.state.createdRepos));
  check("repo is initialised so it has a default branch", github.state.createdRepos[0]?.auto_init === true);
  check("new repo becomes the selection", win.document.getElementById("scratchpad-gh-repo").value === "octocat/scratch", win.document.getElementById("scratchpad-gh-repo").value);
  check("selection is remembered", win.localStorage.getItem("dash-scratchpad-gh-repo") === "octocat/scratch");
  check("the panel ends up pointing at the scratch repo", /scratch/.test(win.document.getElementById("scratchpad-gh-repo").value), win.document.getElementById("scratchpad-gh-repo").value);
  check("no error help is shown on success", win.document.getElementById("scratchpad-gh-repo-help").hidden === true);

  console.log("\n[16] an existing `scratch` repo is used as-is, and org installs create in the org");
  github = makeGithub({ reposWithScratch: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush();
  check("nothing is created when scratch already exists", github.state.createdRepos.length === 0);
  check("scratch is preferred over other repos", win.document.getElementById("scratchpad-gh-repo").value === "octocat/scratch", win.document.getElementById("scratchpad-gh-repo").value);

  github = makeGithub({ reposWithoutScratch: true, orgAccount: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": { ...APP_RECORD, installation_type: "Organization" } }, fetchImpl: github.handle });
  await flush(); await flush(); await flush();
  check("org installs create via /orgs/{org}/repos", github.state.createdRepos[0]?.path === "/orgs/octocat/repos", JSON.stringify(github.state.createdRepos));

  console.log("\n[17] if the app may not create repos, the panel explains the fix but keeps working");
  github = makeGithub({ reposWithoutScratch: true, denyCreate: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush(); await flush();
  const d17 = win.document;
  const help = d17.getElementById("scratchpad-gh-repo-help");
  check("help is shown", help.hidden === false);
  check("help links to the app's permissions", /settings\/apps\/dash-notes-example\/permissions/.test(help.innerHTML), help.innerHTML.slice(0, 160));
  check("help links to creating the repo by hand", /github\.com\/new\?name=scratch/.test(help.innerHTML));
  check("status mentions Repository creation", /Repository creation/.test(d17.getElementById("scratchpad-gh-status").textContent), d17.getElementById("scratchpad-gh-status").textContent);
  check("saving to another repo is still possible", d17.getElementById("scratchpad-gh-target").hidden === false && d17.getElementById("scratchpad-gh-repo").value === "octocat/notes");
  d17.getElementById("scratchpad-gh-scratch").click();
  await flush(); await flush();
  check("Use scratch repo retries the creation", github.state.createAttempts >= 2, String(github.state.createAttempts));

  console.log("\n[18] the layout is responsive and the controls are touch-sized");
  win = makeWindow();
  await flush();
  const d18 = win.document;
  const css = [...d18.querySelectorAll("style")].map(node => node.textContent).join("\n");
  check("phone breakpoint exists", /@media \(max-width: 640px\)/.test(css));
  check("tablet breakpoint exists", /@media \(max-width: 900px\)/.test(css));
  check("the dialog becomes a full-height sheet on phones", /#modal-scratchpad[\s\S]{0,200}height: 100dvh/.test(css), "no 100dvh rule found");
  check("preview stacks under the editor on narrow screens", /@media \(max-width: 900px\)[\s\S]{0,200}flex-direction: column/.test(css));
  const mediaBlock = (query) => {
    const at = css.indexOf(`@media (${query})`);
    if (at === -1) return "";
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") { depth -= 1; if (depth === 0) return css.slice(at, i + 1); }
    }
    return css.slice(at);
  };
  const phone = mediaBlock("max-width: 640px");
  check("buttons stay finger-sized on phones", /min-height: 36px/.test(phone), phone.slice(0, 200));
  check("the GitHub panel collapses to one column", /gh-sync-details \{ grid-template-columns: 1fr/.test(phone));
  check("list rows wrap on phones so nothing overflows", /flex-wrap: wrap|grid-template-columns: 1fr/.test(phone));
  check("toolbar is a wrapping flex row", /\.md-toolbar \{[^}]*flex-wrap: wrap/.test(css) && d18.querySelector(".md-toolbar").children.length > 1);
  check("editor area is a flex pair", /\.scratch-editor \{[^}]*display: flex/.test(css));
  check("every markdown tool is present", ["bold", "italic", "strike", "h1", "h2", "h3", "ul", "ol", "task", "hr", "quote"].every(tool => d18.querySelector(`.md-toolbar [data-md="${tool}"]`)), "");

  console.log("\n[19] `scratch` is the default repo even when another one was used before");
  github = makeGithub({ reposWithScratch: true });
  win = makeWindow({
    storage: {
      "dash-scratchpad-gh-app-v2": APP_RECORD,
      // The user previously saved to `octocat/notes` — `scratch` must still win.
      "dash-scratchpad-gh-repo": "octocat/notes"
    },
    fetchImpl: github.handle
  });
  await flush(); await flush(); await flush();
  const d19 = win.document;
  check("scratch is selected over the remembered repo", d19.getElementById("scratchpad-gh-repo").value === "octocat/scratch", d19.getElementById("scratchpad-gh-repo").value);
  check("the remembered repo is still in the list", [...d19.querySelectorAll("#scratchpad-gh-repo option")].some(o => o.value === "octocat/notes"));
  check("the choice is persisted as scratch", win.localStorage.getItem("dash-scratchpad-gh-repo") === "octocat/scratch");

  // Without a scratch repo, the remembered choice is respected (no silent hijacking).
  github = makeGithub({ reposWithoutScratch: true, denyCreate: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD, "dash-scratchpad-gh-repo": "octocat/notes" }, fetchImpl: github.handle });
  await flush(); await flush(); await flush();
  check("falls back to the remembered repo when scratch can't exist", win.document.getElementById("scratchpad-gh-repo").value === "octocat/notes", win.document.getElementById("scratchpad-gh-repo").value);

  console.log("\n[20] the editor header shows the repo and file name");
  win = makeWindow();
  await flush();
  const d20 = win.document;
  check("header exists above the editor", !!d20.getElementById("scratchpad-filebar") && d20.getElementById("scratchpad-filebar").nextElementSibling.id === "scratchpad-editor");
  check("disconnected header says Local only", d20.getElementById("scratchpad-filebar-repo").textContent === "Local only", d20.getElementById("scratchpad-filebar-repo").textContent);
  check("header still shows the file name", /^notes-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(d20.getElementById("scratchpad-filebar-file").textContent), d20.getElementById("scratchpad-filebar-file").textContent);
  check("separator hidden while local-only", d20.getElementById("scratchpad-filebar-sep").hidden === true);

  github = makeGithub({ reposWithScratch: true });
  win = makeWindow({ storage: { "dash-scratchpad-gh-app-v2": APP_RECORD }, fetchImpl: github.handle });
  await flush(); await flush(); await flush();
  const d20b = win.document;
  check("connected header shows the repo", d20b.getElementById("scratchpad-filebar-repo").textContent === "octocat/scratch", d20b.getElementById("scratchpad-filebar-repo").textContent);
  check("connected header shows the file name", /^notes-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(d20b.getElementById("scratchpad-filebar-file").textContent), d20b.getElementById("scratchpad-filebar-file").textContent);
  check("separator shown between them", d20b.getElementById("scratchpad-filebar-sep").hidden === false);

  d20b.getElementById("scratchpad-gh-path").value = "notes/deep/dive.md";
  d20b.getElementById("scratchpad-gh-path").dispatchEvent(new win.Event("input", { bubbles: true }));
  check("typing a path updates the header immediately", d20b.getElementById("scratchpad-filebar-file").textContent === "notes/deep/dive.md", d20b.getElementById("scratchpad-filebar-file").textContent);
  d20b.getElementById("scratchpad-gh-path").dispatchEvent(new win.Event("change", { bubbles: true }));
  check("header says the new file isn't saved yet", /Not saved/.test(d20b.getElementById("scratchpad-filebar-state").textContent), d20b.getElementById("scratchpad-filebar-state").textContent);

  d20b.getElementById("scratchpad-gh-new-file").click();
  await flush();
  check("New dated file updates the header", /^notes-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(d20b.getElementById("scratchpad-filebar-file").textContent), d20b.getElementById("scratchpad-filebar-file").textContent);

  d20b.getElementById("scratchpad-text").value = "header sync test";
  d20b.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("a successful save reports synced in the header", /Synced to GitHub/.test(d20b.getElementById("scratchpad-filebar-state").textContent), d20b.getElementById("scratchpad-filebar-state").textContent);
  check("the synced state is styled as success", d20b.getElementById("scratchpad-filebar-state").classList.contains("is-saved"));

  console.log("\n[21] emoji picker inserts emoji into the note");
  win = makeWindow();
  await flush();
  const d21 = win.document;
  const emojiBtn = d21.getElementById("scratchpad-emoji-btn");
  const picker = d21.getElementById("scratchpad-emoji-picker");
  const emojiSearch = d21.getElementById("scratchpad-emoji-search");
  const ta21 = d21.getElementById("scratchpad-text");
  check("emoji button is in the toolbar", !!emojiBtn && !!emojiBtn.closest(".md-toolbar"));
  check("picker starts closed", picker.hidden === true && emojiBtn.getAttribute("aria-expanded") === "false");
  emojiBtn.click();
  check("clicking opens the picker", picker.hidden === false && emojiBtn.getAttribute("aria-expanded") === "true");
  check("picker lists categories", d21.querySelectorAll("#scratchpad-emoji-list .emoji-category").length >= 5, String(d21.querySelectorAll("#scratchpad-emoji-list .emoji-category").length));
  const emojiCount = d21.querySelectorAll("#scratchpad-emoji-list .emoji-btn").length;
  check("picker has a good spread of emoji", emojiCount >= 60, String(emojiCount));

  ta21.value = "note text";
  ta21.setSelectionRange(4, 4);
  const fireButton = [...d21.querySelectorAll("#scratchpad-emoji-list .emoji-btn")].find(b => b.textContent === "🔥");
  fireButton.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  check("emoji inserted at the caret", ta21.value === "note🔥 text", JSON.stringify(ta21.value));
  check("picker closes after inserting", picker.hidden === true);

  emojiBtn.click();
  emojiSearch.value = "check";
  emojiSearch.dispatchEvent(new win.Event("input", { bubbles: true }));
  const results = [...d21.querySelectorAll("#scratchpad-emoji-list .emoji-btn")].map(b => b.textContent);
  check("search narrows to the matching emoji", results.length >= 1 && results.length <= 3 && results.includes("✅"), JSON.stringify(results));
  check("results are grouped under a Results heading", /Results/.test(d21.querySelector("#scratchpad-emoji-list .emoji-category").textContent));

  emojiSearch.value = "tada";
  emojiSearch.dispatchEvent(new win.Event("input", { bubbles: true }));
  ta21.value = "ship it";
  ta21.setSelectionRange(7, 7);
  const firstResult = d21.querySelector("#scratchpad-emoji-list .emoji-btn");
  firstResult.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  check("keyword search finds the emoji by name", ta21.value === "ship it🎉", JSON.stringify(ta21.value));

  emojiBtn.click();
  emojiSearch.value = "zzzz-nope";
  emojiSearch.dispatchEvent(new win.Event("input", { bubbles: true }));
  check("no matches shows an empty state", /No emoji match/.test(d21.querySelector("#scratchpad-emoji-list").textContent));
  emojiSearch.value = "";
  emojiSearch.dispatchEvent(new win.Event("input", { bubbles: true }));

  ta21.value = "replace me";
  ta21.setSelectionRange(0, 7);
  const checkButton = [...d21.querySelectorAll("#scratchpad-emoji-list .emoji-btn")][0];
  checkButton.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  check("emoji replaces the selected text", ta21.value === "✅ me", JSON.stringify(ta21.value));

  emojiBtn.click();
  emojiSearch.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape closes the picker", picker.hidden === true);
  emojiBtn.click();
  d21.body.click();
  check("clicking outside closes the picker", picker.hidden === true);

  ta21.value = "enter test";
  ta21.setSelectionRange(10, 10);
  emojiBtn.click();
  emojiSearch.value = "fire";
  emojiSearch.dispatchEvent(new win.Event("input", { bubbles: true }));
  emojiSearch.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  check("Enter inserts the first match", ta21.value === "enter test🔥", JSON.stringify(ta21.value));

  const ta22 = d21.getElementById("scratchpad-text");
  ta22.value = "with emoji 🎉";
  ta22.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  check("emoji edits are autosaved like any typing", win.localStorage.getItem("dash-scratchpad") === "with emoji 🎉");

  const d22 = d21;
  d21.getElementById("scratchpad-preview-toggle").click();
  await flush();
  check("emoji render in the preview untouched", d22.getElementById("scratchpad-preview").textContent.includes("🎉"));

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
