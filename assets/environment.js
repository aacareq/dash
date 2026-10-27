// Tiny pure environment helpers — no globals read here, so the rules are
// testable in Node and identical across the dashboard and the PWA.

// Embedded = loaded with ?embed=1, or actually running inside an iframe.
// The param wins so the behavior is deterministic even when frame access throws.
export function isEmbedded({ search = "", framed = false } = {}) {
  if (new URLSearchParams(search).get("embed") === "1") return true;
  return Boolean(framed);
}

export function isIos(userAgent = "") {
  return /iphone|ipad|ipod/i.test(String(userAgent));
}

export function isStandaloneDisplay(matches = false) {
  return Boolean(matches);
}
