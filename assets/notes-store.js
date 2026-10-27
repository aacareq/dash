// Offline-first storage for the Scratchpad PWA.
//
// Replaces the single synchronous localStorage string ("dash-scratchpad") with:
//   notes   — one record per note (id, title, body, updatedAt, github target, dirty)
//   kv      — settings and GitHub credentials (the same key strings the dialog used)
//   outbox  — GitHub commits queued while offline, drained on reconnect
//
// IndexedDB is asynchronous (no main-thread blocking), structured-cloneable and
// usable from a service worker; localStorage is none of those. A MemoryStore with
// the same interface keeps the app working (and the code testable) where IndexedDB
// is unavailable.

export const STORE_DB_NAME = "dash-scratchpad";
export const STORE_DB_VERSION = 1;
export const ACTIVE_NOTE_ID = "scratchpad";

// The localStorage keys the dashboard dialog used. Migration copies them verbatim
// into kv so an existing GitHub App connection keeps working in the PWA.
export const LEGACY_KEYS = {
  note: "dash-scratchpad",
  preview: "dash-scratchpad-preview",
  app: "dash-scratchpad-gh-app-v2",
  token: "dash-scratchpad-gh-token-v1",
  repo: "dash-scratchpad-gh-repo",
  path: "dash-scratchpad-gh-path",
  branch: "dash-scratchpad-gh-branch",
  autosave: "dash-scratchpad-gh-autosave",
  shas: "dash-scratchpad-gh-file-shas-v1"
};

// Pure migration planner: given a localStorage-like snapshot, returns the kv
// entries and note body that should be seeded. No globals touched here.
export function planLegacyMigration(snapshot = {}) {
  const kvEntries = [];
  const copy = key => {
    const value = snapshot[key];
    if (value !== undefined && value !== null && value !== "") kvEntries.push({ key, value: String(value) });
  };
  [LEGACY_KEYS.preview, LEGACY_KEYS.app, LEGACY_KEYS.token, LEGACY_KEYS.repo,
   LEGACY_KEYS.path, LEGACY_KEYS.branch, LEGACY_KEYS.autosave, LEGACY_KEYS.shas].forEach(copy);
  return { kvEntries, noteBody: snapshot[LEGACY_KEYS.note] || "" };
}

// Outbox classification — decides what a failed commit means without touching
// fetch itself, so the drain loop and the tests share one rulebook.
//   auth      — credential problem; retrying won't help until the user reconnects
//   conflict  — the file moved on GitHub; needs Pull latest / Overwrite anyway
//   transient — offline, rate limit, 5xx; keep the entry and retry later
//   fatal     — malformed target (e.g. directory); keep but stop auto-retrying
export function classifySyncError(error = {}) {
  const status = error.status || 0;
  const message = String(error.message || "").toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 409 || /does not match|sha/i.test(message)) return "conflict";
  if (status === 422 || /directory|not a file/i.test(message)) return "fatal";
  if (status === 429 || status >= 500 || error.name === "AbortError" ||
      /network|failed to fetch|load failed|offline/i.test(message)) return "transient";
  if (status === 404) return "auth"; // app not installed on the repo in this codebase
  return "transient";
}

// What the drain loop should do with an entry given the remote file's current sha.
export function nextOutboxAction(entry, remote) {
  if (!remote) return "create";                       // nothing on GitHub yet → PUT creates
  if (entry.sha && remote.sha === entry.sha) return "put"; // nobody else touched it
  return "conflict";                                  // remote moved on → pause for the user
}

export function makeOutboxEntry({ repo, path, branch = "", content, sha = null, message = "" }) {
  return {
    id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    repo, path, branch, content, sha, message,
    attempts: 0,
    createdAt: Date.now(),
    lastError: ""
  };
}

// Same async interface as IndexedDBStore; used as a fallback and in Node tests.
export class MemoryStore {
  constructor() {
    this.kvMap = new Map();
    this.notesMap = new Map();
    this.outboxMap = new Map();
  }
  async open() { return this; }
  async kvGet(key) { return this.kvMap.has(key) ? this.kvMap.get(key) : null; }
  async kvSet(key, value) { this.kvMap.set(key, String(value)); }
  async kvDelete(key) { this.kvMap.delete(key); }
  async getNote(id) { return this.notesMap.get(id) || null; }
  async putNote(note) { this.notesMap.set(note.id, { ...note, updatedAt: Date.now(), ...note }); return note; }
  async enqueueOutbox(entry) { this.outboxMap.set(entry.id, entry); return entry; }
  async listOutbox() { return [...this.outboxMap.values()].sort((a, b) => a.createdAt - b.createdAt); }
  async updateOutbox(id, patch) {
    const current = this.outboxMap.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.outboxMap.set(id, next);
    return next;
  }
  async removeOutbox(id) { this.outboxMap.delete(id); }
  async clearOutbox() { this.outboxMap.clear(); }
}

export class IndexedDBStore {
  constructor({ indexedDb = (typeof indexedDB !== "undefined" ? indexedDB : null) } = {}) {
    this.indexedDb = indexedDb;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      if (!this.indexedDb) { reject(new Error("IndexedDB unavailable")); return; }
      const request = this.indexedDb.open(STORE_DB_NAME, STORE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      };
      request.onsuccess = () => { this.db = request.result; resolve(this); };
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  }

  _tx(storeName, mode) {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }
  static _request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async kvGet(key) {
    const row = await IndexedDBStore._request(this._tx("kv", "readonly").get(key));
    return row ? row.value : null;
  }
  async kvSet(key, value) {
    await IndexedDBStore._request(this._tx("kv", "readwrite").put({ key, value: String(value) }));
  }
  async kvDelete(key) {
    await IndexedDBStore._request(this._tx("kv", "readwrite").delete(key));
  }
  async getNote(id) {
    return IndexedDBStore._request(this._tx("notes", "readonly").get(id));
  }
  async putNote(note) {
    const record = { updatedAt: Date.now(), ...note };
    await IndexedDBStore._request(this._tx("notes", "readwrite").put(record));
    return record;
  }
  async enqueueOutbox(entry) {
    await IndexedDBStore._request(this._tx("outbox", "readwrite").put(entry));
    return entry;
  }
  async listOutbox() {
    const entries = await IndexedDBStore._request(this._tx("outbox", "readonly").getAll());
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  }
  async updateOutbox(id, patch) {
    const current = await IndexedDBStore._request(this._tx("outbox", "readonly").get(id));
    if (!current) return null;
    const next = { ...current, ...patch };
    await IndexedDBStore._request(this._tx("outbox", "readwrite").put(next));
    return next;
  }
  async removeOutbox(id) {
    await IndexedDBStore._request(this._tx("outbox", "readwrite").delete(id));
  }
  async clearOutbox() {
    await IndexedDBStore._request(this._tx("outbox", "readwrite").clear());
  }
}

// Picks IndexedDB when the runtime has it, falls back to the memory adapter so the
// editor still works (without cross-reload persistence) on locked-down browsers.
export async function openStore() {
  if (typeof indexedDB !== "undefined") {
    try {
      const store = new IndexedDBStore();
      await store.open();
      return store;
    } catch (error) {
      console.warn("Scratchpad: IndexedDB unavailable, falling back to in-memory storage.", error);
    }
  }
  return new MemoryStore();
}

// Keys mirrored into localStorage. The dashboard dialog still reads/writes its
// GitHub connection there, while the PWA uses IndexedDB — without this bridge an
// app registered in one surface is invisible to the other and the user is asked
// to create a second GitHub App. The note body stays IndexedDB-only.
export const MIRRORED_KEYS = new Set([
  LEGACY_KEYS.preview, LEGACY_KEYS.app, LEGACY_KEYS.token, LEGACY_KEYS.repo,
  LEGACY_KEYS.path, LEGACY_KEYS.branch, LEGACY_KEYS.autosave, LEGACY_KEYS.shas
]);

// Wraps any store so mirrored settings/credentials converge with localStorage in
// both directions, in either order of use:
//   • writes go to IndexedDB AND localStorage (the dialog sees them immediately)
//   • reads fall back to localStorage and adopt the value into IndexedDB, so an
//     app created in the dialog is picked up even after the one-time migration ran
// Non-mirrored keys, notes and the outbox pass through untouched.
export function withLocalStorageMirror(baseStore, legacy = (typeof localStorage !== "undefined" ? localStorage : null)) {
  if (!legacy) return baseStore;
  const pass = (name, ...args) => baseStore[name](...args);
  return {
    async kvGet(key) {
      const own = await baseStore.kvGet(key);
      if (own !== null && own !== undefined) return own;
      if (MIRRORED_KEYS.has(key)) {
        const mirrored = legacy.getItem(key);
        if (mirrored !== null && mirrored !== undefined && mirrored !== "") {
          await baseStore.kvSet(key, mirrored); // adopt once, then IndexedDB owns it
          return mirrored;
        }
      }
      return own;
    },
    async kvSet(key, value) {
      await baseStore.kvSet(key, value);
      if (MIRRORED_KEYS.has(key)) {
        try { legacy.setItem(key, String(value)); } catch (error) { /* storage may be full/blocked */ }
      }
    },
    async kvDelete(key) {
      await baseStore.kvDelete(key);
      if (MIRRORED_KEYS.has(key)) {
        try { legacy.removeItem(key); } catch (error) { /* best effort */ }
      }
    },
    getNote: (...args) => pass("getNote", ...args),
    putNote: (...args) => pass("putNote", ...args),
    enqueueOutbox: (...args) => pass("enqueueOutbox", ...args),
    listOutbox: (...args) => pass("listOutbox", ...args),
    updateOutbox: (...args) => pass("updateOutbox", ...args),
    removeOutbox: (...args) => pass("removeOutbox", ...args),
    clearOutbox: (...args) => pass("clearOutbox", ...args)
  };
}

// One-time migration from the dashboard dialog's localStorage layout. Idempotent:
// a `migrated` marker means a returning PWA never overwrites itself with old data.
// Credential convergence beyond this first run is handled by withLocalStorageMirror.
export async function migrateLegacyStorage(store, legacy = (typeof localStorage !== "undefined" ? localStorage : null)) {
  if (!legacy || await store.kvGet("dash-scratchpad-migrated")) return { migrated: false };
  const snapshot = {};
  try {
    Object.values(LEGACY_KEYS).forEach(key => { snapshot[key] = legacy.getItem(key); });
  } catch (error) { return { migrated: false, error }; }
  const plan = planLegacyMigration(snapshot);
  for (const entry of plan.kvEntries) await store.kvSet(entry.key, entry.value);
  if (plan.noteBody) {
    const existing = await store.getNote(ACTIVE_NOTE_ID);
    if (!existing) {
      await store.putNote({
        id: ACTIVE_NOTE_ID,
        title: "Quick notes",
        body: plan.noteBody,
        repo: snapshot[LEGACY_KEYS.repo] || "",
        path: snapshot[LEGACY_KEYS.path] || "",
        branch: snapshot[LEGACY_KEYS.branch] || "",
        dirty: false
      });
    }
  }
  await store.kvSet("dash-scratchpad-migrated", "1");
  return { migrated: true, kvEntries: plan.kvEntries.length, noteCopied: Boolean(plan.noteBody) };
}
