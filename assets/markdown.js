// Markdown rendering and note filename helpers for the Scratchpad PWA.
//
// Pure functions only — no DOM, no storage — so the same code runs in the page,
// inside the Web Worker (assets/markdown-worker.js) and under Node for tests.
//
// Security invariant (kept identical to the original dashboard dialog):
// escape FIRST, then decorate. A pasted <script> or onerror=... stays text.

export function encodeUtf8Base64(text) {
  return btoa(unescape(encodeURIComponent(String(text))));
}

export function decodeUtf8Base64(base64) {
  return decodeURIComponent(escape(atob(String(base64 || "").replace(/\n/g, ""))));
}

// notes-2026-10-27-1542.md — in the visitor's own timezone.
export function datedFileName(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `notes-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.md`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
}

// Faithful port of the dashboard's renderScratchpadMarkdown(): same grammar,
// same output, including the data-md-line hooks that make preview checkboxes
// tick the underlying `- [ ]` source line.
export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let listTag = null;
  let inCode = false;
  const codeBuffer = [];
  const closeList = () => { if (listTag) { html += `</${listTag}>`; listTag = null; } };
  const openList = tag => { if (listTag !== tag) { closeList(); html += `<${tag}>`; listTag = tag; } };

  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
        codeBuffer.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      return;
    }
    if (inCode) { codeBuffer.push(line); return; }
    if (!line.trim()) { closeList(); return; }
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) { closeList(); html += "<hr>"; return; }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      return;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { closeList(); html += `<blockquote>${renderInline(quote[1])}</blockquote>`; return; }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (task) {
      openList("ul");
      html += `<li class="md-task"><input type="checkbox" data-md-line="${index}" aria-label="Toggle task"${task[1].toLowerCase() === "x" ? " checked" : ""} /><span>${renderInline(task[2]) || "&nbsp;"}</span></li>`;
      return;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { openList("ul"); html += `<li>${renderInline(bullet[1])}</li>`; return; }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) { openList("ol"); html += `<li>${renderInline(numbered[1])}</li>`; return; }
    closeList();
    html += `<p>${renderInline(line)}</p>`;
  });
  if (inCode && codeBuffer.length) html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
  closeList();
  return html;
}

// Ticks the task checkbox on line `lineIndex`, mirroring the dashboard dialog's
// preview change handler so the worker-rendered preview stays editable.
export function toggleTaskLine(source, lineIndex, checked) {
  const lines = String(source || "").split("\n");
  if (!lines[lineIndex] || !/^\s*[-*+]\s+\[[ xX]]/.test(lines[lineIndex])) return String(source || "");
  lines[lineIndex] = lines[lineIndex].replace(
    /^(\s*[-*+]\s+)\[[ xX]]/,
    (_, lead) => `${lead}[${checked ? "x" : " "}]`
  );
  return lines.join("\n");
}
