// jsdom behavior tests for the Scratchpad dashboard card's "App ↗" action.
//
// Option A: a real new-tab anchor alongside the favorite star and Open button.
// The card's default click behavior (open modal-scratchpad in-page) and its
// Open button must remain unchanged; only the Scratchpad card gets the anchor.
//
//   node --test tests/dashboard-scratchpad-card.test.mjs
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { webcrypto } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const SITE = "https://aacareq.github.io/dash/index.html";
const flush = () => new Promise(resolve => setTimeout(resolve, 80));

function makeWindow() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", error => errors.push(String(error?.message ?? error)));

  const dom = new JSDOM(html, {
    url: SITE,
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(window) {
      // No pretendToBeVisual: its perpetual rAF loop would keep the test process alive.
      // The dashboard's particle canvas self-reschedules rAF forever; unref'd timers
      // still fire for any one-shot use but don't pin Node's event loop.
      window.requestAnimationFrame = callback => {
        const id = setTimeout(() => callback(Date.now()), 0);
        id.unref?.();
        return id;
      };
      window.cancelAnimationFrame = id => clearTimeout(id);
      Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.confirm = () => true;
      window.Element.prototype.scrollIntoView = function scrollIntoView() {};
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
        window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
      }
      // jsdom has no canvas implementation; the dashboard draws an icon at boot.
      window.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, ellipse() {}, rect() {}, fill() {}, save() {}, restore() {},
        translate() {}, rotate() {}, scale() {}, setTransform() {}, clip() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, stroke() {}, closePath() {}, createRadialGradient: () => ({ addColorStop() {} }),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {}, set shadowColor(v) {}
      });
      window.document.execCommand = () => false;
      window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
      // The dashboard runs interval timers; keep them from pinning the test process open.
      const unrefTimer = fn => (...args) => { const id = fn(...args); id.unref?.(); return id; };
      window.setInterval = unrefTimer(window.setInterval.bind(window));
      window.setTimeout = unrefTimer(window.setTimeout.bind(window));
    }
  });
  return { dom, window: dom.window, errors };
}

test("Scratchpad card renders a new-tab App anchor without changing the default dialog flow", async () => {
  const { window, errors } = makeWindow();
  await flush();

  const card = window.document.querySelector('.card[data-id="workingon:scratchpad-quick-notes"]');
  assert.ok(card, "Scratchpad card rendered");

  const appLink = card.querySelector("a.card-action-link");
  assert.ok(appLink, "App ↗ anchor exists on the Scratchpad card");
  assert.equal(appLink.getAttribute("href"), "scratchpad.html");
  assert.equal(appLink.target, "_blank");
  assert.match(appLink.rel, /noopener/);
  assert.equal(appLink.textContent, "App ↗");

  // It lives next to, not inside, the card's main click target.
  assert.ok(!appLink.closest(".card-main"), "anchor must not hijack the card click");
  const actions = card.querySelector(".card-actions");
  assert.ok(actions.contains(appLink));

  // Default behavior preserved: card click opens the in-page dialog.
  const modal = window.document.getElementById("modal-scratchpad");
  assert.equal(modal.open, false);
  card.querySelector(".card-main").dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(modal.open, true, "card click still opens modal-scratchpad");

  // Open button does the same.
  modal.close();
  const openButton = [...card.querySelectorAll("button.card-action")]
    .find(button => button.textContent === "Open");
  assert.ok(openButton);
  openButton.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(modal.open, true, "Open button still opens modal-scratchpad");

  // Exactly one Scratchpad dialog exists in the page.
  assert.equal(window.document.querySelectorAll("#modal-scratchpad").length, 1);
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);

  window.close();
});

test("the App anchor is Scratchpad-only: other modal cards do not get one", async () => {
  const { window, errors } = makeWindow();
  await flush();

  const others = [...window.document.querySelectorAll(".card.modal-trigger")]
    .filter(card => card.dataset.id !== "workingon:scratchpad-quick-notes");
  assert.ok(others.length > 0, "sanity: other dialog cards exist");
  for (const card of others) {
    assert.equal(card.querySelector("a.card-action-link"), null,
      `${card.dataset.id} must not carry the Scratchpad App anchor`);
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);

  window.close();
});
