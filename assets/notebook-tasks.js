// Inline task aggregation — parse markdown task lines and sync checkbox state.

const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;

export function parseTasks(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (m) {
      const checked = m[1].toLowerCase() === "x";
      const text = (m[2] || "").trim();
      // Find nearest heading for grouping
      let group = "Tasks";
      for (let j = i; j >= 0; j--) {
        const h = lines[j].match(/^\s*#{1,6}\s+(.*)$/);
        if (h) { group = h[1].trim(); break; }
      }
      tasks.push({ lineIndex: i, checked, text, group, raw: lines[i] });
    }
  }
  return tasks;
}

export function groupTasks(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.group)) map.set(t.group, []);
    map.get(t.group).push(t);
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }));
}

export function taskStats(tasks) {
  const total = tasks.length;
  const done = tasks.filter(t => t.checked).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return { total, done, remaining: total - done, percent };
}

export function toggleTaskLine(source, lineIndex, checked) {
  const lines = String(source || "").split("\n");
  if (!lines[lineIndex] || !TASK_RE.test(lines[lineIndex])) return String(source || "");
  lines[lineIndex] = lines[lineIndex].replace(TASK_RE, (_, __, text) => `- [${checked ? "x" : " "}] ${text}`);
  return lines.join("\n");
}

export function insertTask(source, { groupTitle = "", text = "New task" } = {}) {
  let lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  if (groupTitle) {
    // Find heading line for group
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^\s*#{1,6}\s+(.*)$/);
      if (h && h[1].trim().toLowerCase() === groupTitle.toLowerCase()) { idx = i; break; }
    }
    if (idx !== -1) {
      // Insert after heading block — skip until next heading or end, find last task/non-empty
      let insertAt = idx + 1;
      // Skip empty lines right after heading
      while (insertAt < lines.length && !lines[insertAt].trim()) insertAt++;
      // Walk past existing list items under this heading
      while (insertAt < lines.length) {
        if (/^\s*#{1,6}\s+/.test(lines[insertAt])) break;
        if (TASK_RE.test(lines[insertAt]) || /^\s*[-*+]\s+/.test(lines[insertAt]) || !lines[insertAt].trim()) insertAt++;
        else {
          // First non-list content: insert before it
          break;
        }
      }
      lines.splice(insertAt, 0, `- [ ] ${text}`);
      return lines.join("\n");
    } else {
      // Create new section
      const sep = lines.length && lines[lines.length - 1].trim() ? "\n\n" : "\n";
      return lines.join("\n") + `${sep}## ${groupTitle}\n\n- [ ] ${text}\n`;
    }
  }
  const tail = lines.length && lines[lines.length - 1].trim() ? "\n" : "";
  return String(source || "") + `${tail}- [ ] ${text}\n`;
}

export function tasksToMarkdownChecklist(tasks) {
  if (!tasks.length) return "_No tasks yet._";
  const groups = groupTasks(tasks);
  return groups.map(g => `### ${g.group}\n\n${g.items.map(t => `- [${t.checked ? "x" : " "}] ${t.text}`).join("\n")}`).join("\n\n");
}
