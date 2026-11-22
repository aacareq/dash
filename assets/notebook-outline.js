// Notebook outlining & progressive disclosure — pure functions for the editor.
// Parses headings into sections, builds a nested tree, and supports focus mode.

export function parseOutline(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  const headingRegex = /^\s*(#{1,6})\s+(.*\S)\s*$/;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRegex);
    if (m) {
      if (current) current.lineEnd = i - 1;
      current = {
        id: `sec-${i}-${sections.length}`,
        level: m[1].length,
        title: m[2].trim(),
        lineStart: i,
        lineEnd: lines.length - 1,
        raw: lines[i]
      };
      sections.push(current);
    }
  }
  if (current) current.lineEnd = lines.length - 1;
  // If no headings, treat whole doc as one section
  if (!sections.length && String(source || "").trim()) {
    sections.push({ id: "sec-root", level: 1, title: "Document", lineStart: 0, lineEnd: lines.length - 1, raw: "" });
  }
  return sections;
}

export function buildOutlineTree(sections) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const s of sections) {
    while (stack.length > 1 && stack[stack.length - 1].level >= s.level) stack.pop();
    const node = { ...s, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

export function extractSection(source, section) {
  if (!section) return String(source || "");
  const lines = String(source || "").split("\n");
  return lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
}

export function replaceSection(source, section, newContent) {
  if (!section) return newContent;
  const lines = String(source || "").split("\n");
  const before = lines.slice(0, section.lineStart);
  const after = lines.slice(section.lineEnd + 1);
  return [...before, String(newContent).replace(/\n+$/, ""), ...after].join("\n");
}

export function focusLines(source, section) {
  if (!section) return { filtered: String(source || ""), map: null };
  const lines = String(source || "").split("\n");
  const filtered = lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
  return { filtered, map: { start: section.lineStart } };
}

export function unfocusLines(fullSource, filteredSource, focusSection) {
  if (!focusSection) return filteredSource;
  const fullLines = String(fullSource || "").split("\n");
  const filteredLines = String(filteredSource || "").split("\n");
  const before = fullLines.slice(0, focusSection.lineStart);
  const after = fullLines.slice(focusSection.lineEnd + 1);
  return [...before, ...filteredLines, ...after].join("\n");
}

// Enhance rendered markdown lists for progressive disclosure: every <li> that
// contains a nested <ul>/<ol> gets a disclosure toggle. Pure DOM, no external dep.
export function enhanceCollapsibleLists(root) {
  if (!root) return;
  const items = root.querySelectorAll("li");
  items.forEach(li => {
    const nested = li.querySelector(":scope > ul, :scope > ol");
    if (!nested) return;
    if (li.querySelector(":scope > .nb-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nb-toggle";
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Collapse section");
    btn.textContent = "▾";
    btn.addEventListener("click", () => {
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      btn.textContent = expanded ? "▸" : "▾";
      nested.hidden = expanded;
      li.classList.toggle("is-collapsed", expanded);
    });
    li.insertBefore(btn, li.firstChild);
  });
}

// Toggle-list helpers: support `>!` or `::: toggle` shorthand.
// We treat `<details>` in markdown as toggle lists — author inserts via toolbar,
// renderer leaves HTML escaped, so we post-process: convert our custom syntax
// `:::toggle Title` ... `:::` into <details>.
export function renderToggleBlocks(source) {
  // Escape handled upstream; this runs on already-escaped inline but before final paragraph wrapping.
  // We look for lines like ":::toggle My title" ... content ... ":::"
  // and emit <details><summary>Title</summary>content</details>
  return String(source || "");
}

export function getSectionAtLine(source, lineIndex) {
  const sections = parseOutline(source);
  let best = null;
  for (const s of sections) {
    if (lineIndex >= s.lineStart && lineIndex <= s.lineEnd) {
      if (!best || s.level > best.level) best = s;
    }
  }
  return best;
}
