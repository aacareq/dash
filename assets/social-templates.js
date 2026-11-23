/* Local, editable starting points for X and Motion Studio. No network calls. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.SocialTemplates = api;
    const boot = () => api.init(root.document);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const templates = {
    tip: { label: 'Practical tip', lines: (topic, point) => [`A practical way to approach ${topic}:`, point, `What has worked for you with ${topic}?`] },
    lesson: { label: 'Lesson / insight', lines: (topic, point) => [`A useful lesson about ${topic}:`, point, 'The takeaway: make the next action clear.'] },
    checklist: { label: 'Simple checklist', lines: (topic, point) => [`A starting point for ${topic}:`, point, 'Choose one action and review the result.'] },
    question: { label: 'Discussion starter', lines: (topic, point) => [`A question about ${topic}:`, point, 'How do you approach this?'] }
  };
  const example = { topic: 'planning a focused work session', point: 'Write the next action before opening your inbox.' };
  function render(id, topic, point) {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const t = clean(topic), p = clean(point);
    if (!templates[id]) throw new Error('Choose a template.');
    if (!t || !p) throw new Error('Add both a topic and a concrete point.');
    return templates[id].lines(t, p);
  }
  function init(doc) {
    doc.querySelectorAll('[data-social-templates]').forEach(panel => {
      if (panel.dataset.ready === 'true') return;
      panel.dataset.ready = 'true';
      const select = panel.querySelector('[data-template]');
      const topic = panel.querySelector('[data-topic]');
      const point = panel.querySelector('[data-point]');
      const message = panel.querySelector('[data-template-status]');
      const target = doc.getElementById(panel.dataset.target);
      if (!select || !topic || !point || !message || !target) return;
      Object.entries(templates).forEach(([id, template]) => {
        const option = doc.createElement('option'); option.value = id; option.textContent = template.label; select.appendChild(option);
      });
      panel.querySelector('[data-example]').addEventListener('click', () => {
        if ((topic.value.trim() || point.value.trim()) && !doc.defaultView.confirm('Replace the topic and point fields with the example?')) return;
        topic.value = example.topic; point.value = example.point;
        message.textContent = 'Example loaded into the fields. Adapt it to your own experience.';
      });
      panel.querySelector('[data-use-template]').addEventListener('click', () => {
        try {
          const lines = render(select.value, topic.value, point.value);
          const separator = panel.dataset.socialTemplates === 'motion' ? '\n' : '\n\n';
          const value = lines.join(separator);
          if (target.maxLength > 0 && value.length > target.maxLength) throw new Error('The draft is too long for the editor. Shorten your topic or point.');
          if (target.value.trim() && !doc.defaultView.confirm('Replace the existing editor text? Copy or save it first if you need it.')) return;
          target.value = value;
          target.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
          target.focus();
          message.textContent = panel.dataset.socialTemplates === 'motion' ? 'Lines loaded. Choose Generate locally to preview; review before export.' : 'Draft loaded. Edit and verify it before saving or publishing.';
        } catch (error) { message.textContent = error.message; }
      });
    });
  }
  return { templates, example, render, init };
});
