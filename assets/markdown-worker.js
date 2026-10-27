// Web Worker: markdown string → sanitized HTML, off the main thread.
// The escape-first security boundary lives in markdown.js and is unchanged here.
import { renderMarkdown } from "./markdown.js";

self.addEventListener("message", event => {
  const { seq, source } = event.data || {};
  self.postMessage({ seq, html: renderMarkdown(source) });
});
