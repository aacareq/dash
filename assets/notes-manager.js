// Multi-note management for the Scratchpad PWA.
//
// The editor still edits one note at a time; this manager keeps the collection
// in the same IndexedDB store as the original single note and remembers which
// file was open last, so "Today's note" reliably reopens for more edits instead
// of spawning duplicates. No DOM here — the page controller just reacts to the
// returned record.

import { datedFileName } from "./markdown.js";

export const NOTES_INDEX_KEY = "dash-scratchpad-notes-index";

// Stable per-day file name: notes-2026-10-27.md. Reused every time "Today's
// note" is chosen on that date, which is what makes "add to it" work.
export function todayNoteFileName(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `notes-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

function noteIdForPath(path) {
  return `note:${path}`;
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

  async list() {
    return this._readIndex();
  }

  // Saves the active note and bumps it to the front of the index.
  async _persistCurrent(body) {
    if (!this.current) return null;
    if (typeof body === "string") this.current.body = body;
    this.current.updatedAt = this.now().getTime();
    await this.store.putNote(this.current);
    const index = await this._readIndex();
    const entry = {
      path: this.current.path,
      title: this.current.title,
      updatedAt: this.current.updatedAt
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
  async switchTo(path, { repo = "", branch = "" } = {}) {
    const cleanPath = String(path || "").trim();
    if (!cleanPath) throw new Error("A note file path is required.");
    if (this.current?.path === cleanPath) return this.current;
    if (this.current) await this._persistCurrent();

    const id = noteIdForPath(cleanPath);
    let note = await this.store.getNote(id);
    if (!note) {
      note = {
        id,
        title: cleanPath.replace(/\.md$/i, ""),
        path: cleanPath,
        body: "",
        repo,
        branch,
        dirty: false,
        createdAt: this.now().getTime()
      };
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
  async newDatedNote() {
    return this.switchTo(datedFileName(this.now()));
  }

  async setBody(body) {
    return this._persistCurrent(body);
  }

  // First launch: most recent note from the index, else a provided fallback,
  // else today's note.
  async boot({ fallbackPath = "", repo = "", branch = "" } = {}) {
    const index = await this._readIndex();
    const path = index[0]?.path || fallbackPath || todayNoteFileName(this.now());
    return this.switchTo(path, { repo, branch });
  }
}
