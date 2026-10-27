// Shared PWA plumbing for both the dashboard (index.html) and the standalone
// Scratchpad (scratchpad.html): service-worker registration with an update
// toast, the beforeinstallprompt install button, and an iOS hint.
//
// All element ids are passed in so neither page hard-depends on the other's
// markup. Safe to load as a module anywhere — if an element is missing it is
// simply skipped, and browsers without SW support get the plain page.

import { isIos, isStandaloneDisplay } from "./environment.js";

export async function setupPwaInstall({
  installButtonId = "install-app",
  iosHintId = "ios-hint",
  toastId = "sw-update-toast",
  reloadButtonId = "sw-reload",
  serviceWorkerUrl = "../sw.js",
  embedded = false
} = {}) {
  const installButton = document.getElementById(installButtonId);
  const iosHint = document.getElementById(iosHintId);
  let deferredPrompt = null;

  // Install prompt (Chromium). Hidden inside the embedded view — installation
  // is an outer-page decision, so the dashboard owns that button.
  if (installButton && !embedded) {
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      deferredPrompt = event;
      installButton.classList.remove("hidden");
    });
    installButton.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      installButton.classList.add("hidden");
    });
    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      installButton.classList.add("hidden");
    });
  }

  // Safari never fires beforeinstallprompt — point iOS users at Share → Add
  // to Home Screen, unless the page is already running installed.
  const standalone =
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    window.navigator.standalone === true;
  if (iosHint && !embedded && isIos(navigator.userAgent) &&
      !isStandaloneDisplay(standalone)) {
    iosHint.classList.remove("hidden");
  }

  if (!("serviceWorker" in navigator) || !location.protocol.startsWith("http")) return;
  try {
    const registration = await navigator.serviceWorker.register(
      new URL(serviceWorkerUrl, import.meta.url),
      { updateViaCache: "none" }
    );

    const toast = document.getElementById(toastId);
    const reloadButton = document.getElementById(reloadButtonId);
    const promptUpdate = worker => {
      if (!toast || !reloadButton) return;
      toast.classList.remove("hidden");
      reloadButton.addEventListener("click", () => worker.postMessage({ type: "SKIP_WAITING" }), { once: true });
    };
    if (registration.waiting) promptUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", event => {
        if (event.target.state === "installed" && navigator.serviceWorker.controller) {
          promptUpdate(event.target);
        }
      });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
  } catch (error) {
    console.warn("Service worker registration failed:", error);
  }
}
