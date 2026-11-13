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
  const save = () => { try { const json = JSON.stringify(items); if (localStorage.getItem(KEY) !== json) localStorage.setItem(KEY, json); } catch { root.querySelector('[role=status]').textContent = 'Review changes could not be saved. Export or free device storage.'; } };
  let reviewAll = false;
  const reviewed = new Set();
  const currentQueue = () => items.filter(i => reviewAll ? !i.archived && !reviewed.has(i.id) : due(i));
  root.innerHTML = `<h2>✨ Smart Review Queue</h2>
    <p>Turn saved tasks, links, and ideas into next steps — without deleting your original notes.</p>
    <details class="review-start"><summary>New here? How to use Smart Review</summary>
      <ol><li>Quick capture below adds a review-only item. Try “Call Alex”, a URL, or an inspiring thought. Or write paragraphs separated by blank lines in the note editor; they are captured after a pause.</li>
      <li>Choose <strong>Review all active items</strong> to use the actions right away. Needs Attention shows only items whose timers have expired.</li>
      <li><strong>Promote</strong> makes a task; <strong>Snooze</strong> defers one week; <strong>Mutate</strong> saves your own offline Markdown summary; <strong>Compost</strong> archives the review copy. Do / Done archives completed work. Next item skips without changing it.</li>
      <li>Tasks resurface after 72 hours, links after 7 days (auto-archive after 30 days untouched). After three snoozes, consider Keep as reference. Sparks appear in daily Serendipity. Search the archive to Restore; Export backs up the queue.</li></ol>
      <p>Review data stays on this device, separate from GitHub-synced notes.</p>
    </details>
    <label for="review-capture">Quick capture — task, link, or spark</label>
    <textarea id="review-capture" rows="2" placeholder="Call Alex, https://example.com, or an idea…"></textarea>
    <button type="button" class="modal-btn" id="review-add">Add to review</button>
    <p class="review-count" aria-live="polite"></p>
    <button type="button" class="modal-btn" id="review-all" aria-controls="review-panel">Review all active items</button>
    <button type="button" class="modal-btn" id="review-pill" aria-controls="review-panel" aria-expanded="false">Needs Attention (0)</button>
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
    if (reviewAll) reviewed.add(item.id);
    if (extra) items.push(extra);
    save(); render();
  }
  function render() {
    expire(items); save();
    const queue = currentQueue();
    pill.textContent = `Needs Attention (${items.filter(i => due(i)).length})`;
    root.querySelector('.review-count').textContent = `${items.filter(i => !i.archived).length} active · ${items.filter(i => i.archived).length} archived · ${reviewAll ? 'Reviewing all active items' : 'Showing due items'}`;
    card.replaceChildren();
    const item = queue[0];
    const text = document.createElement('p'); text.textContent = item ? `${item.type} · ${item.source}\n${item.text}` : (reviewAll ? 'No more items in this session. Choose Review all active items to start again, or add a new capture.' : 'Nothing is due yet. Choose Review all active items to try the actions now, or add a quick capture above.'); card.append(text);
    if (item) {
      actionButton('Next item', () => { reviewAll = true; reviewed.add(item.id); render(); });
      if (item.snoozeCount >= 3) { const hint = document.createElement('p'); hint.textContent = 'Snoozed three times. Consider keeping this as a passive reference instead.'; card.append(hint); actionButton('Keep as reference', () => commit(item, 'reference')); }
      for (const [label, action] of [['Do / Done','done'],['Promote','promote'],['Defer / Snooze 1 week','snooze'],['Mutate to summary','mutate'],['Compost','compost']]) actionButton(label, () => commit(item, action));
    }
    const sparks = items.filter(i => !i.archived && i.type === 'Spark');
    // Stable daily pseudo-random selection, no timer or network required.
    const day = Math.floor(Date.now() / DAY);
    const seed = ((Math.imul(day ^ 0x9e3779b9, 1664525) + 1013904223) >>> 0);
    root.querySelector('.review-serendipity').textContent = sparks.length ? 'Serendipity: ' + [sparks[seed % sparks.length], ...(sparks.length > 1 ? [sparks[(seed + 1) % sparks.length]] : [])].map(i => i.text).join(' • ') : '';
    const archive = root.querySelector('.review-archive'); archive.replaceChildren();
    const query = root.querySelector('input').value.toLowerCase();
    items.filter(i => i.archived && `${i.text} ${i.source}`.toLowerCase().includes(query)).forEach(i => {
      const row = document.createElement('p'); row.textContent = `${i.source}: ${i.text}`; actionButton('Restore', () => commit(i, 'restore'), row); archive.append(row);
    });
  }
  function openPanel() {
    root.querySelector('#review-panel').hidden = false;
    pill.setAttribute('aria-expanded', 'true');
  }
  pill.onclick = () => { reviewAll = false; openPanel(); render(); };
  root.querySelector('#review-all').onclick = () => { reviewAll = true; reviewed.clear(); openPanel(); render(); };
  root.querySelector('#review-add').onclick = () => {
    const field = root.querySelector('#review-capture');
    if (!field.value.trim()) { field.focus(); root.querySelector('[role=status]').textContent = 'Enter a task, URL, or idea first.'; return; }
    reviewed.clear(); items.forEach(i => reviewed.add(i.id));
    capture(items, field.value, `Quick capture ${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`);
    field.value = ''; reviewAll = true; openPanel(); render();
    root.querySelector('[role=status]').textContent = 'Added to your local review queue. Use the card actions below; original notes are unchanged.';
  };
  function openFromLink() {
    if (window.location.hash !== '#smart-review') return;
    reviewAll = true; reviewed.clear(); openPanel(); render();
    root.scrollIntoView?.({ block: 'start' }); root.focus();
  }
  window.addEventListener('hashchange', openFromLink);
  root.querySelector('input').oninput = render;
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
  let timer;
  function collect() { capture(items, textarea.value, source()); render(); }
  textarea.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(collect, 1500); });
  textarea.addEventListener('blur', () => { clearTimeout(timer); collect(); });
  let x;
  card.addEventListener('touchstart', e => { x = e.changedTouches[0].clientX; }, { passive: true });
  card.addEventListener('touchend', e => { const dx = e.changedTouches[0].clientX - x; const item = currentQueue()[0]; if (item && Math.abs(dx) > 90) commit(item, dx > 0 ? 'snooze' : 'compost'); }, { passive: true });
  collect();
  openFromLink();
}
