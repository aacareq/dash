// Multi-note and workspace folder management for the Scratchpad PWA.
//
// Keeps notes and folder metadata in IndexedDB (via notes-store.js), remembers
// which file was open last, supports Today's note / Today's folder / new dated
// files, and performs safe local file & directory renames. No DOM here.

import { datedFileName } from "./markdown.js";

export const NOTES_INDEX_KEY = "dash-scratchpad-notes-index";
export const FOLDERS_INDEX_KEY = "dash-scratchpad-folders-index";

export function normalizeWorkspacePath(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  if (!cleaned) return "";
  const segments = cleaned.split("/");
  if (segments.some(seg => !seg || seg === "." || seg === ".." || seg === ".git")) {
    throw new Error("Path cannot contain empty segments, '.', '..', or '.git'.");
  }
  return cleaned;
}

export function parentFolderOf(path) {
  const clean = normalizeWorkspacePath(path);
  const slash = clean.lastIndexOf("/");
  return slash > 0 ? clean.slice(0, slash) : "";
}

// Stable per-day file name: notes-2026-10-27.md. Reused every time "Today's
// note" is chosen on that date, which is what makes "add to it" work.
export function todayNoteFileName(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `notes-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

// Default daily folder path: notes/2026-10-27 (or 2026-10-27 with empty prefix).
export function todayFolderPath(date = new Date(), prefix = "notes") {
  const pad = value => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const cleanPrefix = prefix ? normalizeWorkspacePath(prefix) : "";
  return cleanPrefix ? `${cleanPrefix}/${stamp}` : stamp;
}

// Dated note inside today's folder: notes/2026-10-27/notes-2026-10-27-1542.md
export function todayFolderNotePath(date = new Date(), prefix = "notes") {
  return `${todayFolderPath(date, prefix)}/${datedFileName(date)}`;
}

function noteIdForPath(path) {
  return `note:${path}`;
}

function titleForPath(path) {
  return String(path || "").replace(/\.md$/i, "");
}

export class NoteManager {
  // store: notes-store adapter; now: injectable clock for deterministic tests
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.current = null;
  }

  async _readIndex() {
    try {
      return JSON.parse((await this.store.kvGet(NOTES_INDEX_KEY)) || "[]");
    } catch (error) {
      return [];
    }
  }

  async _writeIndex(index) {
    await this.store.kvSet(NOTES_INDEX_KEY, JSON.stringify(index));
  }

  async _readFolders() {
    try {
      const list = JSON.parse((await this.store.kvGet(FOLDERS_INDEX_KEY)) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (error) {
      return [];
    }
  }

  async _writeFolders(folders) {
    const unique = [...new Set(folders.map(item => normalizeWorkspacePath(item)).filter(Boolean))].sort();
    await this.store.kvSet(FOLDERS_INDEX_KEY, JSON.stringify(unique));
    return unique;
  }

  async _recordFolder(dirPath) {
    const clean = normalizeWorkspacePath(dirPath);
    if (!clean) return;
    const folders = await this._readFolders();
    if (!folders.includes(clean)) {
      folders.push(clean);
      await this._writeFolders(folders);
    }
  }

  async list() {
    return this._readIndex();
  }

  async listFolders() {
    const folders = new Set(await this._readFolders());
    const index = await this._readIndex();
    index.forEach(item => {
      const parent = parentFolderOf(item.path);
      if (parent) folders.add(parent);
    });
    return [...folders].sort();
  }

  async createFolder(dirPath) {
    const clean = normalizeWorkspacePath(dirPath);
    if (!clean) throw new Error("A folder path is required.");
    const existing = await this.listFolders();
    const existed = existing.includes(clean);
    await this._recordFolder(clean);
    return { path: clean, existed };
  }

  // Saves the active note and bumps it to the front of the index.
  async _persistCurrent(body, { dirty, syncedAt } = {}) {
    if (!this.current) return null;
    if (typeof body === "string") this.current.body = body;
    if (typeof dirty === "boolean") this.current.dirty = dirty;
    if (typeof syncedAt === "number") this.current.syncedAt = syncedAt;
    this.current.updatedAt = this.now().getTime();
    await this.store.putNote(this.current);
    const parent = parentFolderOf(this.current.path);
    if (parent) await this._recordFolder(parent);
    const index = await this._readIndex();
    const entry = {
      path: this.current.path,
      title: this.current.title,
      updatedAt: this.current.updatedAt,
      dirty: Boolean(this.current.dirty),
      syncedAt: this.current.syncedAt || 0
    };
    const position = index.findIndex(item => item.path === entry.path);
    if (position >= 0) index[position] = entry;
    else index.push(entry);
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    await this._writeIndex(index);
    return this.current;
  }

  // Switches the active note, persisting whatever was open first. A missing
  // note is created on demand as an empty record saved on first edit.
  async switchTo(path, { repo = "", branch = "", initialBody } = {}) {
    const cleanPath = normalizeWorkspacePath(path);
    if (!cleanPath) throw new Error("A note file path is required.");
    if (this.current?.path === cleanPath) {
      if (typeof initialBody === "string") return this._persistCurrent(initialBody);
      return this.current;
    }
    if (this.current) await this._persistCurrent();

    const id = noteIdForPath(cleanPath);
    let note = await this.store.getNote(id);
    if (!note) {
      note = {
        id,
        title: titleForPath(cleanPath),
        path: cleanPath,
        body: typeof initialBody === "string" ? initialBody : "",
        repo,
        branch,
        dirty: false,
        syncedAt: 0,
        createdAt: this.now().getTime()
      };
    } else if (typeof initialBody === "string") {
      note.body = initialBody;
    }
    if (repo) note.repo = repo;
    if (branch) note.branch = branch;
    this.current = note;
    await this._persistCurrent(note.body);
    return note;
  }

  // The day's single reusable note — open it and keep appending all day.
  async openToday() {
    return this.switchTo(todayNoteFileName(this.now()));
  }

  // A separate timestamped note (notes-YYYY-MM-DD-HHMM.md) for a fresh start.
  // If that exact minute path already exists with content, appends a unique suffix.
  async newDatedNote({ folder = "" } = {}) {
    const now = this.now();
    const cleanFolder = folder ? normalizeWorkspacePath(folder) : "";
    const baseName = datedFileName(now);
    const stem = baseName.replace(/\.md$/i, "");
    const index = await this._readIndex();
    const taken = new Set(index.map(item => item.path));
    const candidate = cleanFolder ? `${cleanFolder}/${baseName}` : baseName;
    if (!taken.has(candidate)) {
      return this.switchTo(candidate);
    }
    const pad = value => String(value).padStart(2, "0");
    const withSeconds = `${stem}-${pad(now.getSeconds())}.md`;
    const secondCandidate = cleanFolder ? `${cleanFolder}/${withSeconds}` : withSeconds;
    if (!taken.has(secondCandidate)) {
      return this.switchTo(secondCandidate);
    }
    let counter = 2;
    while (counter < 1000) {
      const next = `${cleanFolder ? `${cleanFolder}/` : ""}${stem}-${counter}.md`;
      if (!taken.has(next)) return this.switchTo(next);
      counter += 1;
    }
    return this.switchTo(candidate);
  }

  async setBody(body, options = {}) {
    return this._persistCurrent(body, options);
  }

  async markSynced(path, syncedAt = this.now().getTime()) {
    const cleanPath = normalizeWorkspacePath(path);
    if (!cleanPath) return;
    if (this.current?.path === cleanPath) {
      await this._persistCurrent(undefined, { dirty: false, syncedAt });
      return;
    }
    const id = noteIdForPath(cleanPath);
    const existing = await this.store.getNote(id);
    if (existing) {
      existing.dirty = false;
      existing.syncedAt = syncedAt;
      await this.store.putNote(existing);
    }
    const index = await this._readIndex();
    const entry = index.find(item => item.path === cleanPath);
    if (entry) {
      entry.dirty = false;
      entry.syncedAt = syncedAt;
      await this._writeIndex(index);
    }
  }

  // Renames a note locally (active or inactive), moving its IndexedDB record and
  // updating the index cleanly without leaving stale duplicates behind.
  async renameNote(oldPath, newPath, { body } = {}) {
    const from = normalizeWorkspacePath(oldPath);
    const to = normalizeWorkspacePath(newPath);
    if (!from) throw new Error("Current file path is required.");
    if (!to) throw new Error("New file path is required.");
    if (from === to) throw new Error("Choose a different name or path for the file.");

    const index = await this._readIndex();
    if (index.some(item => item.path === to)) {
      throw new Error(`A note already exists at "${to}". Open it or choose another name.`);
    }

    const oldId = noteIdForPath(from);
    const existing = this.current?.path === from ? this.current : await this.store.getNote(oldId);
    const now = this.now().getTime();
    const nextNote = {
      ...(existing || {}),
      id: noteIdForPath(to),
      path: to,
      title: titleForPath(to),
      body: typeof body === "string" ? body : (existing?.body || ""),
      updatedAt: now,
      createdAt: existing?.createdAt || now
    };
    await this.store.putNote(nextNote);
    if (typeof this.store.deleteNote === "function") {
      await this.store.deleteNote(oldId);
    }
    const parent = parentFolderOf(to);
    if (parent) await this._recordFolder(parent);

    const nextIndex = index.filter(item => item.path !== from);
    nextIndex.unshift({
      path: to,
      title: nextNote.title,
      updatedAt: now,
      dirty: Boolean(nextNote.dirty),
      syncedAt: nextNote.syncedAt || 0
    });
    nextIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    await this._writeIndex(nextIndex);

    if (this.current?.path === from) this.current = nextNote;
    return { oldPath: from, newPath: to, note: nextNote };
  }

  // Renames a local directory prefix across all stored notes and the folder index.
  async renameDirectory(oldDir, newDir) {
    const from = normalizeWorkspacePath(oldDir);
    const to = normalizeWorkspacePath(newDir);
    if (!from) throw new Error("Choose or enter the folder to rename.");
    if (!to) throw new Error("Enter the new folder name.");
    if (from === to) throw new Error("The new folder name must be different from the current folder.");
    if (to.startsWith(`${from}/`)) throw new Error("Cannot move a folder inside itself.");

    const index = await this._readIndex();
    const prefix = `${from}/`;
    const matching = index.filter(item => item.path.startsWith(prefix));
    const collisions = matching
      .map(item => `${to}/${item.path.slice(prefix.length)}`)
      .filter(dest => index.some(other => other.path === dest && !other.path.startsWith(prefix)));
    if (collisions.length) {
      throw new Error(`Cannot rename folder: "${collisions[0]}" already exists.`);
    }

    const now = this.now().getTime();
    const movedNotes = [];
    const movedMap = new Map();
    for (const entry of matching) {
      const targetPath = `${to}/${entry.path.slice(prefix.length)}`;
      const oldId = noteIdForPath(entry.path);
      const record = this.current?.path === entry.path
        ? this.current
        : await this.store.getNote(oldId);
      const nextRecord = {
        ...(record || {}),
        id: noteIdForPath(targetPath),
        path: targetPath,
        title: titleForPath(targetPath),
        body: record?.body || "",
        updatedAt: now,
        createdAt: record?.createdAt || now
      };
      await this.store.putNote(nextRecord);
      if (typeof this.store.deleteNote === "function") {
        await this.store.deleteNote(oldId);
      }
      if (this.current?.path === entry.path) this.current = nextRecord;
      movedNotes.push({ from: entry.path, to: targetPath });
      movedMap.set(entry.path, {
        path: targetPath,
        title: nextRecord.title,
        updatedAt: now,
        dirty: Boolean(nextRecord.dirty),
        syncedAt: nextRecord.syncedAt || 0
      });
    }

    const nextIndex = index.map(entry => movedMap.get(entry.path) || entry);
    nextIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    await this._writeIndex(nextIndex);

    const folders = await this._readFolders();
    const nextFolders = folders.map(dir => {
      if (dir === from) return to;
      if (dir.startsWith(prefix)) return `${to}/${dir.slice(prefix.length)}`;
      return dir;
    });
    if (!nextFolders.includes(to)) nextFolders.push(to);
    await this._writeFolders(nextFolders);

    return {
      oldDir: from,
      newDir: to,
      movedNotes,
      activePath: this.current?.path || ""
    };
  }

  // First launch: most recent note from the index, else a provided fallback,
  // else today's note.
  async boot({ fallbackPath = "", repo = "", branch = "" } = {}) {
    const index = await this._readIndex();
    const path = index[0]?.path || fallbackPath || todayNoteFileName(this.now());
    return this.switchTo(path, { repo, branch });
  }
}
