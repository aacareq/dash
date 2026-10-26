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
//
// They also cover the ensured favorites (Gemini, Claude): fresh visitors get
// them from `defaultFavorites`, and a browser whose saved list lacks them has
// them added exactly once — never duplicated, never reordering what is already
// saved, and never re-added after a deliberate un-star.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const nodeCrypto = require("crypto");
const path = require("path");

const { webcrypto } = nodeCrypto;
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";
const SCRATCHPAD_ID = "workingon:scratchpad-quick-notes";
const GEMINI_ID = "inference:gemini";
const CLAUDE_ID = "inference:claude";
const ENSURED_KEY = "commandos-favorites-ensured-v1";

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
    check("fresh favorites include Gemini and Claude once each",
      ids.filter(id => id === GEMINI_ID).length === 1 && ids.filter(id => id === CLAUDE_ID).length === 1, JSON.stringify(ids));
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
    check("saved favorite still present after the pins", ids.includes("daily:gmail"), JSON.stringify(ids));
    // 1 scratchpad + 4 bookmarklets + Gmail + the ensured Gemini/Claude topped up into the saved list.
    check("count badge matches pinned + saved + ensured", doc.getElementById("cnt-favorites").textContent === "8",
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

  console.log("\n[7] a saved list without Claude/Gemini gets them added (once, persisted, as starred favorites)");
  {
    const win = makeWindow({ storage: { "commandos-favorites-v1": ["daily:gmail"] } });
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("Gemini added to Favorites", ids.includes(GEMINI_ID), JSON.stringify(ids));
    check("Claude added to Favorites", ids.includes(CLAUDE_ID), JSON.stringify(ids));
    check("neither is duplicated", ids.filter(id => id === GEMINI_ID).length === 1 && ids.filter(id => id === CLAUDE_ID).length === 1);
    check("they open the real services",
      favoriteCards(doc).find(c => c.dataset.id === GEMINI_ID)?.querySelector(".card-main")?.href.includes("gemini.google.com") &&
      favoriteCards(doc).find(c => c.dataset.id === CLAUDE_ID)?.querySelector(".card-main")?.href.includes("claude.ai"));
    check("they show as starred/saved, not pinned",
      [GEMINI_ID, CLAUDE_ID].every(id => favoriteCards(doc).find(c => c.dataset.id === id)
        ?.querySelector("[data-favorite]")?.textContent.includes("Saved")));
    const saved = JSON.parse(win.localStorage.getItem("commandos-favorites-v1"));
    check("addition is persisted to the saved list", saved.includes(GEMINI_ID) && saved.includes(CLAUDE_ID), JSON.stringify(saved));
    check("existing saved order is kept (ensured appended)", saved[0] === "daily:gmail" && saved.indexOf(GEMINI_ID) < saved.indexOf(CLAUDE_ID), JSON.stringify(saved));
    check("one-time ensured pass is recorded", JSON.parse(win.localStorage.getItem(ENSURED_KEY) || "[]").join(",") === `${GEMINI_ID},${CLAUDE_ID}`,
      win.localStorage.getItem(ENSURED_KEY));
    check("no page errors", win.__errors.length === 0, win.__errors.join("; "));
    win.close();
  }

  console.log("\n[8] only the missing one is added; an already-present one keeps its place");
  {
    // Claude already saved first, Gemini missing: only Gemini should be appended.
    const win = makeWindow({ storage: { "commandos-favorites-v1": [CLAUDE_ID, "daily:gmail"] } });
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("both end up in Favorites exactly once",
      ids.filter(id => id === CLAUDE_ID).length === 1 && ids.filter(id => id === GEMINI_ID).length === 1, JSON.stringify(ids));
    // Pinned: scratchpad + 4 bookmarklets, so the first saved card is at index 5.
    check("already-saved Claude keeps its position", ids[5] === CLAUDE_ID, JSON.stringify(ids));
    const saved = JSON.parse(win.localStorage.getItem("commandos-favorites-v1"));
    check("saved order preserved with Gemini appended", saved.join(",") === `${CLAUDE_ID},daily:gmail,${GEMINI_ID}`, JSON.stringify(saved));
    win.close();
  }

  console.log("\n[9] already-present Claude/Gemini are not duplicated or reordered");
  {
    const win = makeWindow({ storage: { "commandos-favorites-v1": [CLAUDE_ID, GEMINI_ID] } });
    const doc = win.document;
    await flush();
    const ids = favoriteIds(doc);
    check("each appears once", ids.filter(id => id === CLAUDE_ID).length === 1 && ids.filter(id => id === GEMINI_ID).length === 1, JSON.stringify(ids));
    check("the user's order is preserved", ids.indexOf(CLAUDE_ID) < ids.indexOf(GEMINI_ID), JSON.stringify(ids));
    win.close();
  }

  console.log("\n[10] the ensure pass runs once: deliberately un-starring Claude sticks across a reload");
  {
    const win = makeWindow({ storage: { "commandos-favorites-v1": ["daily:gmail"] } });
    await flush();
    const claudeCard = favoriteCards(win.document).find(c => c.dataset.id === CLAUDE_ID);
    check("Claude present after the ensure pass", Boolean(claudeCard));
    claudeCard.querySelector("[data-favorite]").click();
    await flush();
    const savedAfterUnstar = win.localStorage.getItem("commandos-favorites-v1");
    const ensuredRecord = win.localStorage.getItem(ENSURED_KEY);
    check("un-star removes Claude from the saved list", !JSON.parse(savedAfterUnstar).includes(CLAUDE_ID), savedAfterUnstar);
    win.close();

    // Reload with exactly what the first session persisted.
    const win2 = makeWindow({ storage: { "commandos-favorites-v1": savedAfterUnstar, [ENSURED_KEY]: ensuredRecord } });
    await flush();
    const ids2 = favoriteIds(win2.document);
    check("Claude is not re-added on reload", !ids2.includes(CLAUDE_ID), JSON.stringify(ids2));
    check("Gemini is still a favorite after reload", ids2.includes(GEMINI_ID), JSON.stringify(ids2));
    win2.close();
  }

  console.log(failures ? `\n${failures} FAILING` : "\nALL PASSING");
  process.exit(failures ? 1 : 0);
})();
