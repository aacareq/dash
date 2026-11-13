import { appendToNote } from './capture.js';

export const STARTERS = {
  summary: { task: 'Summarize {{document}} into the key claims, supporting evidence, and open questions.', role: 'Research analyst', context: '{{document}}', audience: '[audience]', tone: 'Concise', format: 'Bullet Points', rules: 'Do not invent facts. Distinguish claims from verified evidence.' },
  review: { task: 'Review {{code}} for correctness, security, and maintainability.', role: 'Senior Engineer', context: '{{code}}', audience: 'Engineering team', tone: 'Technical', format: 'Markdown Table', rules: 'Prioritize actionable findings. Include severity and concrete evidence. Do not claim to have executed the code.' },
  extract: { task: 'Extract [fields] from {{source}}.', role: 'Data extraction specialist', context: '{{source}}', audience: 'Data consumers', tone: 'Concise', format: 'JSON', rules: 'Return null for missing values. Do not infer unsupported facts.' },
  draft: { task: 'Draft {{deliverable}} about {{topic}}.', role: 'Copywriter', context: '{{background}}', audience: '[audience]', tone: 'Persuasive', format: 'Markdown', rules: 'Avoid unsupported claims and respect the specified scope.' }
};
const FIELDS = ['task', 'role', 'context', 'audience', 'tone', 'rules', 'length', 'scope', 'format', 'examples', 'steps'];
export function resolveVariables(text, bindings = '') {
  const map = new Map(bindings.split('\n').filter(line => line.includes('=')).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }));
  return String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}|\[([\w.-]+)\]/g, (all, a, b) => map.has(a || b) ? map.get(a || b) : all);
}
export function assemblePrompt(input) {
  if (!input.task?.trim()) return '';
  const values = Object.fromEntries(FIELDS.map(key => [key, resolveVariables(input[key] || '', input.bindings || '').trim()]));
  const formatRules = {
    JSON: 'Return only valid JSON, without Markdown fences or commentary.',
    'Markdown Table': 'Return a Markdown table with a header row, separator row, and consistent columns.',
    'Bullet Points': 'Return a bullet list, one main point per bullet.',
    'Code Block': 'Return code in a fenced code block with a language label when known.',
    Markdown: 'Use clear Markdown headings and formatting.',
    'Plain Text': 'Return plain text without Markdown or XML formatting.'
  };
  if (values.format) values.format = `${values.format}${formatRules[values.format] ? ` — ${formatRules[values.format]}` : ''}`;
  const rules = [values.rules, values.length && `Length limit: ${values.length}`, values.scope && `Scope boundaries: ${values.scope}`].filter(Boolean).join('\n');
  const sections = input.framework === 'CARE' ? [
    ['Context', values.context], ['Action', values.task], ['Result', values.format], ['Examples', values.examples]
  ] : input.framework === 'RISE' ? [
    ['Role', values.role], ['Input', values.context], ['Steps', values.steps || `Complete this task: ${values.task}\nCheck the result against the rules and required output.`], ['Expectation', values.format]
  ] : [['Role', values.role], ['Task', values.task], ['Context', values.context], ['Format', values.format]];
  // CARE still includes expertise; RISE always includes the explicit goal even with custom steps.
  if (input.framework === 'CARE') sections.unshift(['Role', values.role]);
  if (input.framework === 'RISE') sections.splice(1, 0, ['Task', values.task]);
  sections.push(['Audience', values.audience], ['Tone and style', values.tone], ['Rules and exclusions', rules]);
  if (input.framework !== 'CARE') sections.push(['Examples', values.examples]);
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const content = sections.filter(([, text]) => text).map(([name, text]) => {
    if (input.delimiter === 'XML') {
      const tag = name.toLowerCase().replace(/[^a-z]+/g, '_');
      return `<${tag}>\n${escape(text)}\n</${tag}>`;
    }
    return `## ${name}\n${text}`;
  });
  return content.join('\n\n');
}

export function initPromptCreator({ root, textarea, target = () => 'the active note' }) {
  if (!root || !textarea) return;
  const doc = root.ownerDocument;
  root.innerHTML = `<summary>✦ Basic prompt creator (optional)</summary>
    <p>Build instructions locally — no AI call, account, or separate inbox. Fields and preview are temporary until copied or added to the active note. Generated text is a prompt, not a model response.</p>
    <div class="capture-row"><label>Starter template<select data-prompt="starter"><option value="summary">Summarization</option><option value="review">Code review</option><option value="extract">Extraction</option><option value="draft">Drafting</option></select></label><button type="button" class="modal-btn cancel" data-load>Load starter</button></div>
    <label>Intent / task (required)<textarea data-prompt="task" rows="2" placeholder="What should the AI accomplish?"></textarea></label>
    <div class="capture-row"><label>Role / persona<input data-prompt="role" list="prompt-personas" placeholder="e.g. Senior Engineer"></label><label>Audience<input data-prompt="audience" placeholder="Who is the result for?"></label></div>
    <datalist id="prompt-personas"><option value="Senior Engineer"></option><option value="Copywriter"></option><option value="Research analyst"></option><option value="Teacher"></option></datalist>
    <label>Context / background<textarea data-prompt="context" rows="3" placeholder="Background data, source material, domain context…"></textarea></label>
    <div class="capture-row"><label>Tone / style<select data-prompt="tone"><option>Concise</option><option>Formal</option><option>Technical</option><option>Persuasive</option><option>Neutral</option><option>Conversational</option></select></label><label>Output format<select data-prompt="format"><option>Markdown</option><option>JSON</option><option>Markdown Table</option><option>Bullet Points</option><option>Code Block</option><option>Plain Text</option></select></label></div>
    <label>Constraints / exclusions<textarea data-prompt="rules" rows="2" placeholder="What must be included or avoided?"></textarea></label>
    <div class="capture-row"><label>Length limit<input data-prompt="length" placeholder="e.g. At most 300 words"></label><label>Scope boundaries<input data-prompt="scope" placeholder="e.g. Browser JavaScript only; no backend"></label></div>
    <div class="capture-row"><label>Framework<select data-prompt="framework"><option value="RTCF">Role–Task–Context–Format</option><option>CARE</option><option>RISE</option></select></label><label>Delimiter style<select data-prompt="delimiter"><option>Markdown</option><option>XML</option></select></label></div>
    <p>CARE: Context, Action, Result, Examples. RISE: Role, Input, Steps, Expectation. Shared audience, tone, and rules are included in every framework.</p>
    <label>Examples (optional; CARE scaffolding)<textarea data-prompt="examples" rows="2"></textarea></label>
    <label>Steps (optional; RISE scaffolding)<textarea data-prompt="steps" rows="2" placeholder="Leave blank for a basic task-and-validation sequence."></textarea></label>
    <details><summary>Reusable variables</summary><p>Use {{topic}} or [audience]. Leave unbound placeholders intact for reuse, or enter one name=value per line below. Values are inserted literally, not executed.</p><label>Variable values<textarea data-prompt="bindings" rows="3" placeholder="topic=Browser security"></textarea></label></details>
    <button type="button" class="modal-btn submit" data-generate>Generate prompt preview</button>
    <label>Prompt preview (editable)<textarea data-prompt="preview" rows="10" placeholder="Generate a preview first. Editing this preview does not change your note."></textarea></label>
    <p data-estimate></p><p data-destination></p>
    <div class="capture-row"><button type="button" class="modal-btn cancel" data-copy>Copy prompt</button><button type="button" class="modal-btn submit" data-append>Add prompt to note</button></div>
    <p role="status" aria-live="polite"></p>`;
  const field = key => root.querySelector(`[data-prompt="${key}"]`);
  const status = text => { root.querySelector('[role=status]').textContent = text; };
  function update() {
    const text = field('preview').value;
    root.querySelector('[data-estimate]').textContent = `${text.length} characters · ~${Math.ceil(text.length / 4)} estimated tokens (rough estimate, not model-specific).`;
    root.querySelector('[data-destination]').textContent = `Add destination: ${target()}. Uses the note's existing local autosave and optional GitHub sync.`;
    root.querySelector('[data-copy]').disabled = !text.trim(); root.querySelector('[data-append]').disabled = !text.trim();
  }
  root.addEventListener('focusin', update); root.addEventListener('toggle', update);
  field('preview').addEventListener('input', update);
  root.querySelector('[data-load]').onclick = () => {
    if (FIELDS.some(key => !['tone', 'format'].includes(key) && field(key).value.trim()) || field('preview').value.trim()) {
      if (!doc.defaultView.confirm('Replace the prompt inputs and preview with this starter? Your note will not change.')) return;
    }
    for (const key of FIELDS) field(key).value = STARTERS[field('starter').value][key] || '';
    field('bindings').value = ''; field('preview').value = ''; update();
    status('Starter loaded into temporary fields. Customize it, then generate a preview.');
  };
  root.querySelector('[data-generate]').onclick = () => {
    const input = Object.fromEntries([...FIELDS, 'bindings', 'framework', 'delimiter'].map(key => [key, field(key).value]));
    if (!input.task.trim()) { status('Enter an intent / task first.'); field('task').focus(); return; }
    if (field('preview').value.trim() && !doc.defaultView.confirm('Replace the editable preview with a newly generated prompt?')) return;
    field('preview').value = assemblePrompt(input); update();
    status('Preview generated locally. Check unresolved placeholders and instructions before copying or adding to a note.');
  };
  root.querySelector('[data-copy]').onclick = async () => {
    if (!field('preview').value.trim()) return;
    try { await doc.defaultView.navigator.clipboard.writeText(field('preview').value); status('Prompt copied. Your note was not changed.'); }
    catch { field('preview').focus(); field('preview').select(); status('Clipboard unavailable. Preview selected — copy manually with Ctrl/⌘+C or the selection menu.'); }
  };
  root.querySelector('[data-append]').onclick = () => {
    if (!field('preview').value.trim()) return;
    appendToNote(textarea, field('preview').value.trim()); status(`Prompt appended to ${target()}. Normal note save/export controls apply.`);
  };
  update();
}
