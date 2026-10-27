// Editor controller: markdown toolbar, selection-safe edits, emoji picker and the
// live preview. Ported from the dashboard dialog's initScratchpadMarkdown /
// initScratchpadEmoji, with rendering moved behind a Web Worker when one is
// available (falls back to calling renderMarkdown directly).

import { renderMarkdown, toggleTaskLine } from "./markdown.js";
import { EMOJI_GROUPS, filterEmoji } from "./emoji.js";

const LINE_TOOLS = {
  h1: { prefix: "# ", exact: /^\s{0,3}#(?!#)\s+/, strip: /^\s{0,3}#{1,6}\s+/ },
  h2: { prefix: "## ", exact: /^\s{0,3}#{2}(?!#)\s+/, strip: /^\s{0,3}#{1,6}\s+/ },
  h3: { prefix: "### ", exact: /^\s{0,3}#{3}(?!#)\s+/, strip: /^\s{0,3}#{1,6}\s+/ },
  ul: { prefix: "- ", exact: /^\s*[-*+]\s+(?!\[[ xX]\])/, strip: /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/ },
  task: { prefix: "- [ ] ", exact: /^\s*[-*+]\s+\[[ xX]\]\s+/, strip: /^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/ },
  ol: { prefix: "1. ", exact: /^\s*\d+[.)]\s+/, strip: /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/ },
  quote: { prefix: "> ", exact: /^\s*>\s?/, strip: /^\s*>\s?/ }
};

// Renders note markdown off the main thread when the runtime supports Workers;
// sequence numbers ensure a slow older render can never overwrite a newer one.
class PreviewRenderer {
  constructor(previewEl, workerUrl) {
    this.preview = previewEl;
    this.worker = null;
    this.seq = 0;
    this.lastSource = null;
    try {
      if (workerUrl && typeof Worker !== "undefined") this.worker = new Worker(workerUrl, { type: "module" });
      if (this.worker) {
        this.worker.addEventListener("message", event => {
          const { seq, html } = event.data || {};
          if (seq === this.seq) this.preview.innerHTML = html;
        });
      }
    } catch (error) {
      this.worker = null;
    }
  }

  render(source) {
    if (this.preview.hidden || source === this.lastSource) return;
    this.lastSource = source;
    this.seq += 1;
    if (this.worker) {
      this.worker.postMessage({ seq: this.seq, source });
    } else {
      this.preview.innerHTML = renderMarkdown(source);
    }
  }

  get offloaded() { return this.worker !== null; }
}

export function createEmojiPicker({ button, picker, search, list, insertEmoji }) {
  if (!button || !picker || !list || !search) return null;

  function render(query) {
    const matches = filterEmoji(query);
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "emoji-empty";
      empty.textContent = "No emoji match that search.";
      list.appendChild(empty);
      return;
    }
    const needle = String(query || "").trim().toLowerCase();
    const groups = needle ? [{ category: "Results", items: matches.map(item => [item.char, item.keywords]) }] : EMOJI_GROUPS;
    groups.forEach(group => {
      const heading = document.createElement("p");
      heading.className = "emoji-category";
      heading.textContent = group.category;
      const grid = document.createElement("div");
      grid.className = "emoji-grid";
      group.items.forEach(entry => {
        const [char, keywords] = entry;
        const option = document.createElement("button");
        option.type = "button";
        option.className = "emoji-btn";
        option.textContent = char;
        option.title = keywords.split(" ").slice(0, 3).join(", ");
        option.setAttribute("aria-label", `${keywords.split(" ")[0]} emoji`);
        option.addEventListener("mousedown", event => {
          event.preventDefault();
          insertEmoji(char);
          close();
        });
        grid.appendChild(option);
      });
      list.append(heading, grid);
    });
  }

  function open() {
    picker.hidden = false;
    button.setAttribute("aria-expanded", "true");
    search.value = "";
    render("");
    search.focus();
  }
  function close() {
    picker.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
  const isOpen = () => !picker.hidden;

  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", () => (isOpen() ? close() : open()));
  search.addEventListener("input", () => render(search.value));
  search.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); button.focus(); }
    if (event.key === "Enter") {
      const first = list.querySelector(".emoji-btn");
      if (first) { event.preventDefault(); insertEmoji(first.textContent); close(); }
    }
  });
  picker.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  document.addEventListener("click", event => {
    if (!isOpen()) return;
    if (event.target.closest("#scratchpad-emoji-picker, #scratchpad-emoji-btn")) return;
    close();
  });

  return { open, close, isOpen };
}

export function createEditor({ textarea, toolbar, preview, previewToggle, emojiElements, workerUrl, onInput, previewPref }) {
  const applyEdit = (start, end, text, selectStart, selectEnd) => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    let inserted = false;
    try { inserted = document.execCommand && document.execCommand("insertText", false, text); } catch (error) { inserted = false; }
    if (!inserted) {
      textarea.setRangeText(text, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (typeof selectStart === "number") {
      textarea.setSelectionRange(selectStart, typeof selectEnd === "number" ? selectEnd : selectStart);
    }
  };

  function wrapSelection(marker, placeholder) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const outside = textarea.value.slice(Math.max(0, start - marker.length), start);
    const trailing = textarea.value.slice(end, end + marker.length);
    if (outside === marker && trailing === marker) {
      applyEdit(start - marker.length, end + marker.length, selected,
        start - marker.length, start - marker.length + selected.length);
      return;
    }
    if (selected && selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
      const inner = selected.slice(marker.length, -marker.length);
      applyEdit(start, end, inner, start, start + inner.length);
      return;
    }
    const body = selected || placeholder;
    applyEdit(start, end, `${marker}${body}${marker}`, start + marker.length, start + marker.length + body.length);
  }

  function toggleLinePrefix(kind) {
    const tool = LINE_TOOLS[kind];
    if (!tool) return;
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const blockStart = value.lastIndexOf("\n", start - 1) + 1;
    let blockEnd = value.indexOf("\n", end);
    if (blockEnd === -1) blockEnd = value.length;
    const lines = value.slice(blockStart, blockEnd).split("\n");
    const nonEmpty = lines.filter(line => line.trim());
    const already = nonEmpty.length > 0 && nonEmpty.every(line => tool.exact.test(line));

    let counter = 0;
    const next = lines.map(line => {
      if (!line.trim()) return line;
      if (already) return line.replace(tool.exact, "").replace(/^\s+/, "");
      const body = line.replace(tool.strip, "").replace(/^\s+/, "");
      if (kind === "ol") { counter += 1; return `${counter}. ${body}`; }
      return `${tool.prefix}${body}`;
    });

    const replacement = next.join("\n");
    applyEdit(blockStart, blockEnd, replacement, blockStart, blockStart + replacement.length);
  }

  function insertDivider() {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const lead = before && !before.endsWith("\n") ? "\n\n" : "";
    const tail = after.startsWith("\n") ? "" : "\n";
    const text = `${lead}---${tail}`;
    applyEdit(start, end, text, start + text.length, start + text.length);
  }

  const insertEmoji = char => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    applyEdit(start, end, char, start + char.length, start + char.length);
  };

  function runTool(tool) {
    if (tool === "bold") wrapSelection("**", "bold text");
    else if (tool === "italic") wrapSelection("*", "italic text");
    else if (tool === "strike") wrapSelection("~~", "strikethrough");
    else if (tool === "hr") insertDivider();
    else if (LINE_TOOLS[tool]) toggleLinePrefix(tool);
  }

  const renderer = new PreviewRenderer(preview, workerUrl);
  const setPreviewVisible = visible => {
    if (!preview || !previewToggle) return;
    preview.hidden = !visible;
    previewToggle.setAttribute("aria-pressed", String(visible));
    if (visible) { renderer.lastSource = null; renderer.render(textarea.value); }
    previewPref?.set(visible);
  };

  let previewTimer;
  textarea.addEventListener("input", () => {
    if (!preview.hidden) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => renderer.render(textarea.value), 180);
    }
    onInput?.();
  });
  previewToggle?.addEventListener("click", () => setPreviewVisible(preview.hidden));

  // Ticking a preview checkbox rewrites the matching source line, then re-renders.
  preview?.addEventListener("change", event => {
    const box = event.target.closest('input[type="checkbox"][data-md-line]');
    if (!box) return;
    const lineIndex = Number(box.dataset.mdLine);
    const next = toggleTaskLine(textarea.value, lineIndex, box.checked);
    if (next !== textarea.value) {
      textarea.value = next;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    renderer.lastSource = null;
    renderer.render(textarea.value);
  });

  toolbar.querySelectorAll("[data-md]").forEach(button => {
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => runTool(button.dataset.md));
  });
  textarea.addEventListener("keydown", event => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    const shortcuts = { b: "bold", i: "italic", x: event.shiftKey ? "strike" : "", e: "ul" };
    const tool = shortcuts[key];
    if (!tool) return;
    event.preventDefault();
    runTool(tool);
  });

  const emoji = createEmojiPicker({ ...emojiElements, insertEmoji });

  // The preference may come from synchronous localStorage or async IndexedDB.
  Promise.resolve(previewPref?.get()).then(want => { if (want === true) setPreviewVisible(true); });

  return {
    insertEmoji,
    emoji,
    renderPreview: () => { renderer.lastSource = null; renderer.render(textarea.value); },
    setPreviewVisible,
    previewOffloaded: () => renderer.offloaded
  };
}
