// Dashboard-side PWA integration (loaded as an ES module from index.html; the
// dashboard's classic inline script is untouched, so its jsdom behavior tests
// stay green — jsdom does not execute module scripts).
//
// Responsibilities:
//   1. register the shared service worker and expose the install button
//   2. switch the Scratchpad dialog between the inline notes pad and the
//      full Scratchpad PWA embedded in a lazy-loaded same-origin iframe

import { setupPwaInstall } from "./pwa-install.js";

const PWA_EMBED_URL = "scratchpad.html?embed=1";

function initScratchpadEmbed() {
  const dialog = document.getElementById("modal-scratchpad");
  const inlineView = document.getElementById("scratchpad-inline-view");
  const embedView = document.getElementById("scratchpad-embed-view");
  const frame = document.getElementById("scratchpad-app-frame");
  const inlineBtn = document.getElementById("btn-scratchpad-view-inline");
  const appBtn = document.getElementById("btn-scratchpad-view-app");
  if (!dialog || !inlineView || !embedView || !frame || !inlineBtn || !appBtn) return;

  const show = mode => {
    const embedded = mode === "app";
    inlineView.hidden = embedded;
    embedView.hidden = !embedded;
    inlineBtn.classList.toggle("is-active", !embedded);
    appBtn.classList.toggle("is-active", embedded);
    inlineBtn.setAttribute("aria-pressed", String(!embedded));
    appBtn.setAttribute("aria-pressed", String(embedded));
    if (embedded && frame.getAttribute("src") === "about:blank") {
      // Lazy load: the PWA only downloads/boots when the user first asks.
      frame.setAttribute("src", PWA_EMBED_URL);
    }
  };

  inlineBtn.addEventListener("click", () => show("inline"));
  appBtn.addEventListener("click", () => show("app"));

  // Reopen on the familiar inline pad; the iframe keeps its state in IndexedDB
  // regardless, and a hidden iframe stays paused enough not to cost anything.
  dialog.addEventListener("close", () => show("inline"));
}

setupPwaInstall({
  installButtonId: "install-app",
  iosHintId: "ios-hint",
  toastId: "sw-update-toast",
  reloadButtonId: "sw-reload"
});
initScratchpadEmbed();
