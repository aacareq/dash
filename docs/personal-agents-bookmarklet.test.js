// Behaviour tests for the "Personal AI Agents — Always-On" bookmarklet.
//
//   npm install jsdom
//   node docs/personal-agents-bookmarklet.test.js
//
// The Bookmarklets cluster (and the pinned bookmarklets in Favorites) includes
// a bookmarklet that opens every link in the Personal AI Agents — Always-On
// cluster. Its URL list is derived from that cluster's own card definitions,
// so these tests compare the two rendered clusters against each other: the
// bookmarklet must open exactly the personal-agent links, in cluster order,
// with nothing missing, extra, or duplicated.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const { webcrypto } = nodeCrypto;
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";
const BOOKMARKLET_ID = "bookmarklets:personal-ai-agents-always-on";
const EXPECTED_URLS = ["https://muse.ai/", "https://grok.com/bot/", "https://claude.ai/code"];

const flush = () => new Promise(r => setTimeout(r, 80));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  PASS  " + name);
  else { failures += 1; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}

function makeWindow({ storage = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e && e.message ? e.message : e)));
  const opens = [];

  const dom = new JSDOM(html, {
    url: SITE,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.confirm = () => true;
      // The tabs a bookmarklet would open, captured instead of really opened.
      window.open = (url, target) => { opens.push({ url: String(url), target }); return null; };
      window.Element.prototype.scrollIntoView = function scrollIntoView() {};
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
      if (storage) Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)));
      window.fetch = async target => { throw new Error("unexpected fetch " + target); };
    }
  });
  dom.window.__errors = errors;
  dom.window.__opens = opens;
  return dom.window;
}

const personalCards = doc => [...doc.querySelectorAll("#group-personalagents .card")];
const bookmarkletCards = doc => [...doc.querySelectorAll("#group-bookmarklets .card")];
const newBookmarkletCard = doc => bookmarkletCards(doc).find(c => c.dataset.id === BOOKMARKLET_ID);
const urlsIn = href => [...String(href).matchAll(/https?:\/\/[^'"]+/g)].map(m => m[0]);

(async () => {
  console.log("\n[1] the Personal AI Agents cluster is unchanged and the bookmarklet card exists");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    check("cluster still lists Muse.ai, Grok Bot, Claude Code in order",
      personalCards(doc).map(c => c.querySelector(".card-title")?.textContent).join(",") === "Muse.ai,Grok Bot,Claude Code",
      JSON.stringify(personalCards(doc).map(c => c.dataset.id)));
    check("cluster links are the expected URLs",
      personalCards(doc).map(c => c.querySelector(".card-main")?.href).join(",") === EXPECTED_URLS.join(","),
      JSON.stringify(personalCards(doc).map(c => c.querySelector(".card-main")?.href)));
    const card = newBookmarkletCard(doc);
    check("bookmarklet card is in the Bookmarklets cluster", Boolean(card));
    check("bookmarklet appears once in the cluster", bookmarkletCards(doc).filter(c => c.dataset.id === BOOKMARKLET_ID).length === 1);
    check("card is rendered as a runnable bookmarklet",
      card?.classList.contains("bookmarklet") && /Bookmarklet/.test(card?.textContent || ""));
    check("bookmarklets count badge includes it", doc.getElementById("cnt-bookmarklets").textContent === "5",
      doc.getElementById("cnt-bookmarklets").textContent);
    check("personal agents count badge is still 3", doc.getElementById("cnt-personalagents").textContent === "3",
      doc.getElementById("cnt-personalagents").textContent);
    check("no page errors", win.__errors.length === 0, win.__errors.join("; "));
    win.close();
  }

  console.log("\n[2] the bookmarklet opens exactly the cluster's links, in order, each in a new tab");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    const href = newBookmarkletCard(doc).querySelector(".card-main").href;
    check("card link is a javascript: bookmarklet", href.startsWith("javascript:"), href.slice(0, 60));
    check("bookmarklet lists exactly the cluster URLs in order",
      urlsIn(href).join(",") === personalCards(doc).map(c => c.querySelector(".card-main")?.href).join(","),
      JSON.stringify(urlsIn(href)));
    check("no link is duplicated", new Set(urlsIn(href)).size === urlsIn(href).length, JSON.stringify(urlsIn(href)));
    // Run the bookmarklet the way a browser runs a clicked (or bookmarks-bar) javascript: link.
    win.eval(href.slice("javascript:".length));
    check("running it opens one tab per personal agent",
      win.__opens.map(o => o.url).join(",") === EXPECTED_URLS.join(","), JSON.stringify(win.__opens));
    check("every tab opens in a new tab (_blank)", win.__opens.every(o => o.target === "_blank"), JSON.stringify(win.__opens));
    win.close();
  }

  console.log("\n[3] the bookmarklet is also pinned in Favorites, after the Scratchpad");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    const ids = [...doc.querySelectorAll('[data-home-key="favorites"] .card')].map(c => c.dataset.id);
    check("scratchpad still leads Favorites", ids[0] === "workingon:scratchpad-quick-notes", JSON.stringify(ids.slice(0, 3)));
    check("new bookmarklet is pinned in Favorites exactly once",
      ids.filter(id => id === BOOKMARKLET_ID).length === 1, JSON.stringify(ids));
    check("favorites copy carries the same bookmarklet link",
      urlsIn(doc.querySelector(`[data-home-key="favorites"] .card[data-id="${BOOKMARKLET_ID}"] .card-main`).href).join(",") === EXPECTED_URLS.join(","));
    win.close();
  }

  console.log("\n[4] search finds the bookmarklet by its aliases");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    doc.querySelector('[data-section="bookmarklets"]').click();
    await flush();
    const search = doc.getElementById("global-search");
    search.value = "open all personal agents";
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
    await flush();
    check("bookmarklet survives an alias search", !newBookmarkletCard(doc).classList.contains("is-filtered"));
    check("other bookmarklets are filtered out",
      bookmarkletCards(doc).filter(c => c.dataset.id !== BOOKMARKLET_ID).every(c => c.classList.contains("is-filtered")));
    check("no page errors", win.__errors.length === 0, win.__errors.join("; "));
    win.close();
  }

  console.log(failures ? `\n${failures} FAILING` : "\nALL PASSING");
  process.exit(failures ? 1 : 0);
})();
