export const NOTE_INTENTS = ['Plain Note', 'Task', 'Inspiration', 'Reference', 'Prompt Seed'];
export function createNoteOutline(path = 'Untitled.md', now = new Date()) {
  if (!/\.md$/i.test(path)) return '';
  const title = path.split('/').pop().replace(/\.md$/i, '').replace(/[\r\n]+/g, ' ') || 'Untitled';
  return `# ${title} — Note created on ${now.toISOString()}\n\n${NOTE_INTENTS.map(intent => `## ${intent}\n\n`).join('')}`;
}
