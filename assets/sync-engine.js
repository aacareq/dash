// DOM-free GitHub sync orchestration for the Scratchpad PWA.
//
// All offline behavior lives here — conflict detection, the commit outbox and
// reconnect flushing — so it can run under Node tests without a browser. The
// page controller (scratchpad.js) owns the DOM and turns these result objects
// into status messages.

import { classifySyncError, nextOutboxAction, makeOutboxEntry } from "./notes-store.js";
import { normalizePath } from "./github-app.js";

export class SyncEngine {
  // store: notes-store adapter (kv + outbox); gh: GitHubAppClient
  constructor(store, gh) {
    this.store = store;
    this.gh = gh;
    this.saving = false;
    this.conflictPaused = false;
  }

  fileKey(repo, path, branch) {
    const cleanPath = normalizePath(path);
    return repo && cleanPath ? `${repo}@${branch || "default"}:${cleanPath}` : "";
  }

  // One save attempt. Never throws for expected sync conditions — the result's
  // status tells the UI what to say. Unexpected programmer errors still throw.
  async saveNote({ repo, path, branch = "", content, forced = false, auto = false }) {
    if (this.saving) return { status: "busy" };
    const connection = await this.gh.connection();
    if (!connection.ready) return { status: "disconnected" };
    if (!repo || !normalizePath(path)) return { status: "invalid-target" };

    const key = this.fileKey(repo, path, branch);
    this.saving = true;
    try {
      let remote;
      try {
        remote = await this.gh.readRepoFile(repo, path, branch);
      } catch (error) {
        if (classifySyncError(error) === "transient") {
          await this.#enqueue({ repo, path, branch, content, sha: null, reason: error.message });
          return { status: "queued", reason: error.message };
        }
        return { status: "error", error, kind: classifySyncError(error) };
      }

      const knownSha = await this.gh.storedSha(key);
      if (!forced && remote && remote.sha !== knownSha) {
        this.conflictPaused = true;
        return { status: "conflict", remote, knownSha, path, repo };
      }

      try {
        const result = await this.gh.writeRepoFile({
          repo, path, content,
          message: `Scratchpad notes — ${new Date().toISOString()}`,
          branch,
          sha: remote ? remote.sha : undefined
        });
        await this.gh.rememberSha(key, result.content?.sha || null);
        this.conflictPaused = false;
        // A direct save supersedes anything queued for the same file.
        for (const entry of await this.store.listOutbox()) {
          if (entry.repo === repo && entry.path === normalizePath(path)) {
            await this.store.removeOutbox(entry.id);
          }
        }
        return { status: remote ? "updated" : "created", path, repo, auto, sha: result.content?.sha || null };
      } catch (error) {
        const kind = classifySyncError(error);
        if (kind === "transient") {
          await this.#enqueue({ repo, path, branch, content, sha: remote?.sha || null, reason: error.message });
          return { status: "queued", reason: error.message };
        }
        if (kind === "conflict") {
          this.conflictPaused = true;
          return { status: "conflict", remote, knownSha, path, repo, error };
        }
        return { status: "error", error, kind };
      }
    } finally {
      this.saving = false;
    }
  }

  // Newest editor contents win; repeated offline edits of the same file collapse
  // into a single pending commit instead of a queue per keystroke.
  async #enqueue({ repo, path, branch, content, sha, reason }) {
    const pending = await this.store.listOutbox();
    const existing = pending.find(entry => entry.repo === repo && entry.path === normalizePath(path));
    if (existing) {
      await this.store.updateOutbox(existing.id, {
        content, sha, lastError: reason || "", branch: branch || existing.branch
      });
      return existing;
    }
    const entry = makeOutboxEntry({ repo, path, branch, content, sha, reason });
    await this.store.enqueueOutbox(entry);
    return entry;
  }

  // Drains the queue. Stops at the first network failure (everything behind it
  // would fail the same way) or at a conflict the user must resolve.
  async flush() {
    const entries = await this.store.listOutbox();
    if (!entries.length) return { status: "empty", delivered: 0 };
    const connection = await this.gh.connection();
    if (!connection.ready) return { status: "disconnected", pending: entries.length };

    let delivered = 0;
    for (const entry of entries) {
      let remote;
      try {
        remote = await this.gh.readRepoFile(entry.repo, entry.path, entry.branch);
      } catch (error) {
        if (classifySyncError(error) === "transient") {
          return { status: "offline", delivered, remaining: entries.length - delivered };
        }
        return { status: "error", error, entry };
      }

      if (nextOutboxAction(entry, remote) === "conflict") {
        this.conflictPaused = true;
        await this.store.updateOutbox(entry.id, {
          lastError: "File changed on GitHub — Pull latest or Overwrite anyway."
        });
        return { status: "conflict", entry, remote };
      }

      try {
        const result = await this.gh.writeRepoFile({
          repo: entry.repo,
          path: entry.path,
          content: entry.content,
          message: entry.message || `Scratchpad notes — ${new Date().toISOString()}`,
          branch: entry.branch,
          sha: remote ? remote.sha : undefined
        });
        await this.gh.rememberSha(
          this.fileKey(entry.repo, entry.path, entry.branch),
          result.content?.sha || null
        );
        await this.store.removeOutbox(entry.id);
        delivered += 1;
      } catch (error) {
        const kind = classifySyncError(error);
        await this.store.updateOutbox(entry.id, { attempts: entry.attempts + 1, lastError: error.message });
        if (kind === "transient") return { status: "offline", delivered, remaining: entries.length - delivered };
        return { status: "error", error, entry, kind };
      }
    }
    this.conflictPaused = false;
    return { status: "flushed", delivered };
  }

  // Reads GitHub's current copy without mutating anything; the UI confirms
  // before replacing editor contents.
  async pull({ repo, path, branch = "" }) {
    const connection = await this.gh.connection();
    if (!connection.ready) return { status: "disconnected" };
    if (!repo || !normalizePath(path)) return { status: "invalid-target" };
    const remote = await this.gh.readRepoFile(repo, path, branch);
    if (!remote) {
      await this.gh.rememberSha(this.fileKey(repo, path, branch), null);
      return { status: "missing", path, repo };
    }
    await this.gh.rememberSha(this.fileKey(repo, path, branch), remote.sha);
    return { status: "loaded", ...remote, path, repo };
  }
}
