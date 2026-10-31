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

// ---- tables -----------------------------------------------------------------------------------------
// GitHub-flavoured pipe tables: a header row, a `| --- | :-: |` separator that
// also carries the alignment, then any number of body rows. Cells are escaped
// first and decorated second, exactly like every other inline text, so a table
// can never smuggle HTML in. `\|` keeps a literal pipe inside a cell.
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;

export function isTableSeparator(line) {
  return TABLE_SEPARATOR.test(String(line || ""));
}

// `| a | b \| c |` → ["a", "b | c"]
export function splitTableRow(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (char === "|") { cells.push(current.trim()); current = ""; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function tableAlignments(separatorLine) {
  return splitTableRow(separatorLine).map(cell => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

// The one table renderer both surfaces (and the worker) share.
export function renderTable(headerLine, separatorLine, bodyLines = [], renderCell = renderInline) {
  const header = splitTableRow(headerLine);
  const widths = tableAlignments(separatorLine);
  const columns = Math.max(header.length, widths.length);
  const cell = (tag, text, index) => {
    const align = widths[index];
    const style = align ? ` style="text-align:${align}"` : "";
    return `<${tag}${style}>${renderCell(text)}</${tag}>`;
  };
  const head = `<thead><tr>${Array.from({ length: columns }, (_, index) => cell("th", header[index] || "", index)).join("")}</tr></thead>`;
  const body = bodyLines.length
    ? `<tbody>${bodyLines.map(row => {
        const cells = splitTableRow(row);
        const width = Math.max(columns, cells.length);
        return `<tr>${Array.from({ length: width }, (_, index) => cell("td", cells[index] || "", index)).join("")}</tr>`;
      }).join("")}</tbody>`
    : "";
  return `<div class="md-table"><table>${head}${body}</table></div>`;
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
        codeBuffer.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuffer.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    // A header row followed by a separator row is a table; keep eating rows while they stay piped.
    if (/\|/.test(line) && isTableSeparator(lines[index + 1] || "")) {
      closeList();
      const body = [];
      let lookahead = index + 2;
      while (lookahead < lines.length && lines[lookahead].trim() && /\|/.test(lines[lookahead]) && !/^\s*```/.test(lines[lookahead])) {
        body.push(lines[lookahead]);
        lookahead += 1;
      }
      html += renderTable(line, lines[index + 1], body);
      index = lookahead - 1;
      continue;
    }
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) { closeList(); html += "<hr>"; continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 6);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { closeList(); html += `<blockquote>${renderInline(quote[1])}</blockquote>`; continue; }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (task) {
      openList("ul");
      html += `<li class="md-task"><input type="checkbox" data-md-line="${index}" aria-label="Toggle task"${task[1].toLowerCase() === "x" ? " checked" : ""} /><span>${renderInline(task[2]) || "&nbsp;"}</span></li>`;
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { openList("ul"); html += `<li>${renderInline(bullet[1])}</li>`; continue; }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) { openList("ol"); html += `<li>${renderInline(numbered[1])}</li>`; continue; }
    closeList();
    html += `<p>${renderInline(line)}</p>`;
  }
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
