// A convenience input for the existing note, never another storage collection.
export function formatCapture({ text, source = '', intent = '', timestamp = false }, now = new Date()) {
  const body = String(text).trim();
  if (!body) return '';
  const metadata = [];
  if (['Task', 'Inspiration', 'Reference', 'Prompt Seed'].includes(intent)) metadata.push(`Intent: ${intent}`);
  if (source.trim()) metadata.push(`Source: ${source.trim().replace(/\s*\n\s*/g, ' ')}`);
  if (timestamp) metadata.push(`Captured: ${now.toISOString()}`);
  return [body, ...metadata].join('\n\n');
}

export function initCapture({ root, textarea, target = () => 'the active note' }) {
  if (!root || !textarea) return;
  const doc = root.ownerDocument;
  root.innerHTML = `<summary>＋ Capture text with context (optional)</summary>
    <p data-target></p>
    <p>Append to the end of this note, without replacing its text. Once added, content uses the same local autosave, exports, and optional GitHub sync as the note. Draft fields below are not saved until you click Add to note.</p>
    <label>Content<textarea data-capture="text" rows="3" placeholder="Paste a quote, URL, idea, or prompt fragment…"></textarea></label>
    <div class="capture-row">
      <label>Source / origin (optional)<input data-capture="source" type="text" placeholder="URL, book and author, or where this came from"></label>
      <label>Intent (optional)<select data-capture="intent"><option value="">Plain note</option><option>Task</option><option>Inspiration</option><option>Reference</option><option>Prompt Seed</option></select></label>
    </div>
    <label class="capture-check"><input data-capture="time" type="checkbox"> Include capture time</label>
    <div class="capture-row"><button type="button" class="modal-btn cancel" data-paste>Paste clipboard into draft</button><button type="button" class="modal-btn submit" data-add>Add to note</button></div>
    <p role="status" aria-live="polite"></p>`;
  const field = name => root.querySelector(`[data-capture="${name}"]`);
  const status = message => { root.querySelector('[role=status]').textContent = message; };
  function showTarget() { root.querySelector('[data-target]').textContent = `Destination: ${target()}`; }
  root.addEventListener('toggle', showTarget);
  root.addEventListener('focusin', showTarget);
  showTarget();
  root.querySelector('[data-paste]').addEventListener('click', async event => {
    const button = event.currentTarget;
    const draft = field('text').value;
    button.disabled = true;
    try {
      const clipboard = doc.defaultView.navigator.clipboard;
      if (!clipboard?.readText) throw new Error('unsupported');
      const text = await clipboard.readText();
      if (field('text').value !== draft) { status('Draft changed while reading. Nothing was replaced; paste manually instead.'); return; }
      if (!text.trim()) { status('Clipboard is empty. Paste or type content below.'); return; }
      field('text').value = draft ? `${draft}\n\n${text}` : text;
      status('Clipboard is in the draft only. Check the source and destination, then click Add to note.');
      field('text').focus();
    } catch {
      status('Clipboard access is unavailable or denied. Tap Content and paste manually (Ctrl/⌘+V).');
      field('text').focus();
    } finally { button.disabled = false; }
  });
  root.querySelector('[data-add]').addEventListener('click', () => {
    const content = formatCapture({ text: field('text').value, source: field('source').value, intent: field('intent').value, timestamp: field('time').checked });
    if (!content) { status('Enter some content first. Nothing was added.'); field('text').focus(); return; }
    const end = textarea.value.length;
    const separator = end ? (textarea.value.endsWith('\n\n') ? '' : textarea.value.endsWith('\n') ? '\n' : '\n\n') : '';
    const insertion = `${separator}${content}\n`;
    textarea.focus(); textarea.setSelectionRange(end, end);
    let inserted = false;
    try { inserted = doc.execCommand?.('insertText', false, insertion); } catch { /* Use portable fallback. */ }
    if (!inserted) {
      textarea.setRangeText(insertion, end, end, 'end');
      textarea.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    }
    field('text').value = ''; field('source').value = '';
    field('intent').value = ''; field('time').checked = false;
    showTarget(); status(`Added to ${target()}. Use this note's normal save/export controls; no separate copy or inbox was created.`);
  });
}
