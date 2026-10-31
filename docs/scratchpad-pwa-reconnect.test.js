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
    calls.push({ target, options, method: (options.method || "GET").toUpperCase() });
    if (target.endsWith("/app")) {
      return jsonRes({ id: 987654, slug: "dash-notes-example", name: "dash notes", owner: { login: "octocat" }, html_url: "https://github.com/apps/dash-notes-example" });
    }
    if (target.includes("/access_tokens")) return jsonRes({ token: "ghs_minted", expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
    if (target.includes("/app/installations")) return jsonRes(issued.installations);
    if (target.includes("/installation/repositories")) {
      return jsonRes({ total_count: 1, repositories: [{ full_name: "octocat/scratch", name: "scratch" }] });
    }
    if (target.includes("/repos/")) {
      // Nothing exists yet: creation reads first (404) and then PUTs.
      if ((options.method || "GET").toUpperCase() === "GET") return jsonRes({ message: "Not Found" }, 404);
      return jsonRes({ content: { sha: `sha-${calls.filter(call => call.method === "PUT").length}` } });
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

  console.log("\n[4] the pad's own chrome: sheet, menu, clock, tables");
  const $q = selector => win.document.querySelector(selector);
  check("day/date/time is stamped in the filebar", ($("scratchpad-clock")?.textContent || "").length > 6, $("scratchpad-clock")?.textContent);
  check("the six actions are in the ⋯ menu",
    ["scratchpad-copy", "scratchpad-export-txt", "scratchpad-export-md", "scratchpad-save-file", "scratchpad-open-file", "scratchpad-clear"]
      .every(id => $(id)?.closest("#scratchpad-menu")), "an action is outside the menu");
  check("the menu is closed until asked", $("scratchpad-menu").hidden === true);
  $("scratchpad-menu-btn").click();
  check("More opens it", $("scratchpad-menu").hidden === false);
  $("scratchpad-menu-btn").click();
  check("and closes it again", $("scratchpad-menu").hidden === true);

  const sheet = $("scratchpad-gh-panel");
  check("GitHub settings start in a closed sheet", sheet.open === false && sheet.tagName === "DIALOG", sheet.tagName);
  $("scratchpad-gh-open").click();
  check("⚙ GitHub sync opens it", sheet.open === true);
  check("the repo picker lives inside it", $("scratchpad-gh-repo").closest("#scratchpad-gh-panel") !== null);
  check("the table tool is on the toolbar", Boolean($q('.md-toolbar [data-md="table"]')));
  const tipText = $q(".scratch-tip")?.textContent || "";
  check("the pad explains tables, the sheet and the menu in place",
    /Table/.test(tipText) && /GitHub sync/.test(tipText) && /More/.test(tipText), tipText.slice(0, 120));

  console.log("\n[5] files and folders can be created straight from the sheet");
  const notesArea = $("scratchpad-text");
  notesArea.value = "# Plan\n\n- [ ] ship it";
  notesArea.dispatchEvent(new win.Event("input", { bubbles: true }));
  $("scratchpad-gh-repo").value = "octocat/scratch";
  $("scratchpad-gh-path").value = "notes/current.md";
  $("scratchpad-gh-path").dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(200);
  $("scratchpad-gh-new-path").value = "projects/launch/plan";
  $("scratchpad-gh-new-type").value = "md";
  $("scratchpad-gh-create-file").click();
  await wait(600);
  const filePut = calls.find(call => call.method === "PUT" && call.target.includes("/contents/projects/launch/plan.md"));
  check("the new file is committed at the typed path", Boolean(filePut), calls.map(call => `${call.method} ${call.target}`).join(" | "));
  check("it holds the notes in the pad",
    filePut && Buffer.from(JSON.parse(filePut.options.body).content, "base64").toString("utf8") === "# Plan\n\n- [ ] ship it");
  check("the pad switches to the new file", $("scratchpad-gh-path").value === "projects/launch/plan.md", $("scratchpad-gh-path").value);
  check("the status says it was created", /Created octocat\/scratch\/projects\/launch\/plan\.md/.test($("scratchpad-gh-status").textContent),
    $("scratchpad-gh-status").textContent);

  $("scratchpad-gh-new-folder").value = "projects/launch/assets";
  $("scratchpad-gh-create-folder").click();
  await wait(600);
  const folderPut = calls.find(call => call.method === "PUT" && call.target.includes("/contents/projects/launch/assets/.gitkeep"));
  check("a folder is created with a .gitkeep", Boolean(folderPut), calls.map(call => `${call.method} ${call.target}`).join(" | "));
  check("the folder status explains the placeholder", /gitkeep/.test($("scratchpad-gh-status").textContent), $("scratchpad-gh-status").textContent);

  console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
