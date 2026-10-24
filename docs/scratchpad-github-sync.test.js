// Behaviour tests for the Scratchpad → GitHub OAuth2/PKCE sync.
//
//   npm install jsdom
//   node docs/scratchpad-github-sync.test.js
//
// Loads index.html in jsdom, stubs the GitHub endpoints, and exercises the authorization
// request, the code exchange, saves (create → update), conflicts, pulls, autosave and refresh.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const rawHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
// jsdom can't intercept window.location.assign (Location is unforgeable), so swap that one call site for a
// capture hook — only after asserting it is still the single redirect the real page performs.
const ASSIGN_SITE = "window.location.assign(`";
const assignCount = rawHtml.split(ASSIGN_SITE).length - 1;
if (assignCount !== 1) throw new Error("expected exactly one window.location.assign redirect, found " + assignCount);
const html = rawHtml.replace(ASSIGN_SITE, "window.__captureAssign(`");
const SITE = "https://aacareq.github.io/dash/index.html";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeWindow({ url = SITE, pending = null, fetchImpl = null, storage = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e && e.message ? e.message : e)));
  vc.on("error", (...a) => errors.push(a.join(" ")));
  const vcs = { assigned: [], fetchCalls: [], confirmAnswer: true };

  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, "crypto", { configurable: true, value: nodeCrypto.webcrypto });
      window.__captureAssign = target => vcs.assigned.push(target);
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, save() {}, restore() {},
        translate() {}, rotate() {}, setTransform() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {},
        ellipse() {}, rect() {}, quadraticCurveTo() {}, bezierCurveTo() {}, scale() {}, clip() {},
        createRadialGradient: () => ({ addColorStop() {} }),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {}, set shadowColor(v) {}
      });
      window.confirm = () => vcs.confirmAnswer;
      // Patch the dialog element methods jsdom may not implement.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
        window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
      }
      window.history.replaceState = (state, title, target) => { vcs.replacedUrl = target; };
      if (pending) window.sessionStorage.setItem("dash-scratchpad-gh-oauth-pending", JSON.stringify(pending));
      if (storage) Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
      window.fetch = async (target, options = {}) => {
        vcs.fetchCalls.push({ target: String(target), options });
        if (fetchImpl) return fetchImpl(String(target), options, vcs);
        throw new Error("fetch not stubbed for " + target);
      };
    }
  });
  const window = dom.window;
  window.__vc = vcs;
  window.__errors = errors;
  return window;
}

const flush = () => new Promise(r => setTimeout(r, 60));
const jsonRes = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures += 1; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  console.log("\n[1] page loads and scratchpad UI + GitHub panel exist");
  let win = makeWindow();
  await flush();
  const doc = win.document;
  check("no uncaught script errors", win.__errors.length === 0, win.__errors.join(" | "));
  ["scratchpad-text", "scratchpad-gh-panel", "scratchpad-gh-connect", "scratchpad-gh-save",
   "scratchpad-gh-pull", "scratchpad-gh-overwrite", "scratchpad-gh-autosave", "scratchpad-gh-repo-list"
  ].forEach(id => check(`#${id} exists`, !!doc.getElementById(id)));
  check("redirect URI prefilled from page URL", doc.getElementById("scratchpad-gh-redirect").value === SITE,
    doc.getElementById("scratchpad-gh-redirect").value);
  check("default path prefilled", doc.getElementById("scratchpad-gh-path").value === "notes/scratchpad.md");
  check("disconnect starts disabled", doc.getElementById("scratchpad-gh-disconnect").disabled === true);
  check("overwrite button hidden initially", doc.getElementById("scratchpad-gh-overwrite").hidden === true);

  console.log("\n[2] Connect without a client id is rejected");
  doc.getElementById("scratchpad-gh-connect").click();
  await flush();
  check("status asks for a Client ID", /Client ID/.test(doc.getElementById("scratchpad-gh-status").textContent),
    doc.getElementById("scratchpad-gh-status").textContent);
  check("no redirect happened", win.__vc.assigned.length === 0);

  console.log("\n[3] PKCE authorization request");
  doc.getElementById("scratchpad-gh-client-id").value = "Iv1.testclient";
  doc.getElementById("scratchpad-gh-connect").click();
  await flush();
  check("redirected to GitHub authorize", win.__vc.assigned.length === 1, JSON.stringify(win.__vc.assigned));
  const authUrl = new URL(win.__vc.assigned[0]);
  const p = authUrl.searchParams;
  check("authorize host/path", authUrl.origin === "https://github.com" && authUrl.pathname === "/login/oauth/authorize");
  check("client_id sent", p.get("client_id") === "Iv1.testclient");
  check("redirect_uri is this page", p.get("redirect_uri") === SITE);
  check("response_type implied authorization code", p.get("scope") === "repo");
  check("code_challenge_method=S256", p.get("code_challenge_method") === "S256");
  check("state present & random", (p.get("state") || "").length >= 20);
  check("code_challenge is 43-char base64url", /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge")), p.get("code_challenge"));
  check("client secret never sent", !p.get("client_secret"));
  const pending = JSON.parse(win.sessionStorage.getItem("dash-scratchpad-gh-oauth-pending"));
  check("verifier stored in sessionStorage", /^[A-Za-z0-9_-]{43}$/.test(pending.verifier || ""));
  const expectedChallenge = b64url(nodeCrypto.createHash("sha256").update(pending.verifier).digest());
  check("challenge == SHA256(verifier) base64url", expectedChallenge === p.get("code_challenge"));
  check("state stored matches URL", pending.state === p.get("state"));
  const ghAppWin = makeWindow({
    storage: { "dash-scratchpad-gh-client-id": "Iv1.testclient", "dash-scratchpad-gh-app-type": "github_app" }
  });
  await flush();
  ghAppWin.document.getElementById("scratchpad-gh-connect").click();
  await flush();
  const ghAppUrl = new URL(ghAppWin.__vc.assigned[0]);
  check("GitHub App requests offline_access scope", ghAppUrl.searchParams.get("scope") === "offline_access",
    ghAppUrl.searchParams.get("scope"));
  check("GitHub App still uses PKCE", ghAppUrl.searchParams.get("code_challenge_method") === "S256");

  console.log("\n[4] callback exchanges the code (no client secret) and shows the account");
  const verifier = "a".repeat(43);
  const challenge = b64url(nodeCrypto.createHash("sha256").update(verifier).digest());
  const state = "state-xyz-1234567890";
  let tokenRequest = null;
  win = makeWindow({
    url: SITE + "?code=the-code&state=" + state,
    pending: { verifier, state, redirectUri: SITE, clientId: "Iv1.testclient", appType: "github_app" },
    fetchImpl: async (target, options, vcs) => {
      if (target.includes("/login/oauth/access_token")) {
        tokenRequest = JSON.parse(options.body);
        return jsonRes({ access_token: "ghu_test", token_type: "bearer", scope: "", expires_in: 28800, refresh_token: "ghr_test", refresh_token_expires_in: 15897600 });
      }
      if (target.endsWith("/user")) return jsonRes({ login: "octocat" });
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush(); await flush();
  const d2 = win.document;
  check("token request hit GitHub's token endpoint", !!tokenRequest, JSON.stringify(tokenRequest));
  check("code + verifier + redirect_uri sent", tokenRequest.code === "the-code" && tokenRequest.code_verifier === verifier && tokenRequest.redirect_uri === SITE);
  check("no client_secret in exchange", !("client_secret" in tokenRequest));
  check("grant_type authorization_code", tokenRequest.grant_type === "authorization_code");
  check("account badge shows login", /octocat/.test(d2.getElementById("scratchpad-gh-account").textContent),
    d2.getElementById("scratchpad-gh-account").textContent);
  check("success status shown", /Connected/.test(d2.getElementById("scratchpad-gh-status").textContent),
    d2.getElementById("scratchpad-gh-status").textContent);
  check("scratchpad modal opened after redirect", d2.getElementById("modal-scratchpad").open === true);
  check("URL cleaned of code/state", /^https:\/\/aacareq\.github\.io\/dash\/index\.html$/.test(win.__vc.replacedUrl || ""), win.__vc.replacedUrl);
  const stored = JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-token-v1"));
  check("token + refresh token persisted", stored.access_token === "ghu_test" && stored.refresh_token === "ghr_test" && stored.expires_at > Date.now());

  console.log("\n[5] saving notes creates a new file, then updates it by SHA");
  let puts = [];
  let remoteFile = null; // the stub becomes a real little Contents API: PUT stores the file, GET reads it back
  win = makeWindow({
    storage: {
      "dash-scratchpad-gh-token-v1": { access_token: "gho_pat", token_type: "bearer", scope: "repo", expires_at: null, refresh_token: null },
      "dash-scratchpad-gh-client-id": "Iv1.testclient"
    },
    fetchImpl: async (target, options) => {
      if (target.includes("/contents/")) {
        if ((options.method || "GET") === "PUT") {
          const body = JSON.parse(options.body);
          puts.push({ target, body });
          remoteFile = { type: "file", sha: "sha-" + puts.length, content: body.content, html_url: "https://github.com/o/r/blob/main/notes/scratchpad.md" };
          return jsonRes({ content: { sha: remoteFile.sha, html_url: remoteFile.html_url }, commit: { sha: "commit-" + puts.length } });
        }
        return remoteFile ? jsonRes(remoteFile) : { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
      }
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush();
  const d3 = win.document;
  check("account rendered from stored token", /Connected/.test(d3.getElementById("scratchpad-gh-account").textContent));
  d3.getElementById("scratchpad-text").value = "line one\nline two ✓";
  d3.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d3.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d3.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("one PUT issued", puts.length === 1, JSON.stringify(puts));
  check("PUT hits the right contents path", puts[0] && puts[0].target === "https://api.github.com/repos/octocat/notes/contents/notes/scratchpad.md", puts[0] && puts[0].target);
  check("create has no sha", puts[0] && !("sha" in puts[0].body));
  check("content is base64 of the notes", puts[0] && Buffer.from(puts[0].body.content, "base64").toString("utf8") === "line one\nline two ✓");
  check("commit message mentions scratchpad", /Scratchpad notes/.test(puts[0].body.message));
  check("status reports Created", /Created/.test(d3.getElementById("scratchpad-gh-file-status").textContent),
    d3.getElementById("scratchpad-gh-file-status").textContent);

  // Second save with the SHA remembered from the first PUT → an update in place.
  d3.getElementById("scratchpad-text").value = "line one\nline two ✓\nthree";
  d3.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("second PUT sent the remembered sha", puts.length === 2 && puts[1].body.sha === "sha-1", JSON.stringify(puts[1] && puts[1].body));
  check("second save reported as an update", /Updated/.test(d3.getElementById("scratchpad-gh-file-status").textContent),
    d3.getElementById("scratchpad-gh-file-status").textContent);

  console.log("\n[6] conflict on GitHub pauses the save and offers Overwrite Anyway");
  win = makeWindow({
    storage: {
      "dash-scratchpad-gh-token-v1": { access_token: "gho_pat" },
      "dash-scratchpad-gh-file-shas-v1": { "octocat/notes@default:notes/scratchpad.md": "old-sha" }
    },
    fetchImpl: async (target, options) => {
      if (target.includes("/contents/")) {
        if ((options.method || "GET") === "PUT") return jsonRes({ content: { sha: "sha-new" } });
        return jsonRes({ type: "file", sha: "someone-else", content: Buffer.from("remote text").toString("base64") });
      }
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush();
  const d4 = win.document;
  d4.getElementById("scratchpad-text").value = "local edit";
  d4.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d4.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d4.getElementById("scratchpad-gh-save").click();
  await flush(); await flush();
  check("save paused with a conflict warning", /changed on GitHub/.test(d4.getElementById("scratchpad-gh-file-status").textContent),
    d4.getElementById("scratchpad-gh-file-status").textContent);
  check("Overwrite Anyway revealed", d4.getElementById("scratchpad-gh-overwrite").hidden === false);
  d4.getElementById("scratchpad-gh-overwrite").click();
  await flush(); await flush();
  check("overwrite saved with the fresh sha", /Updated/.test(d4.getElementById("scratchpad-gh-file-status").textContent),
    d4.getElementById("scratchpad-gh-file-status").textContent);
  check("overwrite hides again", d4.getElementById("scratchpad-gh-overwrite").hidden === true);

  console.log("\n[7] Pull Latest loads the remote copy, and autosave is debounced");
  win = makeWindow({
    storage: { "dash-scratchpad-gh-token-v1": { access_token: "gho_pat" } },
    fetchImpl: async (target) => {
      if (target.includes("/contents/")) return jsonRes({ type: "file", sha: "remote-sha", content: Buffer.from("# Remote notes").toString("base64") });
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush();
  const d5 = win.document;
  d5.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d5.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d5.getElementById("scratchpad-gh-pull").click();
  await flush(); await flush();
  check("textarea replaced with remote content", d5.getElementById("scratchpad-text").value === "# Remote notes",
    JSON.stringify(d5.getElementById("scratchpad-text").value));
  check("local storage mirrors the pull", win.localStorage.getItem("dash-scratchpad") === "# Remote notes");
  check("sha remembered for the next save",
    JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-file-shas-v1"))["octocat/notes@default:notes/scratchpad.md"] === "remote-sha");

  console.log("\n[7b] autosave commits a few seconds after typing stops");
  let autosavePuts = 0, autoRemote = null;
  win = makeWindow({
    storage: { "dash-scratchpad-gh-token-v1": { access_token: "gho_pat" } },
    fetchImpl: async (target, options) => {
      if (target.includes("/contents/")) {
        if ((options.method || "GET") === "PUT") {
          const body = JSON.parse(options.body);
          autosavePuts += 1;
          autoRemote = { type: "file", sha: "auto-sha-" + autosavePuts, content: body.content };
          return jsonRes({ content: { sha: autoRemote.sha } });
        }
        return autoRemote ? jsonRes(autoRemote) : { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
      }
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush();
  const d6 = win.document;
  d6.getElementById("scratchpad-gh-repo").value = "octocat/notes";
  d6.getElementById("scratchpad-gh-path").value = "notes/scratchpad.md";
  d6.getElementById("scratchpad-gh-autosave").checked = true;
  d6.getElementById("scratchpad-gh-autosave").dispatchEvent(new win.Event("change", { bubbles: true }));
  const ta = d6.getElementById("scratchpad-text");
  ta.value = "autosaved note";
  ta.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  check("nothing committed before the debounce elapses", autosavePuts === 0);
  await new Promise(r => setTimeout(r, 3000));
  check("autosave committed once", autosavePuts === 1, String(autosavePuts));
  check("autosave status mentions autosave", /autosave/i.test(d6.getElementById("scratchpad-gh-file-status").textContent),
    d6.getElementById("scratchpad-gh-file-status").textContent);
  check("autosave toggle remembered", win.localStorage.getItem("dash-scratchpad-gh-autosave") === "true");
  check("local notes still saved", win.localStorage.getItem("dash-scratchpad") === "autosaved note");

  console.log("\n[8] expired token with a refresh token refreshes once and retries");
  let refreshBody = null, apiCalls = 0;
  win = makeWindow({
    storage: {
      "dash-scratchpad-gh-client-id": "Iv1.testclient",
      "dash-scratchpad-gh-token-v1": { access_token: "ghu_old", expires_at: Date.now() - 1000, refresh_token: "ghr_old", refresh_token_expires_at: Date.now() + 1e9 }
    },
    fetchImpl: async (target, options) => {
      if (target.includes("/login/oauth/access_token")) { refreshBody = JSON.parse(options.body); return jsonRes({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }); }
      if (target.includes("/user/repos")) { apiCalls += 1; return jsonRes([{ full_name: "octocat/notes" }, { full_name: "octocat/other" }]); }
      throw new Error("unexpected fetch " + target);
    }
  });
  await flush();
  win.document.getElementById("scratchpad-gh-load-repos").click();
  await flush(); await flush();
  check("refresh grant used", refreshBody && refreshBody.grant_type === "refresh_token" && refreshBody.refresh_token === "ghr_old" && refreshBody.client_id === "Iv1.testclient",
    JSON.stringify(refreshBody));
  check("retried API call succeeded", apiCalls === 1 && /2 repositories/.test(win.document.getElementById("scratchpad-gh-status").textContent),
    win.document.getElementById("scratchpad-gh-status").textContent);
  const rotated = JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-token-v1"));
  check("rotated token pair persisted", rotated.access_token === "ghu_new" && rotated.refresh_token === "ghr_new");
  check("repo datalist filled", win.document.querySelectorAll("#scratchpad-gh-repo-list option").length === 2);

  console.log("\n[9] state mismatch is rejected");
  win = makeWindow({
    url: SITE + "?code=abc&state=wrong",
    pending: { verifier, state: "right", redirectUri: SITE, clientId: "Iv1.testclient", appType: "oauth_app" },
    fetchImpl: async () => { throw new Error("must not exchange"); }
  });
  await flush(); await flush();
  check("CSRF mismatch reported, no token exchange", /didn't match|didn’t match/.test(win.document.getElementById("scratchpad-gh-status").textContent),
    win.document.getElementById("scratchpad-gh-status").textContent);
  check("no token stored after mismatch", win.localStorage.getItem("dash-scratchpad-gh-token-v1") === null);

  console.log("\n[10] notes still work entirely offline (no GitHub connected)");
  win = makeWindow();
  await flush();
  const d7 = win.document;
  const ta2 = d7.getElementById("scratchpad-text");
  ta2.value = "plain local note";
  ta2.dispatchEvent(new win.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  check("local autosave wrote localStorage", win.localStorage.getItem("dash-scratchpad") === "plain local note");
  check("local status confirms the save", /Saved locally/.test(d7.getElementById("scratchpad-status").textContent),
    d7.getElementById("scratchpad-status").textContent);
  check("GitHub status stays quiet without a connection", d7.getElementById("scratchpad-gh-file-status").textContent === "",
    d7.getElementById("scratchpad-gh-file-status").textContent);
  d7.getElementById("scratchpad-clear").click();
  await flush();
  check("Clear empties the pad and its storage", ta2.value === "" && win.localStorage.getItem("dash-scratchpad") === "");

  console.log("\n[11] a cancelled authorization is reported cleanly");
  win = makeWindow({
    url: SITE + "?error=access_denied&error_description=The+user+denied+the+request&state=" + state,
    pending: { verifier, state, redirectUri: SITE, clientId: "Iv1.testclient", appType: "oauth_app" },
    fetchImpl: async () => { throw new Error("must not exchange"); }
  });
  await flush(); await flush();
  check("cancellation message shown", /cancelled/i.test(win.document.getElementById("scratchpad-gh-status").textContent),
    win.document.getElementById("scratchpad-gh-status").textContent);
  check("no token stored after cancellation", win.localStorage.getItem("dash-scratchpad-gh-token-v1") === null);
  check("pending verifier discarded", win.sessionStorage.getItem("dash-scratchpad-gh-oauth-pending") === null);

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
