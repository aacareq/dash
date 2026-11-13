// Local-only review copies. Original note files and GitHub sync are never modified.
export const DAY = 86400000;
export function classify(text) {
  if (/^\s*(?:[-*]\s*)?\[[ x]\]|^\s*(?:call|buy|fix|send|email|finish|book|schedule|review)\b/im.test(text)) return 'Task';
  return /https?:\/\/\S+/i.test(text) ? 'Follow-Up' : 'Spark';
}
export function capture(items, body, source, now = Date.now()) {
  const blocks = body.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  blocks.forEach((text, slot) => {
    if (items.some(i => i.source === source && i.original === text)) return;
    // Update an edited paragraph rather than accumulating a snapshot on each pause.
    const previous = items.find(i => i.source === source && i.slot === slot && !i.archived && !i.detached && !blocks.includes(i.original));
    if (previous) {
      Object.assign(previous, { original: text, text, type: classify(text), lastTouchedAt: now, snoozeCount: 0 });
    } else {
      items.push({ id: globalThis.crypto?.randomUUID?.() || `${now}-${Math.random()}`, source, slot, original: text,
        text, type: classify(text), lastTouchedAt: now, snoozeCount: 0, archived: false });
    }
  });
  return items;
}
export function due(item, now = Date.now()) {
  if (item.archived || item.type === 'Spark') return false;
  const threshold = item.snoozeCount ? 7 * DAY : item.type === 'Task' ? 3 * DAY : 7 * DAY;
  return now - item.lastTouchedAt >= threshold;
}
export function expire(items, now = Date.now()) {
  items.forEach(i => { if (!i.archived && i.type === 'Follow-Up' && now - i.lastTouchedAt >= 30 * DAY) i.archived = true; });
  return items;
}
export function act(item, action, now = Date.now(), summary = '') {
  if (action === 'snooze') item.snoozeCount++;
  if (action === 'promote') { item.detached = true; item.type = 'Task'; item.snoozeCount = 0; }
  if (action === 'reference') { item.detached = true; item.type = 'Spark'; item.snoozeCount = 0; }
  if (action === 'compost' || action === 'done') item.archived = true;
  if (action === 'restore') item.archived = false;
  if (action === 'mutate') {
    if (!summary.trim()) return null;
    item.archived = true;
    return { ...item, id: `${item.id}-summary-${now}`, detached: true, original: summary, text: summary.trim(), type: 'Spark', archived: false, lastTouchedAt: now, snoozeCount: 0 };
  }
  item.lastTouchedAt = now;
  return null;
}
export function initReview({ root, textarea, source }) {
  const KEY = 'dash-smart-review-v1';
  let items;
  try { items = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(items) || items.some(i => !i || typeof i.text !== 'string' || typeof i.source !== 'string' || typeof i.lastTouchedAt !== 'number' || !['Task', 'Follow-Up', 'Spark'].includes(i.type))) throw Error(); }
  catch { root.textContent = 'Review storage could not be read. Original notes are safe; review is disabled to avoid overwriting data.'; return; }
  const save = () => { try { const json = JSON.stringify(items); if (localStorage.getItem(KEY) !== json) localStorage.setItem(KEY, json); return true; } catch { root.querySelector('[role=status]').textContent = 'Review changes could not be saved. Export or free device storage. Keep your input until storage is available.'; return false; } };
  const selected = new Set();
  let session = new Set();
  const reviewed = new Set();
  const currentQueue = () => items.filter(i => !i.archived && session.has(i.id) && !reviewed.has(i.id));
  root.innerHTML = `<h2>✨ Smart Review Queue</h2>
    <p><strong>Your notes above → explicitly add copies here → select items → Start Smart Review.</strong></p>
    <p>Notes autosave separately and can sync to GitHub. Review items and their timers are saved only in this browser (<code>dash-smart-review-v1</code>), not in your note file or on GitHub. Adding, editing, or reviewing a copy never changes the original note. Previously captured items are still listed below.</p>
    <details class="review-start"><summary>How this works and where data goes</summary>
      <ol><li>Enter a new item below, or highlight text in the note editor above and click <strong>Add selected note text</strong>. Nothing is copied automatically when you type or open a note.</li>
      <li>Tick the saved review items you want to work on, then click <strong>Start Smart Review</strong>. Select all active or Needs Attention only selects items; you still choose when to start.</li>
      <li><strong>Promote</strong> makes a review item a task; <strong>Snooze</strong> defers it a week; <strong>Mutate</strong> saves your own offline Markdown summary; <strong>Compost</strong> archives the copy. None of these actions edits your notes. Next item skips without changing a timer.</li>
      <li>Tasks are due after 72 hours; links after 7 days and archived after 30 untouched days. Sparks are evergreen. After three snoozes, consider Keep as reference. Archive search, Restore, and Export review JSON apply only to review data.</li></ol>
      <p>Clearing browser storage removes local review data. Export it for a backup; note exports and GitHub saves do not include this queue.</p>
    </details>
    <label for="review-capture">1. Add a new review item (not added to your note)</label>
    <textarea id="review-capture" rows="2" placeholder="Call Alex, https://example.com, or an idea…"></textarea>
    <button type="button" class="modal-btn" id="review-add">Add to review</button>
    <button type="button" class="modal-btn" id="review-from-note">Add selected note text</button>
    <h3>2. Select saved review items</h3>
    <p class="review-count" aria-live="polite"></p>
    <button type="button" class="modal-btn" id="review-all">Select all active</button>
    <button type="button" class="modal-btn" id="review-pill">Needs Attention (0)</button>
    <button type="button" class="modal-btn" id="review-clear-selection">Clear selection</button>
    <div class="review-items" role="group" aria-label="Saved review items"></div>
    <button type="button" class="modal-btn submit" id="review-start" aria-controls="review-panel" aria-expanded="false" disabled>Start Smart Review (0)</button>
    <p class="review-serendipity"></p><div id="review-panel" hidden>
    <p>Local review copies only; original notes stay unchanged. Tasks: 72 hours · Links: 7 days, archived after 30 · Sparks: evergreen. Swipe left to compost, right to snooze, or use buttons.</p>
    <article class="review-card" aria-live="polite"></article>
    <details><summary>Searchable compost archive</summary><input type="search" aria-label="Search archived review items" placeholder="Search archive"><div class="review-archive"></div></details>
    <button type="button" class="modal-btn" id="review-export">Export review JSON</button></div><p role="status" aria-live="polite"></p>`;
  const card = root.querySelector('article');
  const pill = root.querySelector('#review-pill');
  function actionButton(label, handler, parent = card) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'modal-btn'; b.textContent = label; b.onclick = handler; parent.append(b);
  }
  function commit(item, action) {
    let summary = '';
    if (action === 'mutate') {
      summary = window.prompt('Write a clean offline Markdown summary (no page fetch). The original link will be archived.', item.text.replace(/https?:\/\/\S+/g, '').trim());
      if (!summary?.trim()) return;
    }
    const extra = act(item, action, Date.now(), summary);
    reviewed.add(item.id);
    if (item.archived) selected.delete(item.id);
    if (extra) items.push(extra);
    save(); render();
  }
  function render() {
    expire(items);
    for (const id of selected) { if (!items.some(i => i.id === id && !i.archived)) selected.delete(id); }
    save();
    const queue = currentQueue();
    pill.textContent = `Needs Attention (${items.filter(i => due(i)).length})`;
    root.querySelector('.review-count').textContent = `${items.filter(i => !i.archived).length} active · ${items.filter(i => i.archived).length} archived · ${selected.size} selected`;
    renderItems();
    card.replaceChildren();
    const item = queue[0];
    const text = document.createElement('p'); text.textContent = item ? `${item.type} · ${item.source}\n${item.text}` : 'Review complete. Your notes above are unchanged. Select items and click Start Smart Review for another session.'; card.append(text);
    if (item) {
      actionButton('Next item', () => { reviewed.add(item.id); render(); });
      if (item.snoozeCount >= 3) { const hint = document.createElement('p'); hint.textContent = 'Snoozed three times. Consider keeping this as a passive reference instead.'; card.append(hint); actionButton('Keep as reference', () => commit(item, 'reference')); }
      for (const [label, action] of [['Do / Done','done'],['Promote','promote'],['Defer / Snooze 1 week','snooze'],['Mutate to summary','mutate'],['Compost','compost']]) actionButton(label, () => commit(item, action));
    }
    const sparks = items.filter(i => !i.archived && i.type === 'Spark');
    // Stable daily pseudo-random selection, no timer or network required.
    const day = Math.floor(Date.now() / DAY);
    const seed = ((Math.imul(day ^ 0x9e3779b9, 1664525) + 1013904223) >>> 0);
    root.querySelector('.review-serendipity').textContent = sparks.length ? 'Serendipity: ' + [sparks[seed % sparks.length], ...(sparks.length > 1 ? [sparks[(seed + 1) % sparks.length]] : [])].map(i => i.text).join(' • ') : '';
    const archive = root.querySelector('.review-archive'); archive.replaceChildren();
    const query = root.querySelector('input[type=search]').value.toLowerCase();
    items.filter(i => i.archived && `${i.text} ${i.source}`.toLowerCase().includes(query)).forEach(i => {
      const row = document.createElement('p'); row.textContent = `${i.source}: ${i.text}`; actionButton('Restore', () => commit(i, 'restore'), row); archive.append(row);
    });
  }
  function resetSession() {
    session.clear(); reviewed.clear();
    root.querySelector('#review-panel').hidden = true;
    root.querySelector('#review-start').setAttribute('aria-expanded', 'false');
  }
  function updateSelection() {
    const start = root.querySelector('#review-start');
    start.textContent = `Start Smart Review (${selected.size})`;
    start.disabled = selected.size === 0;
    root.querySelector('.review-count').textContent = `${items.filter(i => !i.archived).length} active · ${items.filter(i => i.archived).length} archived · ${selected.size} selected`;
  }
  function renderItems() {
    const list = root.querySelector('.review-items'); list.replaceChildren();
    const active = items.filter(i => !i.archived);
    if (!active.length) list.textContent = 'No saved review items yet. Add a new item or select some note text above.';
    active.forEach(item => {
      const label = document.createElement('label'); label.className = 'review-item';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = item.id;
      checkbox.checked = selected.has(item.id);
      checkbox.onchange = () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); resetSession(); updateSelection(); };
      const text = document.createElement('span');
      text.textContent = `${item.type}${due(item) ? ' · Needs attention' : ''} · From: ${item.source}\n${item.text}`;
      label.append(checkbox, text); list.append(label);
    });
    updateSelection();
  }
  pill.onclick = () => { resetSession(); selected.clear(); items.filter(i => due(i)).forEach(i => selected.add(i.id)); render(); };
  root.querySelector('#review-all').onclick = () => { resetSession(); selected.clear(); items.filter(i => !i.archived).forEach(i => selected.add(i.id)); render(); };
  root.querySelector('#review-clear-selection').onclick = () => { resetSession(); selected.clear(); render(); };
  root.querySelector('#review-start').onclick = () => {
    if (!selected.size) return;
    session = new Set(selected); reviewed.clear();
    root.querySelector('#review-panel').hidden = false;
    root.querySelector('#review-start').setAttribute('aria-expanded', 'true');
    render(); card.tabIndex = -1; card.focus();
  };
  function addCopies(text, origin) {
    resetSession();
    const before = new Set(items.map(i => i.id));
    const copies = [];
    capture(copies, text, origin);
    copies.forEach(copy => { if (!items.some(i => i.source === origin && i.original === copy.original)) items.push(copy); });
    const added = items.filter(i => !before.has(i.id));
    added.filter(i => !i.archived).forEach(i => selected.add(i.id));
    const status = root.querySelector('[role=status]');
    if (added.length) {
      if (!save()) return false;
      status.textContent = `Saved ${added.length} review item(s) on this device only. Selected below — click Start Smart Review when ready. Original notes are unchanged.`;
    } else status.textContent = 'This text already has a review copy. Find it in the saved list or archive; no duplicate was added.';
    render(); return true;
  }
  root.querySelector('#review-add').onclick = () => {
    const field = root.querySelector('#review-capture');
    if (!field.value.trim()) { field.focus(); root.querySelector('[role=status]').textContent = 'Enter a task, URL, or idea first.'; return; }
    if (addCopies(field.value, `New review item ${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`)) field.value = '';
  };
  root.querySelector('#review-from-note').addEventListener('mousedown', e => e.preventDefault());
  root.querySelector('#review-from-note').onclick = () => {
    const text = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    if (!text) { root.querySelector('[role=status]').textContent = 'Highlight the text you want in the note editor above, then click Add selected note text.'; textarea.focus(); return; }
    addCopies(text, source());
  };
  function openFromLink() {
    if (window.location.hash !== '#smart-review') return;
    root.scrollIntoView?.({ block: 'start' }); root.focus();
  }
  window.addEventListener('hashchange', openFromLink);
  root.querySelector('input[type=search]').oninput = render;
  root.querySelector('#review-export').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'smart-review.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('storage', e => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const incoming = JSON.parse(e.newValue);
      if (Array.isArray(incoming) && incoming.every(i => i && typeof i.text === 'string' && typeof i.source === 'string')) { items = incoming; render(); }
    } catch { /* Keep this tab's last valid view. */ }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  let x;
  card.addEventListener('touchstart', e => { x = e.changedTouches[0].clientX; }, { passive: true });
  card.addEventListener('touchend', e => { const dx = e.changedTouches[0].clientX - x; const item = currentQueue()[0]; if (item && Math.abs(dx) > 90) commit(item, dx > 0 ? 'snooze' : 'compost'); }, { passive: true });
  render();
  openFromLink();
}
