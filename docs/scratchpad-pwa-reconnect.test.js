// Page-level tests for the Scratchpad PWA's reconnect kit.
//
//   npm install jsdom
//   node docs/scratchpad-pwa-reconnect.test.js
//
// The PWA is an ES-module page, so this harness gives assets/scratchpad.js the
// browser globals it expects (jsdom's document, Node's WebCrypto), then drives
// the "Already have the app? Reconnect" panel exactly as a user would: paste an
// App ID + private key, let GitHub confirm the pair, and check that the existing
// app is adopted (no second app created) and that its key can be downloaded.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { webcrypto, generateKeyPairSync } = require("crypto");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures += 1; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonRes = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

(async () => {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(String(error.message || error)));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "scratchpad.html"), "utf8"), {
    url: "https://aacareq.github.io/dash/scratchpad.html",
    pretendToBeVisual: true,
    virtualConsole
  });
  const win = dom.window;

  // Hand the module the globals a browser would provide. `crypto` and `navigator` are getter-only on
  // Node's globalThis, hence defineProperty.
  for (const key of ["window", "document", "location", "navigator", "sessionStorage", "localStorage",
    "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Event", "CustomEvent",
    "Blob", "File", "URL", "URLSearchParams", "AbortController", "Node", "Element", "DOMParser",
    "getComputedStyle", "requestAnimationFrame"]) {
    if (!(key in win)) continue;
    try { globalThis[key] = win[key]; }
    catch (error) { Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true }); }
  }
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.btoa = value => Buffer.from(value, "binary").toString("base64");
  globalThis.atob = value => Buffer.from(value, "base64").toString("binary");

  const calls = [];
  const issued = { installations: [{ id: 424242, account: { login: "octocat" }, target_type: "User" }] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/app")) {
      return jsonRes({ id: 987654, slug: "dash-notes-example", name: "dash notes", owner: { login: "octocat" }, html_url: "https://github.com/apps/dash-notes-example" });
    }
    if (target.includes("/access_tokens")) return jsonRes({ token: "ghs_minted", expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
    if (target.includes("/app/installations")) return jsonRes(issued.installations);
    if (target.includes("/installation/repositories")) {
      return jsonRes({ total_count: 1, repositories: [{ full_name: "octocat/scratch", name: "scratch" }] });
    }
    return jsonRes({});
  };

  const downloads = [];
  const blobs = [];
  win.URL.createObjectURL = blob => { blobs.push(blob); return "blob:connection"; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function click() { downloads.push({ name: this.download, href: this.href }); };

  await import(pathToFileURL(path.join(ROOT, "assets", "scratchpad.js")).href);
  await wait(400);

  const $ = id => win.document.getElementById(id);
  const storedApp = () => JSON.parse(win.localStorage.getItem("dash-scratchpad-gh-app-v2") || "null");

  console.log("\n[1] a page with no credentials offers both setup and reconnect");
  check("the page boots without script errors", errors.length === 0, errors.join(" | "));
  check("setup is offered", $("scratchpad-gh-setup").hidden === false);
  check("the reconnect panel exists and says where the pieces come from",
    /Already have the app\?/.test($("scratchpad-gh-restore").querySelector("summary").textContent) &&
    /Generate a private key/.test($("scratchpad-gh-restore").textContent));
  check("the hint steers away from creating a second app", /Reconnect below/.test($("scratchpad-gh-hint").textContent),
    $("scratchpad-gh-hint").textContent);
  check("nothing can be downloaded before there is a connection", $("scratchpad-gh-export").hidden === true);

  console.log("\n[2] App ID + private key adopts the existing app");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  $("scratchpad-gh-restore-app-id").value = "987654";
  $("scratchpad-gh-restore-pem").value = pem;
  $("scratchpad-gh-restore-go").click();
  await wait(700);
  const adopted = storedApp();
  check("the app record is stored", adopted && adopted.app_id === 987654, JSON.stringify(adopted && adopted.app_id));
  check("GitHub confirmed the key with GET /app", calls.some(call => call.target === "https://api.github.com/app"));
  check("the existing installation is picked up", adopted && adopted.installation_id === 424242, JSON.stringify(adopted && adopted.installation_id));
  check("the panel says no new app was created", /no new GitHub App was created/.test($("scratchpad-gh-status").textContent),
    $("scratchpad-gh-status").textContent);
  check("saving controls appear", $("scratchpad-gh-target").hidden === false);

  console.log("\n[3] the key can be saved as a file, and the nudge retires");
  check("download is offered", $("scratchpad-gh-export").hidden === false);
  check("keep-a-copy nudge is shown", $("scratchpad-gh-keep").hidden === false);
  $("scratchpad-gh-export").click();
  await wait(300);
  check("a named connection file was produced", downloads[0] && downloads[0].name === "dash-github-connection-dash-notes-example.json",
    JSON.stringify(downloads));
  const saved = JSON.parse(await blobs[0].text());
  check("the file carries the app id and key", saved.app_id === 987654 && /BEGIN RSA PRIVATE KEY/.test(saved.pem));
  check("the file never carries a short-lived token", !("installation_token" in saved));
  check("the nudge is gone once a copy exists", $("scratchpad-gh-keep").hidden === true);
  check("the download is remembered in the record", storedApp().connection_saved_at > 0);

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
