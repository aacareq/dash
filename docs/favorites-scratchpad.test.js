// Behaviour tests for the Scratchpad pinned at the front of Favorites.
//
//   npm install jsdom
//   node docs/favorites-scratchpad.test.js
//
// The Scratchpad lives in the "Working On" cluster, but it is also pinned as the
// very first Favorites card (ahead of the pinned bookmarklets and the saved
// list) on both the home view and the ★ Favorites menu view. These tests lock
// in that placement, that the pinned copy is the same tool (one dialog, one
// id), and that starring/un-starring it can never move, duplicate or drop it.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const { webcrypto } = nodeCrypto;
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";
const SCRATCHPAD_ID = "workingon:scratchpad-quick-notes";

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
  return dom.window;
}

const favoriteCards = doc => [...doc.querySelectorAll('[data-home-key="favorites"] .card')];
const favoriteTitles = doc => favoriteCards(doc).map(card => card.querySelector(".card-title")?.textContent);
const favoriteIds = doc => favoriteCards(doc).map(card => card.dataset.id);

(async () => {
  console.log("\n[1] fresh visitor: Scratchpad is the first Favorites card on the home view");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("first favorite is the Scratchpad", ids[0] === SCRATCHPAD_ID, JSON.stringify(ids.slice(0, 3)));
    check("scratchpad title leads the grid", favoriteTitles(doc)[0] === "Scratchpad / Quick Notes");
    check("pinned bookmarklets follow the Scratchpad", ids[1] === "bookmarklets:github-arena-agent", ids[1]);
    check("scratchpad appears once in Favorites", ids.filter(id => id === SCRATCHPAD_ID).length === 1);
    const first = favoriteCards(doc)[0];
    check("pinned card is marked as an in-page tool", first.classList.contains("modal-trigger") && /Opens here/.test(first.textContent));
    check("favorites count includes the Scratchpad", Number(doc.getElementById("cnt-favorites").textContent) === ids.length,
      `${doc.getElementById("cnt-favorites").textContent} vs ${ids.length}`);
    check("no page errors", win.__errors.length === 0, win.__errors.join("; "));
    win.close();
  }

  console.log("\n[2] clicking the pinned Favorites card opens the same scratchpad dialog as Working On");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    const dialog = doc.getElementById("modal-scratchpad");
    check("dialog starts closed", !dialog.open);
    favoriteCards(doc)[0].querySelector(".card-main").click();
    await flush();
    check("card click opens modal-scratchpad", dialog.open === true);
    dialog.close();
    // The secondary "Open" action on the pinned copy opens it too.
    const openButton = [...favoriteCards(doc)[0].querySelectorAll(".card-action")].find(btn => btn.textContent === "Open");
    check("pinned card has an Open action", Boolean(openButton));
    openButton.click();
    await flush();
    check("Open action opens modal-scratchpad", dialog.open === true);
    // And the original Working On card targets that same dialog (no second scratchpad).
    check("exactly one scratchpad dialog exists", doc.querySelectorAll("#modal-scratchpad").length === 1);
    const workingOnCard = doc.querySelector(`#group-workingon .card[data-id="${SCRATCHPAD_ID}"]`);
    check("scratchpad still listed in Working On", Boolean(workingOnCard));
    win.close();
  }

  console.log("\n[3] the ★ Favorites menu view also leads with the Scratchpad");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    doc.querySelector('[data-section="favorites"]').click();
    await flush();
    check("first favorite in menu view is the Scratchpad", favoriteIds(doc)[0] === SCRATCHPAD_ID, JSON.stringify(favoriteIds(doc).slice(0, 3)));
    check("no page errors in menu view", win.__errors.length === 0, win.__errors.join("; "));
    win.close();
  }

  console.log("\n[4] existing saved favorites (no Scratchpad starred) still get it pinned first");
  {
    const win = makeWindow({ storage: { "commandos-favorites-v1": ["daily:gmail"] } });
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("scratchpad pinned first despite saved list", ids[0] === SCRATCHPAD_ID, JSON.stringify(ids));
    check("saved favorite still present after the pins", ids[ids.length - 1] === "daily:gmail", JSON.stringify(ids));
    // 1 scratchpad + 4 bookmarklets + 1 saved.
    check("count badge matches pinned + saved", doc.getElementById("cnt-favorites").textContent === "6",
      doc.getElementById("cnt-favorites").textContent);
    win.close();
  }

  console.log("\n[5] a starred Scratchpad stays first and is never duplicated");
  {
    // Scratchpad saved last on purpose: pinning must pull it to the front.
    const win = makeWindow({ storage: { "commandos-favorites-v1": ["daily:github", SCRATCHPAD_ID] } });
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("starred scratchpad is still first", ids[0] === SCRATCHPAD_ID, JSON.stringify(ids));
    check("starred scratchpad is not duplicated", ids.filter(id => id === SCRATCHPAD_ID).length === 1);
    const favButton = favoriteCards(doc)[0].querySelector("[data-favorite]");
    check("pinned card shows as saved when starred", favButton.textContent.includes("Saved"), favButton.textContent);

    // Un-starring a pinned card clears the saved flag but cannot remove the pin.
    favButton.click();
    await flush();
    const afterIds = favoriteIds(win.document);
    check("un-starred scratchpad stays pinned first", afterIds[0] === SCRATCHPAD_ID, JSON.stringify(afterIds));
    check("saved list no longer contains the scratchpad",
      !JSON.parse(win.localStorage.getItem("commandos-favorites-v1")).includes(SCRATCHPAD_ID));
    win.close();
  }

  console.log("\n[6] search finds the pinned Scratchpad in Favorites");
  {
    const win = makeWindow();
    const doc = win.document;
    await flush();
    doc.querySelector('[data-section="favorites"]').click();
    await flush();
    const search = doc.getElementById("global-search");
    search.value = "scratchpad";
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
    await flush();
    const first = favoriteCards(doc)[0];
    check("scratchpad card survives a scratchpad search", first.dataset.id === SCRATCHPAD_ID && !first.classList.contains("is-filtered"));
    check("non-matching favorites are filtered out", favoriteCards(doc).slice(1).every(card => card.classList.contains("is-filtered")));
    win.close();
  }

  console.log(failures ? `\n${failures} FAILING` : "\nALL PASSING");
  process.exit(failures ? 1 : 0);
})();
