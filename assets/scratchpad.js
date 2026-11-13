import { createNoteOutline } from "./note-template.js";
import { initPromptCreator } from "./prompt-creator.js";
import { initCapture } from "./capture.js";
// Scratchpad PWA — main controller.
//
// Standalone-page counterpart of the dashboard's scratchpad dialog, with:
//   • clear Local Device vs GitHub Repo storage indicators and quick Repo Auto-save toggle
//   • multi-note + folder workspace manager (Today's note, Today's folder, create files/dirs,
//     rename active file, rename directory locally and in GitHub)
//   • notes persist to IndexedDB (async, GB-scale) with one-time migration from dashboard localStorage
//   • an offline commit outbox drained on reconnect plus a manual Sync now button
//   • service worker registration with an update toast, PWA install prompt + iOS hint
//   • File System Access save/open where the browser supports it, downloads elsewhere

import { datedFileName } from "./markdown.js";
import { createEditor } from "./editor.js";
import { openStore, migrateLegacyStorage, withLocalStorageMirror, ACTIVE_NOTE_ID, LEGACY_KEYS } from "./notes-store.js";
import { GitHubAppClient, GH_KEYS, normalizePath, SCRATCH_REPO, connectionFileText, connectionFileName, parseConnectionInput, parsePrivateKey } from "./github-app.js";
import { SyncEngine } from "./sync-engine.js";
import {
  NoteManager,
  todayNoteFileName,
  todayFolderPath,
  todayFolderNotePath,
  normalizeWorkspacePath,
  parentFolderOf
} from "./notes-manager.js";
import { setupPwaInstall } from "./pwa-install.js";
import { isEmbedded } from "./environment.js";

const $ = id => document.getElementById(id);

function setStatus(id, message, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("is-error", tone === "error");
  el.classList.toggle("is-success", tone === "success");
}

function pulseElement(el, className = "is-pulsing", ms = 650) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  setTimeout(() => el.classList.remove(className), ms);
}

async function main() {
  // IndexedDB owns the data; the localStorage mirror keeps the dashboard dialog's
  // GitHub App connection and settings converged with this PWA (no re-registration).
  const baseStore = await openStore();
  const store = withLocalStorageMirror(baseStore);
  const migration = await migrateLegacyStorage(store);
  const gh = new GitHubAppClient(store);
  const engine = new SyncEngine(store, gh);
  const notes = new NoteManager(store);

  const textarea = $("scratchpad-text");
  const toolbar = document.querySelector(".md-toolbar");
  const preview = $("scratchpad-preview");
  const previewToggle = $("scratchpad-preview-toggle");

  // ---- load the last note, today's note, or the body migrated from the dialog --------
  const migrated = await store.getNote(ACTIVE_NOTE_ID);
  await notes.boot({ fallbackPath: todayNoteFileName(), initialBody: migrated?.body || undefined });
  let note = notes.current;
  // Manifest shortcut ("New note") lands with ?new=1 — start a fresh dated note.
  if (new URL(window.location.href).searchParams.get("new")) {
    note = await notes.newDatedNote();
  }
  textarea.value = note.body || "";
  initCapture({ root: $("scratchpad-capture"), textarea, target: () => notes.current?.path || notes.current?.title || "active note" });
  initPromptCreator({ root: $("scratchpad-prompt-creator"), textarea, target: () => notes.current?.path || "active note" });

  let localSaveTimer;
  let localSaving = false;
  let lastLocalSavedAt = note.updatedAt ? new Date(note.updatedAt) : null;
  let remoteWorkspace = { files: [], dirs: [], repo: "" };

  async function flushLocalSave() {
    clearTimeout(localSaveTimer);
    localSaving = false;
    note = await notes.setBody(textarea.value, { dirty: true });
    lastLocalSavedAt = new Date();
    paintStorageClarity();
    return note;
  }

  const persistLocal = () => {
    localSaving = true;
    note.dirty = true;
    paintStorageClarity();
    clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(async () => {
      localSaving = false;
      note = await notes.setBody(textarea.value, { dirty: true });
      lastLocalSavedAt = new Date();
      setStatus("scratchpad-status", "Saved on this device.", "success");
      paintStorageClarity();
      pulseElement($("scratchpad-local-state"), "is-pulsing");
      refreshWorkspaceList();
    }, 400);
  };

  const editor = createEditor({
    textarea,
    toolbar,
    preview,
    previewToggle,
    workerUrl: new URL("./markdown-worker.js", import.meta.url),
    previewPref: {
      get: () => store.kvGet(LEGACY_KEYS.preview),
      set: visible => store.kvSet(LEGACY_KEYS.preview, String(visible))
    },
    emojiElements: {
      button: $("scratchpad-emoji-btn"),
      picker: $("scratchpad-emoji-picker"),
      search: $("scratchpad-emoji-search"),
      list: $("scratchpad-emoji-list")
    },
    onInput: () => {
      persistLocal();
      ghSync?.handleLocalEdit();
    }
  });

  // ---- local-only actions -------------------------------------------------------------
  $("scratchpad-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      setStatus("scratchpad-status", "Copied all notes.", "success");
    } catch (error) {
      setStatus("scratchpad-status", "Couldn't access the clipboard — select and copy manually.", "error");
    }
  });

  const download = (extension, mime) => {
    const blob = new Blob([textarea.value], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scratchpad-${datedFileName().slice(6, 16)}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  $("scratchpad-export-txt")?.addEventListener("click", () => download("txt", "text/plain"));
  $("scratchpad-export-md")?.addEventListener("click", () => download("md", "text/markdown"));

  $("scratchpad-clear")?.addEventListener("click", () => {
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    editor.renderPreview();
  });

  // ---- File System Access (Chromium desktop); download/upload fallback elsewhere ------
  let fileHandle = null;
  const fsSupported = typeof window.showSaveFilePicker === "function";
  if (!fsSupported) $("fs-unsupported")?.classList.remove("hidden");

  $("scratchpad-save-file")?.addEventListener("click", async () => {
    if (!fsSupported) { download("md", "text/markdown"); return; }
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: datedFileName().replace(/^notes-/, "scratchpad-"),
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }]
      });
      const writable = await fileHandle.createWritable();
      await writable.write(textarea.value);
      await writable.close();
      setStatus("scratchpad-status", `Written to ${fileHandle.name}.`, "success");
    } catch (error) {
      if (error.name !== "AbortError") setStatus("scratchpad-status", error.message, "error");
    }
  });

  $("scratchpad-open-file")?.addEventListener("click", async () => {
    if (!fsSupported) {
      $("scratchpad-file-input")?.click();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Markdown or text", accept: { "text/markdown": [".md", ".txt"] } }]
      });
      fileHandle = handle;
      const file = await handle.getFile();
      textarea.value = await file.text();
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      editor.renderPreview();
      setStatus("scratchpad-status", `Opened ${file.name}.`, "success");
    } catch (error) {
      if (error.name !== "AbortError") setStatus("scratchpad-status", error.message, "error");
    }
  });

  $("scratchpad-file-input")?.addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      textarea.value = String(reader.result || "");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      editor.renderPreview();
    };
    reader.readAsText(file);
  });

  // ---- DOM references: Clarity strip, Workspace manager, Filebar, GitHub sheet --------
  const localDot = $("scratchpad-local-dot");
  const localSummary = $("scratchpad-local-summary");
  const localStateBadge = $("scratchpad-local-state");
  const repoPill = $("scratchpad-repo-pill");
  const repoDot = $("scratchpad-repo-dot");
  const repoSummary = $("scratchpad-repo-summary");
  const quickAutosaveBtn = $("scratchpad-quick-autosave");
  const quickSaveBtn = $("scratchpad-quick-save");
  const quickPullBtn = $("scratchpad-quick-pull");

  const todayFolderBtn = $("note-today-folder");
  const filesToggleBtn = $("scratchpad-files-toggle");
  const filesCountBadge = $("scratchpad-files-count");
  const renameFileOpenBtn = $("scratchpad-rename-file-open");
  const renameDirOpenBtn = $("scratchpad-rename-dir-open");
  const filebarRenameBtn = $("scratchpad-filebar-rename");

  const wsPanel = $("scratchpad-workspace-panel");
  const wsCloseBtn = $("scratchpad-workspace-close");
  const wsExplorer = $("scratchpad-ws-explorer");
  const wsCreateCard = $("scratchpad-ws-create");
  const wsRenameCard = $("scratchpad-ws-rename");
  const wsRefreshBtn = $("scratchpad-ws-refresh");
  const wsFilterInput = $("scratchpad-ws-filter");
  const wsListEl = $("scratchpad-ws-list");
  const wsDirsList = $("scratchpad-ws-dirs-list");
  const wsTodayNoteBtn = $("scratchpad-ws-today-note");
  const wsTodayFolderBtn = $("scratchpad-ws-today-folder");
  const wsTodayInFolderBtn = $("scratchpad-ws-today-in-folder");
  const wsFileDirInput = $("scratchpad-ws-file-dir");
  const wsFillTodayDirBtn = $("scratchpad-ws-fill-today-dir");
  const wsFileNameInput = $("scratchpad-ws-file-name");
  const wsFileExtSelect = $("scratchpad-ws-file-ext");
  const wsFilePreview = $("scratchpad-ws-file-preview");
  const wsCreateBlankBtn = $("scratchpad-ws-create-blank");
  const wsCreateFromCurrentBtn = $("scratchpad-ws-create-from-current");
  const wsNewDirInput = $("scratchpad-ws-new-dir");
  const wsFillTodayFolderBtn = $("scratchpad-ws-fill-today-folder");
  const wsDirPreview = $("scratchpad-ws-dir-preview");
  const wsCreateDirBtn = $("scratchpad-ws-create-dir");
  const renameFileCurrent = $("scratchpad-rename-file-current");
  const renameFileInput = $("scratchpad-rename-file-input");
  const renameFilePreview = $("scratchpad-rename-file-preview");
  const renameFileBtn = $("scratchpad-rename-file-btn");
  const renameDirFromInput = $("scratchpad-rename-dir-from");
  const renameDirToInput = $("scratchpad-rename-dir-to");
  const renameDirPreview = $("scratchpad-rename-dir-preview");
  const renameDirBtn = $("scratchpad-rename-dir-btn");

  const panel = $("scratchpad-gh-panel");
  const ghOpenBtn = $("scratchpad-gh-open");
  const ghCloseBtn = $("scratchpad-gh-close");
  const ghLaunchBadge = $("scratchpad-gh-launch");
  const menuBtn = $("scratchpad-menu-btn");
  const actionMenu = $("scratchpad-menu");
  const clockEl = $("scratchpad-clock");
  const newPathInput = $("scratchpad-gh-new-path");
  const newTypeSelect = $("scratchpad-gh-new-type");
  const createFileBtn = $("scratchpad-gh-create-file");
  const newFolderInput = $("scratchpad-gh-new-folder");
  const createFolderBtn = $("scratchpad-gh-create-folder");
  const setupBtn = $("scratchpad-gh-setup");
  const installBtn = $("scratchpad-gh-install");
  const checkBtn = $("scratchpad-gh-check");
  const forgetBtn = $("scratchpad-gh-forget");
  const accountBadge = $("scratchpad-gh-account");
  const hint = $("scratchpad-gh-hint");
  const target = $("scratchpad-gh-target");
  const repoSelect = $("scratchpad-gh-repo");
  const pathInput = $("scratchpad-gh-path");
  const branchInput = $("scratchpad-gh-branch");
  const saveBtn = $("scratchpad-gh-save");
  const pullBtn = $("scratchpad-gh-pull");
  const overwriteBtn = $("scratchpad-gh-overwrite");
  const autosaveCheckbox = $("scratchpad-gh-autosave");
  const tokenInput = $("scratchpad-gh-token");
  const tokenSaveBtn = $("scratchpad-gh-token-save");
  const tokenClearBtn = $("scratchpad-gh-token-clear");
  const newFileBtn = $("scratchpad-gh-new-file");
  const scratchBtn = $("scratchpad-gh-scratch");
  const repoHelp = $("scratchpad-gh-repo-help");
  const exportBtn = $("scratchpad-gh-export");
  const keepNote = $("scratchpad-gh-keep");
  const restoreDetails = $("scratchpad-gh-restore");
  const restoreFileInput = $("scratchpad-gh-restore-file");
  const restoreAppIdInput = $("scratchpad-gh-restore-app-id");
  const restorePemInput = $("scratchpad-gh-restore-pem");
  const restoreGoBtn = $("scratchpad-gh-restore-go");
  const filebarRepo = $("scratchpad-filebar-repo");
  const filebarSep = $("scratchpad-filebar-sep");
  const filebarFile = $("scratchpad-filebar-file");
  const filebarState = $("scratchpad-filebar-state");
  const outboxCount = $("outbox-count");
  const syncNowBtn = $("scratchpad-sync-now");

  let ghSaveTimer;
  let reposLoaded = false;
  let scratchAttempted = false;
  let barState = { text: "Saved on this device", tone: "" };
  let lastConnectionState = { kind: "none", ready: false };
  let pendingOutboxTotal = 0;

  const setGhStatus = (message, tone) => setStatus("scratchpad-gh-status", message, tone);
  const setFileStatus = (message, tone) => setStatus("scratchpad-gh-file-status", message, tone);
  const setRestoreStatus = (message, tone) => setStatus("scratchpad-gh-restore-status", message, tone);
  const setWsStatus = (message, tone) => setStatus("scratchpad-ws-status", message, tone);

  function openGhModal() {
    if (!panel || panel.open) return;
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", "");
  }

  let restoreFileText = "";

  function setBarState(text, tone = "") {
    barState = { text, tone };
    paintFileBar();
  }

  function paintFileBar() {
    if (!filebarRepo) return;
    const repo = repoSelect?.value || "";
    const path = normalizePath(pathInput?.value);
    filebarRepo.textContent = repo || "Local only";
    filebarRepo.title = repo ? repo : "Notes are kept in this browser until GitHub saving is set up";
    if (filebarSep) filebarSep.hidden = !repo;
    if (filebarFile) { filebarFile.textContent = path || "—"; filebarFile.title = path || ""; }
    if (filebarState) {
      filebarState.textContent = barState.text;
      filebarState.classList.toggle("is-saved", barState.tone === "success");
      filebarState.classList.toggle("is-error", barState.tone === "error");
    }
    if (renameFileCurrent) renameFileCurrent.textContent = note?.path || path || "—";
  }

  function paintStorageClarity() {
    const timeLabel = lastLocalSavedAt
      ? lastLocalSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

    if (localSaving) {
      if (localDot) {
        localDot.classList.remove("is-local-ok");
        localDot.classList.add("is-saving");
      }
      if (localSummary) localSummary.textContent = "Saving on this device…";
      if (localStateBadge) {
        localStateBadge.textContent = "💾 Local: Saving…";
        localStateBadge.classList.add("is-saving");
      }
    } else {
      if (localDot) {
        localDot.classList.remove("is-saving");
        localDot.classList.add("is-local-ok");
      }
      if (localSummary) {
        localSummary.textContent = timeLabel ? `Autosaved locally · ${timeLabel}` : "Autosaves locally";
      }
      if (localStateBadge) {
        localStateBadge.textContent = "💾 Local: Saved";
        localStateBadge.classList.remove("is-saving");
      }
    }

    const repo = repoSelect?.value || "";
    const connected = Boolean(lastConnectionState.ready && repo);
    if (quickSaveBtn) quickSaveBtn.hidden = !connected;
    if (quickPullBtn) quickPullBtn.hidden = !connected;

    if (repoPill && repoDot && repoSummary) {
      repoPill.classList.remove("is-connected", "is-warning");
      repoDot.classList.remove("is-connected", "is-warning", "is-error");
      if (!connected) {
        repoSummary.textContent = lastConnectionState.kind === "app" && !lastConnectionState.installationId
          ? "Finish installing GitHub App to sync"
          : "Local only (not connected)";
      } else if (pendingOutboxTotal > 0) {
        repoPill.classList.add("is-warning");
        repoDot.classList.add("is-warning");
        repoSummary.textContent = `${repo} · ${pendingOutboxTotal} commit${pendingOutboxTotal === 1 ? "" : "s"} queued offline`;
      } else if (note?.dirty) {
        repoPill.classList.add("is-warning");
        repoDot.classList.add("is-warning");
        repoSummary.textContent = `${repo} · Local edits not synced yet`;
      } else {
        repoPill.classList.add("is-connected");
        repoDot.classList.add("is-connected");
        repoSummary.textContent = `${repo} · Synced`;
      }
    }

    if (quickAutosaveBtn && autosaveCheckbox) {
      const enabled = autosaveCheckbox.checked;
      quickAutosaveBtn.setAttribute("aria-pressed", String(enabled));
      quickAutosaveBtn.classList.toggle("is-on", enabled);
      quickAutosaveBtn.textContent = enabled
        ? (connected ? "⚡ Repo auto-save: ON" : "⚡ Repo auto-save: ON (when connected)")
        : "⏸ Repo auto-save: OFF";
    }
  }

  const showOverwrite = visible => { if (overwriteBtn) overwriteBtn.hidden = !visible; };
  const showRepoHelp = html => { if (!repoHelp) return; repoHelp.hidden = !html; repoHelp.innerHTML = html || ""; };

  const HAS_EXTENSION = /\.[a-z0-9]{1,8}$/i;
  function pathWithExtension(value, extension) {
    const path = normalizePath(value);
    if (!path) return "";
    if (!extension || HAS_EXTENSION.test(path.split("/").pop())) return path;
    return `${path}.${extension}`;
  }

  function computeWorkspaceTargetPath() {
    const dirRaw = wsFileDirInput?.value.trim() || "";
    const nameRaw = wsFileNameInput?.value.trim() || "";
    const ext = wsFileExtSelect?.value ?? "md";
    if (!nameRaw) return "";
    const combined = dirRaw ? `${dirRaw}/${nameRaw}` : nameRaw;
    const clean = normalizeWorkspacePath(combined);
    return pathWithExtension(clean, ext);
  }

  function updateWorkspacePreviews() {
    if (wsFilePreview) {
      try {
        const preview = computeWorkspaceTargetPath();
        wsFilePreview.innerHTML = preview
          ? `Will create: <strong></strong>`
          : `Enter a file name (e.g. <strong>standup</strong> or <strong>${todayNoteFileName()}</strong>)`;
        if (preview) wsFilePreview.querySelector("strong").textContent = preview;
      } catch (err) {
        wsFilePreview.textContent = err.message;
      }
    }
    if (wsDirPreview) {
      try {
        const cleanDir = wsNewDirInput?.value.trim() ? normalizeWorkspacePath(wsNewDirInput.value) : "";
        wsDirPreview.innerHTML = cleanDir
          ? `Folder path: <strong></strong>`
          : `Today's folder: <strong>${todayFolderPath()}</strong>`;
        if (cleanDir) wsDirPreview.querySelector("strong").textContent = cleanDir;
      } catch (err) {
        wsDirPreview.textContent = err.message;
      }
    }
    if (renameFilePreview) {
      try {
        const targetName = renameFileInput?.value.trim() ? normalizeWorkspacePath(renameFileInput.value) : "";
        if (!targetName) {
          renameFilePreview.textContent = "Enter a new name or path to preview rename";
        } else {
          renameFilePreview.innerHTML = `<strong></strong> → <strong></strong>`;
          const strongs = renameFilePreview.querySelectorAll("strong");
          strongs[0].textContent = note?.path || "—";
          strongs[1].textContent = targetName;
        }
      } catch (err) {
        renameFilePreview.textContent = err.message;
      }
    }
    if (renameDirPreview) {
      try {
        const fromDir = renameDirFromInput?.value.trim() ? normalizeWorkspacePath(renameDirFromInput.value) : "";
        const toDir = renameDirToInput?.value.trim() ? normalizeWorkspacePath(renameDirToInput.value) : "";
        if (!fromDir || !toDir) {
          renameDirPreview.textContent = "Choose an existing folder and enter its new name";
        } else {
          renameDirPreview.innerHTML = `📁 <strong></strong> → 📁 <strong></strong>`;
          const strongs = renameDirPreview.querySelectorAll("strong");
          strongs[0].textContent = fromDir;
          strongs[1].textContent = toDir;
        }
      } catch (err) {
        renameDirPreview.textContent = err.message;
      }
    }
  }

  // Puts a NoteManager record in front of the user: editor, target path, file
  // bar and preview all follow the active note, so every save targets its file.
  const noteCurrentLabel = $("note-current");
  async function switchNote(next, message) {
    note = next;
    textarea.value = note.body || "";
    pathInput.value = note.path;
    if (note.branch) branchInput.value = note.branch;
    await store.kvSet(GH_KEYS.path, note.path);
    engine.conflictPaused = false;
    showOverwrite(false);
    paintFileBar();
    paintStorageClarity();
    editor.renderPreview();
    if (noteCurrentLabel) noteCurrentLabel.textContent = note.path;
    if (renameFileInput && document.activeElement !== renameFileInput) {
      renameFileInput.value = note.path;
    }
    updateWorkspacePreviews();
    await refreshWorkspaceList();
    if (message) setStatus("scratchpad-status", message, "success");
    textarea.focus();
  }
  if (noteCurrentLabel) noteCurrentLabel.textContent = note.path;

  async function refreshWorkspaceList() {
    if (!wsListEl) return;
    const localNotes = await notes.list();
    const localFolders = await notes.listFolders();
    const activeRepo = repoSelect?.value || "";
    const hasRemote = Boolean(lastConnectionState.ready && activeRepo && remoteWorkspace.repo === activeRepo);

    const allDirs = new Set(localFolders);
    if (hasRemote) {
      remoteWorkspace.dirs.forEach(d => allDirs.add(d));
    }

    const noteMap = new Map();
    for (const item of localNotes) {
      noteMap.set(item.path, {
        path: item.path,
        local: true,
        dirty: Boolean(item.dirty),
        syncedAt: item.syncedAt || 0,
        remote: hasRemote && remoteWorkspace.files.some(f => f.path === item.path),
        updatedAt: item.updatedAt || 0
      });
    }
    if (hasRemote) {
      for (const file of remoteWorkspace.files) {
        if (file.path.endsWith("/.gitkeep") || file.path === ".gitkeep") continue;
        if (!noteMap.has(file.path)) {
          noteMap.set(file.path, {
            path: file.path,
            local: false,
            dirty: false,
            syncedAt: 1,
            remote: true,
            updatedAt: 0
          });
        }
      }
    }

    const totalNotes = noteMap.size;
    if (filesCountBadge) filesCountBadge.textContent = String(totalNotes || 1);

    if (wsDirsList) {
      wsDirsList.replaceChildren();
      [...allDirs].sort().forEach(dir => {
        const option = document.createElement("option");
        option.value = dir;
        wsDirsList.appendChild(option);
      });
    }

    const query = (wsFilterInput?.value || "").trim().toLowerCase();
    const sortedDirs = [...allDirs].sort().filter(d => !query || d.toLowerCase().includes(query));
    const sortedNotes = [...noteMap.values()]
      .filter(n => !query || n.path.toLowerCase().includes(query))
      .sort((a, b) => {
        if (a.path === note?.path) return -1;
        if (b.path === note?.path) return 1;
        if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
        return a.path.localeCompare(b.path);
      });

    wsListEl.replaceChildren();

    if (sortedDirs.length) {
      const folderHeading = document.createElement("div");
      folderHeading.className = "ws-mini-label";
      folderHeading.textContent = `Folders (${sortedDirs.length})`;
      wsListEl.appendChild(folderHeading);

      for (const dir of sortedDirs) {
        const row = document.createElement("div");
        row.className = "ws-item ws-item-folder";
        row.setAttribute("role", "listitem");

        const icon = document.createElement("span");
        icon.textContent = "📁";
        icon.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "ws-item-path";
        label.textContent = dir;
        label.title = dir;

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "ws-chip-btn";
        addBtn.textContent = "+ File";
        addBtn.title = `Prepare a new file inside ${dir}`;
        addBtn.addEventListener("click", () => {
          if (wsFileDirInput) wsFileDirInput.value = dir;
          updateWorkspacePreviews();
          wsFileNameInput?.focus();
        });

        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "ws-chip-btn";
        renameBtn.textContent = "Rename";
        renameBtn.title = `Rename folder ${dir}`;
        renameBtn.addEventListener("click", () => {
          if (renameDirFromInput) renameDirFromInput.value = dir;
          updateWorkspacePreviews();
          renameDirToInput?.focus();
          pulseElement(wsRenameCard, "is-pulsing");
        });

        row.append(icon, label, addBtn, renameBtn);
        wsListEl.appendChild(row);
      }
    }

    const notesHeading = document.createElement("div");
    notesHeading.className = "ws-mini-label";
    notesHeading.style.marginTop = sortedDirs.length ? ".35rem" : "0";
    notesHeading.textContent = `Files (${sortedNotes.length})`;
    wsListEl.appendChild(notesHeading);

    if (!sortedNotes.length) {
      const empty = document.createElement("p");
      empty.className = "modal-hint";
      empty.textContent = query ? `No files or folders match "${query}".` : "No files yet.";
      wsListEl.appendChild(empty);
      return;
    }

    for (const entry of sortedNotes) {
      const isActive = entry.path === note?.path;
      const row = document.createElement("div");
      row.className = `ws-item${isActive ? " is-active" : ""}`;
      row.setAttribute("role", "listitem");

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ws-item-open";
      openBtn.title = isActive ? `Active file: ${entry.path}` : `Open ${entry.path}`;
      const fileIcon = document.createElement("span");
      fileIcon.textContent = isActive ? "📝" : "📄";
      fileIcon.setAttribute("aria-hidden", "true");
      const fileLabel = document.createElement("span");
      fileLabel.className = "ws-item-path";
      fileLabel.textContent = entry.path;
      openBtn.append(fileIcon, fileLabel);
      openBtn.addEventListener("click", async () => {
        if (isActive) { textarea.focus(); return; }
        await flushLocalSave();
        if (entry.local) {
          const next = await notes.switchTo(entry.path);
          await switchNote(next, `Switched to ${entry.path}.`);
          return;
        }
        // Remote-only note discovered via GitHub tree refresh: pull it locally and open it.
        const repo = repoSelect?.value || "";
        const branch = branchInput?.value.trim() || "";
        setWsStatus(`Loading ${entry.path} from ${repo}…`);
        try {
          const remote = await gh.readRepoFile(repo, entry.path, branch);
          if (!remote) {
            setWsStatus(`${entry.path} was not found in ${repo}.`, "error");
            return;
          }
          await gh.rememberSha(engine.fileKey(repo, entry.path, branch), remote.sha);
          const next = await notes.switchTo(entry.path, { repo, branch, initialBody: remote.content });
          await notes.markSynced(entry.path);
          await switchNote(next, `Opened ${entry.path} from ${repo}.`);
          setWsStatus(`Opened ${entry.path}.`, "success");
        } catch (error) {
          setWsStatus(error.message, "error");
        }
      });

      const badge = document.createElement("span");
      badge.className = "ws-badge";
      if (isActive) {
        badge.classList.add("is-active");
        badge.textContent = "Active";
      } else if (entry.remote && !entry.local) {
        badge.classList.add("is-repo");
        badge.textContent = "Repo";
      } else if (entry.local && lastConnectionState.ready && entry.dirty) {
        badge.classList.add("is-local");
        badge.textContent = "Unsynced";
      } else if (entry.local && entry.syncedAt && !entry.dirty) {
        badge.classList.add("is-repo");
        badge.textContent = "Synced";
      } else {
        badge.classList.add("is-local");
        badge.textContent = "Device";
      }

      row.append(openBtn, badge);
      if (isActive) {
        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "ws-chip-btn";
        renameBtn.textContent = "Rename";
        renameBtn.addEventListener("click", () => {
          if (renameFileInput) renameFileInput.value = entry.path;
          updateWorkspacePreviews();
          renameFileInput?.focus();
          renameFileInput?.select();
          pulseElement(wsRenameCard, "is-pulsing");
        });
        row.appendChild(renameBtn);
      }
      wsListEl.appendChild(row);
    }
  }

  async function refreshRemoteWorkspace({ announce = false } = {}) {
    const repo = repoSelect?.value || "";
    if (!lastConnectionState.ready || !repo) {
      remoteWorkspace = { files: [], dirs: [], repo: "" };
      await refreshWorkspaceList();
      if (announce) setWsStatus("Showing files saved on this device. Connect a GitHub repo to load remote files too.");
      return;
    }
    if (announce) setWsStatus(`Refreshing files and folders from ${repo}…`);
    const branch = branchInput?.value.trim() || "";
    const tree = await engine.listWorkspace({ repo, branch });
    if (tree.status === "loaded") {
      remoteWorkspace = { files: tree.files || [], dirs: tree.dirs || [], repo };
      await refreshWorkspaceList();
      if (announce) {
        setWsStatus(`Loaded ${remoteWorkspace.files.length} file${remoteWorkspace.files.length === 1 ? "" : "s"} and ${remoteWorkspace.dirs.length} folder${remoteWorkspace.dirs.length === 1 ? "" : "s"} from ${repo}.`, "success");
      }
    } else if (announce && tree.error) {
      setWsStatus(`Could not load repo tree: ${tree.error.message}`, "error");
    }
  }

  function openWorkspacePanel({ focusTarget = null, sectionCard = null } = {}) {
    if (!wsPanel) return;
    wsPanel.hidden = false;
    filesToggleBtn?.setAttribute("aria-expanded", "true");
    filesToggleBtn?.classList.add("is-open");
    if (renameFileCurrent) renameFileCurrent.textContent = note?.path || "—";
    if (renameFileInput && !renameFileInput.value) renameFileInput.value = note?.path || "";
    updateWorkspacePreviews();
    refreshWorkspaceList();
    if (sectionCard) pulseElement(sectionCard, "is-pulsing");
    if (focusTarget) {
      focusTarget.focus();
      if (typeof focusTarget.select === "function") focusTarget.select();
    }
  }

  function closeWorkspacePanel() {
    if (!wsPanel) return;
    wsPanel.hidden = true;
    filesToggleBtn?.setAttribute("aria-expanded", "false");
    filesToggleBtn?.classList.remove("is-open");
  }

  async function render() {
    const connection = await gh.connection();
    lastConnectionState = connection;
    const secure = gh.cryptoReady();
    setupBtn.hidden = connection.kind !== "none";
    installBtn.hidden = !(connection.kind === "app" && !connection.installationId);
    checkBtn.hidden = !(connection.kind === "app" && connection.installationId);
    forgetBtn.hidden = connection.kind === "none";
    tokenClearBtn.hidden = connection.kind !== "token";
    target.hidden = !connection.ready;
    scratchBtn.hidden = !connection.ready;
    if (exportBtn) exportBtn.hidden = connection.kind !== "app";
    if (keepNote) keepNote.hidden = !(connection.kind === "app" && !connection.app.connection_saved_at);

    if (ghLaunchBadge) {
      ghLaunchBadge.textContent = connection.kind === "app"
        ? (connection.installationId ? "connected" : "install")
        : connection.kind === "token" ? "token" : "";
      ghLaunchBadge.classList.toggle("is-connected", connection.kind === "app" && Boolean(connection.installationId));
    }

    if (connection.kind === "app") {
      accountBadge.textContent = connection.installationId
        ? `Connected${connection.label ? ` — ${connection.label}` : ""}`
        : `App registered${connection.app.owner ? ` as @${connection.app.owner}` : ""} — not installed yet`;
      accountBadge.classList.toggle("is-connected", Boolean(connection.installationId));
    } else if (connection.kind === "token") {
      accountBadge.textContent = `Using a pasted token${connection.label ? ` (@${connection.label})` : ""}`;
      accountBadge.classList.add("is-connected");
    } else {
      accountBadge.textContent = "";
      accountBadge.classList.remove("is-connected");
    }

    if (hint) {
      if (!secure) {
        hint.textContent = "GitHub can only redirect back to a page served over http(s) — open the live PWA (or a local server) to set up saving. Meanwhile you can paste a token under Advanced.";
      } else if (connection.kind === "none") {
        hint.textContent = "First visit here? Nothing to copy or paste: one click registers a private GitHub App owned by you, then you pick the repo it may write to. Already made that app on another browser or address? Use Reconnect below — there's no need to create a second one.";
      } else if (connection.kind === "app" && !connection.installationId) {
        hint.textContent = "Last step: choose which repositories the app may write to. GitHub then sends you back here automatically.";
      } else {
        hint.textContent = "Connected. Notes are committed with short-lived installation tokens minted on this device — no sign-in, no stored long-lived credential.";
      }
    }
    paintFileBar();
    paintStorageClarity();
    if (connection.ready && !reposLoaded) await loadRepos();
    await refreshOutboxBadge();
    await refreshWorkspaceList();
  }

  async function scratchRepoFullName() {
    return gh.scratchRepoFullName();
  }

  async function renderRepoOptions(repos) {
    const previous = await store.kvGet(GH_KEYS.repo) || repoSelect.value;
    const scratchEntry = repos.find(repo => repo.name === SCRATCH_REPO) || null;
    const scratchValue = scratchEntry ? scratchEntry.full_name : await scratchRepoFullName();

    repoSelect.replaceChildren();
    if (!repos.length) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "No repositories yet — Use scratch repo creates one";
      repoSelect.appendChild(placeholder);
    }
    repos.forEach(repo => {
      const option = document.createElement("option");
      option.value = repo.full_name;
      option.textContent = repo.name === SCRATCH_REPO ? `${repo.full_name} (default)` : repo.full_name;
      repoSelect.appendChild(option);
    });
    if (scratchValue && !repos.some(repo => repo.full_name === scratchValue)) {
      const option = document.createElement("option");
      option.value = scratchValue;
      option.textContent = `${scratchValue} (default)`;
      repoSelect.insertBefore(option, repoSelect.firstChild);
    }
    repoSelect.value = scratchValue || "";
    if (!repoSelect.value) {
      const match = repos.find(repo => repo.full_name === previous);
      repoSelect.value = match ? match.full_name : (repos.length ? repos[0].full_name : "");
    }
    if (repoSelect.value) await store.kvSet(GH_KEYS.repo, repoSelect.value);
    return { scratch: Boolean(scratchEntry), scratchValue: repoSelect.value || scratchValue };
  }

  async function loadRepos({ announce = false, createScratch = true } = {}) {
    let hasScratch = false;
    try {
      const repos = await gh.listRepositories();
      const result = await renderRepoOptions(repos);
      hasScratch = Boolean(result && result.scratch);
      reposLoaded = true;
      paintFileBar();
      paintStorageClarity();
      if (hasScratch) showRepoHelp("");
      if (announce) setGhStatus(`${repos.length} repositor${repos.length === 1 ? "y" : "ies"} available to this app.`, "success");
      else if (!repos.length) setGhStatus("No repositories are available yet — the app can create one for you.", "");
    } catch (error) {
      setGhStatus(error.message, "error");
      return;
    }
    if (!hasScratch && createScratch) await ensureScratchRepo({ automatic: true });
    if (repoSelect?.value) refreshRemoteWorkspace().catch(() => {});
  }

  async function ensureScratchRepo({ automatic = false } = {}) {
    const connection = await gh.connection();
    if (!connection.ready) return;
    if (automatic && scratchAttempted) return;
    scratchAttempted = true;
    setGhStatus(`Creating a private “${SCRATCH_REPO}” repository…`);
    showRepoHelp("");
    const result = await gh.ensureScratchRepo();
    if (!result.ok) {
      const error = result.error;
      const app = await gh.readApp();
      const slug = app && (app.slug || app.name);
      const settingsUrl = slug ? `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions` : "https://github.com/settings/apps";
      const newRepoUrl = "https://github.com/new?name=" + encodeURIComponent(SCRATCH_REPO) + "&private=1";
      const alreadyExists = error.status === 422 && /already exists/i.test(error.message);
      const usableRepo = repoSelect?.value;
      if (alreadyExists) {
        setGhStatus(`A repository named “${SCRATCH_REPO}” already exists but this app can't see it. Add it to the app's installation, then click Re-check connection.${usableRepo ? ` Saving to ${usableRepo} still works.` : ""}`, "error");
      } else if (automatic && usableRepo) {
        setGhStatus(`Tip: the “${SCRATCH_REPO}” repo wasn't found and the app couldn't create it (${error.message}). Notes still save to ${usableRepo}.`);
      } else {
        setGhStatus(`GitHub wouldn't let the app create the “${SCRATCH_REPO}” repo (${error.message}).`, "error");
      }
      showRepoHelp(
        `To let the app make its own <code>${SCRATCH_REPO}</code> repo: grant <strong>Repository creation: write</strong> in ` +
        `<a href="${settingsUrl}" target="_blank" rel="noopener noreferrer">the app's permissions</a> and accept it on the installation — ` +
        `or <a href="${newRepoUrl}" target="_blank" rel="noopener noreferrer">create “${SCRATCH_REPO}” yourself</a> and add it to the app. ` +
        `Then click <strong>Re-check connection</strong>.`
      );
      return;
    }
    const fullName = result.repo;
    await store.kvSet(GH_KEYS.repo, fullName);
    reposLoaded = false;
    await loadRepos({ createScratch: false });
    if (![...repoSelect.options].some(option => option.value === fullName)) {
      const option = document.createElement("option");
      option.value = fullName;
      option.textContent = fullName;
      repoSelect.appendChild(option);
    }
    repoSelect.value = fullName;
    paintFileBar();
    paintStorageClarity();
    setGhStatus(`Ready — notes are saved to the private “${SCRATCH_REPO}” repo (${fullName}).`, "success");
    showRepoHelp("");
  }

  function targetIsValid({ quiet = false } = {}) {
    const repo = repoSelect.value;
    const path = normalizePath(pathInput.value);
    if (!repo || !path) {
      if (!quiet) setFileStatus("Choose a repository and file path first.", "error");
      return false;
    }
    return true;
  }

  // ---- outbox: commits attempted while offline ----------------------------------------
  async function refreshOutboxBadge() {
    const entries = await store.listOutbox();
    pendingOutboxTotal = entries.length;
    if (outboxCount) {
      outboxCount.textContent = entries.length ? `${entries.length} pending` : "";
      outboxCount.classList.toggle("hidden", !entries.length);
    }
    syncNowBtn?.classList.toggle("has-pending", entries.length > 0);
    paintStorageClarity();
  }

  async function flushOutbox({ announce = false } = {}) {
    const result = await engine.flush();
    await refreshOutboxBadge();
    const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (result.status === "empty") {
      if (announce) setFileStatus("Nothing pending — everything is already on GitHub.", "");
      return;
    }
    if (result.status === "disconnected") {
      if (announce) setFileStatus("Connect GitHub first — pending commits stay on this device.", "error");
      return;
    }
    if (result.status === "offline") {
      setBarState("Still offline — keeping commits queued", "error");
      return;
    }
    if (result.status === "conflict") {
      showOverwrite(true);
      setFileStatus(`Pending commit for ${result.entry.path} is paused: the file changed on GitHub. Pull latest or Overwrite anyway.`, "error");
      return;
    }
    if (result.status === "error") {
      setFileStatus(`Pending commit failed: ${result.error.message}`, "error");
      return;
    }
    if (note) await notes.markSynced(note.path);
    setBarState(`Synced to GitHub · ${now()}`, "success");
    setFileStatus(`Delivered ${result.delivered} pending commit${result.delivered === 1 ? "" : "s"}.`, "success");
    paintStorageClarity();
    await refreshWorkspaceList();
  }

  async function saveNotes({ forced = false, auto = false } = {}) {
    if (engine.saving) return;
    if (!targetIsValid()) { openGhModal(); return; }
    await flushLocalSave();
    const repo = repoSelect.value;
    const path = normalizePath(pathInput.value);
    const branch = branchInput.value.trim();
    if (!auto) {
      setFileStatus("Checking the file hasn't changed on GitHub…");
      setStatus("scratchpad-status", `Saving ${path} to ${repo}…`);
    }
    saveBtn.disabled = true;
    if (quickSaveBtn) quickSaveBtn.disabled = true;
    try {
      const result = await engine.saveNote({ repo, path, branch, content: textarea.value, forced, auto });
      const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      switch (result.status) {
        case "disconnected":
          openGhModal();
          setFileStatus("Connect GitHub first.", "error");
          break;
        case "invalid-target":
          setFileStatus("Choose a repository and file path first.", "error");
          break;
        case "busy":
          break;
        case "conflict":
          showOverwrite(true);
          setFileStatus(
            result.knownSha
              ? `${path} changed on GitHub since the last sync. Pull latest to bring that version in, or Overwrite anyway.`
              : `${path} already exists in ${repo}. Pull latest to load it, or Overwrite anyway to replace it.`,
            "error"
          );
          setStatus("scratchpad-status", `${path} changed on GitHub — open GitHub sync to Pull latest or Overwrite.`, "error");
          break;
        case "queued":
          await refreshOutboxBadge();
          setFileStatus("No connection right now — the commit is queued and will send when you're back online.", "");
          setStatus("scratchpad-status", "Saved on this device; queued for GitHub when online.");
          setBarState("Offline — saved here, queued for GitHub", "error");
          break;
        case "created":
        case "updated":
          showOverwrite(false);
          note.dirty = false;
          await notes.markSynced(path);
          await refreshOutboxBadge();
          setFileStatus(`${result.status === "updated" ? "Updated" : "Created"} ${path} in ${repo} at ${new Date().toLocaleTimeString()}${auto ? " (autosave)" : ""}.`, "success");
          setStatus("scratchpad-status", `${result.status === "updated" ? "Synced" : "Created"} ${path} in ${repo}.`, "success");
          setBarState(`Synced to GitHub · ${now()}`, "success");
          pulseElement(repoPill, "is-pulsing");
          await refreshWorkspaceList();
          break;
        case "error":
          if (result.kind === "auth" && repo) {
            setFileStatus(`The app can't write to ${repo}. Add it to the app's installation, then click Re-check connection.`, "error");
            setBarState(`Can't write to ${repo}`, "error");
            showRepoHelp(
              `The notes target <code>${repo}</code> isn't available to the app (${result.error.message}). ` +
              `<a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">Add the repository to the app's installation</a>, ` +
              `then click <strong>Re-check connection</strong>.`
            );
          } else {
            setFileStatus(result.error.message, "error");
            setStatus("scratchpad-status", result.error.message, "error");
            setBarState(result.error.message, "error");
          }
          break;
      }
    } finally {
      saveBtn.disabled = false;
      if (quickSaveBtn) quickSaveBtn.disabled = false;
      paintStorageClarity();
    }
  }

  async function pullNotes() {
    if (!targetIsValid()) return;
    const repo = repoSelect.value;
    const path = normalizePath(pathInput.value);
    try {
      setFileStatus("Fetching the latest notes from GitHub…");
      const result = await engine.pull({ repo, path, branch: branchInput.value.trim() });
      if (result.status === "disconnected") { openGhModal(); setFileStatus("Connect GitHub first.", "error"); return; }
      if (result.status === "invalid-target") { setFileStatus("Choose a repository and file path first.", "error"); return; }
      if (result.status === "missing") {
        engine.conflictPaused = false;
        showOverwrite(false);
        setFileStatus(`Nothing is saved at ${path} in ${repo} yet — Save now will create it.`);
        setStatus("scratchpad-status", `${path} is only on this device so far — Save to repo will upload it.`);
        return;
      }
      if (result.status !== "loaded") return;
      if (textarea.value && textarea.value !== result.content &&
          !window.confirm("Replace the notes in this editor with the version on GitHub? Anything only in the editor will be lost.")) {
        setFileStatus("Pull cancelled — the editor was left untouched.");
        return;
      }
      textarea.value = result.content;
      await notes.setBody(result.content, { dirty: false, syncedAt: Date.now() });
      note = notes.current;
      lastLocalSavedAt = new Date();
      engine.conflictPaused = false;
      showOverwrite(false);
      editor.renderPreview();
      setFileStatus(`Pulled ${path} from ${repo} at ${new Date().toLocaleTimeString()}.`, "success");
      setStatus("scratchpad-status", `Pulled latest ${path} from ${repo}.`, "success");
      setBarState(`Loaded from GitHub · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "success");
      paintStorageClarity();
      await refreshWorkspaceList();
    } catch (error) {
      setFileStatus(error.message, "error");
      setStatus("scratchpad-status", error.message, "error");
    }
  }

  // ---- registration: manifest form → code exchange → install → resolve ----------------
  function startSetup() {
    if (!gh.cryptoReady()) { setGhStatus("GitHub setup needs the page served over https:// or http://localhost.", "error"); return; }
    if (embedded) {
      setGhStatus("Open the Scratchpad in its own tab to finish the one-time GitHub setup — GitHub blocks its install screen inside an embedded frame.", "error");
      window.open(gh.pageUrl(), "_blank", "noopener");
      return;
    }
    const redirectUrl = gh.pageUrl();
    if (!redirectUrl) { setGhStatus("GitHub setup needs a real page URL — open the live PWA rather than a downloaded file.", "error"); return; }
    const state = gh.randomState();
    try {
      sessionStorage.setItem(GH_KEYS.pending, JSON.stringify({ state, redirectUrl, startedAt: Date.now() }));
    } catch (error) {
      setGhStatus("This browser blocked session storage, so the setup can't be verified. Allow storage for this site and try again.", "error");
      return;
    }
    const manifest = gh.buildManifest(redirectUrl);
    const form = document.createElement("form");
    form.method = "post";
    form.action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    form.style.display = "none";
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "manifest";
    field.value = JSON.stringify(manifest);
    form.appendChild(field);
    document.body.appendChild(form);
    setGhStatus("Opening GitHub so you can name and create the app…");
    form.submit();
    form.remove();
  }

  async function startInstall() {
    const record = await gh.readApp();
    if (!record) return;
    const slug = record.slug || record.name?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) { setGhStatus("Couldn't work out the app's install URL — open the app on GitHub and install it there.", "error"); return; }
    try { sessionStorage.setItem(GH_KEYS.pending, JSON.stringify({ state: "install", startedAt: Date.now() })); } catch (error) {}
    setGhStatus("Opening GitHub to install the app — pick the repositories to allow, then you'll be brought back here.");
    window.location.assign(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  }

  async function handleManifestCallback() {
    let url;
    try { url = new URL(window.location.href); } catch (error) { return false; }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code || !returnedState) return false;
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(GH_KEYS.pending) || "null"); } catch (error) { pending = null; }
    if (!pending || pending.state !== returnedState) return false;

    try { window.history.replaceState({}, document.title, `${url.origin}${url.pathname}${url.hash}`); } catch (error) {}
    try { sessionStorage.removeItem(GH_KEYS.pending); } catch (error) {}

    openGhModal();
    setGhStatus("Registering your GitHub app…");
    try {
      await gh.exchangeManifestCode(code);
      setGhStatus("App created. Next: install it on the repositories you want to save notes to.", "success");
      await render();
      startInstall();
    } catch (error) {
      setGhStatus(`Setup failed: ${error.message}`, "error");
      await render();
    }
    return true;
  }

  async function resolveInstallation(installationIdHint = null, { quiet = false, lead = "" } = {}) {
    try {
      if (!quiet) setGhStatus("Checking which repository you installed the app on…");
      const match = await gh.resolveInstallation(installationIdHint);
      if (!match) return;
      reposLoaded = false;
      await render();
      if (!quiet) setGhStatus(`${lead}Connected to ${match.account?.login || "your account"} — pick a repo and start saving.`, "success");
    } catch (error) {
      if (error.code === "NO_INSTALLATION") {
        await render();
        setGhStatus(`${lead}The app isn't installed on any repository yet — click Install on a repository.`, "error");
      } else {
        await render();
        setGhStatus(`${lead}Couldn't confirm the installation: ${error.message}. Click Re-check connection to retry.`, "error");
      }
    }
  }

  // ---- wiring -------------------------------------------------------------------------
  pathInput.value = note.path || (await store.kvGet(GH_KEYS.path)) || datedFileName();
  branchInput.value = note.branch || (await store.kvGet(GH_KEYS.branch)) || "";
  autosaveCheckbox.checked = (await store.kvGet(GH_KEYS.autosave)) !== "false";

  setupBtn.addEventListener("click", startSetup);
  installBtn.addEventListener("click", startInstall);
  checkBtn.addEventListener("click", async () => {
    reposLoaded = false;
    scratchAttempted = false;
    await resolveInstallation();
  });
  forgetBtn.addEventListener("click", async () => {
    await gh.forgetApp();
    try { await store.kvDelete(GH_KEYS.token); } catch (error) {}
    reposLoaded = false;
    remoteWorkspace = { files: [], dirs: [], repo: "" };
    engine.conflictPaused = false;
    showOverwrite(false);
    await render();
    setGhStatus("Disconnected and credentials removed from this browser. The GitHub App itself still exists — delete it in GitHub → Settings → Developer settings → GitHub Apps if you want it gone, or drop its connection file back into Reconnect to use it again.", "success");
    setFileStatus("");
  });

  async function downloadConnectionFile() {
    const app = await gh.readApp();
    if (!app) { setGhStatus("Nothing to download yet — set up GitHub saving first.", "error"); return; }
    try {
      const name = connectionFileName(app);
      const url = URL.createObjectURL(new Blob([connectionFileText(app)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      await gh.markConnectionSaved();
      await render();
      setGhStatus(`Saved ${name}. Keep it in your password manager: choosing it under “Already have the app? Reconnect” restores saving on any browser or address, with no new app to create.`, "success");
    } catch (error) {
      setGhStatus(error.message, "error");
    }
  }
  exportBtn?.addEventListener("click", downloadConnectionFile);

  restoreFileInput?.addEventListener("change", async () => {
    const file = restoreFileInput.files && restoreFileInput.files[0];
    if (!file) return;
    try {
      restoreFileText = await file.text();
      const parsed = restoreFileText.trim().startsWith("{")
        ? parseConnectionInput(restoreFileText, { appId: restoreAppIdInput.value })
        : { app_id: null, pem: parsePrivateKey(restoreFileText), slug: "" };
      if (parsed.app_id) restoreAppIdInput.value = String(parsed.app_id);
      restorePemInput.value = parsed.pem;
      setRestoreStatus(restoreAppIdInput.value.trim()
        ? `Loaded ${file.name}${parsed.slug ? ` (${parsed.slug})` : ""} — click Reconnect with this app.`
        : `Loaded ${file.name}. Add the app's App ID (top of its settings page), then click Reconnect with this app.`, "success");
    } catch (error) {
      restoreFileText = "";
      setRestoreStatus(`${file.name}: ${error.message}`, "error");
    }
  });

  restoreGoBtn?.addEventListener("click", async () => {
    let input;
    try {
      const source = restorePemInput.value.trim() || restoreFileText;
      if (!source) throw new Error("Choose the connection file, or paste the app's private key.");
      input = parseConnectionInput(source, { appId: restoreAppIdInput.value });
    } catch (error) {
      setRestoreStatus(error.message, "error");
      return;
    }
    setRestoreStatus("Asking GitHub to confirm that App ID and key…");
    restoreGoBtn.disabled = true;
    try {
      const app = await gh.adoptApp(input);
      if (restoreDetails) restoreDetails.open = false;
      restorePemInput.value = "";
      restoreFileText = "";
      reposLoaded = false;
      scratchAttempted = false;
      await render();
      const lead = `Reconnected the existing app${app.slug ? ` (${app.slug})` : ""} — no new GitHub App was created. `;
      await resolveInstallation(null, { lead });
    } catch (error) {
      setRestoreStatus(error.message, "error");
      await render();
    } finally {
      restoreGoBtn.disabled = false;
    }
  });

  saveBtn.addEventListener("click", () => saveNotes());
  quickSaveBtn?.addEventListener("click", () => saveNotes());
  pullBtn.addEventListener("click", pullNotes);
  quickPullBtn?.addEventListener("click", pullNotes);
  overwriteBtn.addEventListener("click", () => saveNotes({ forced: true }));
  syncNowBtn?.addEventListener("click", () => flushOutbox({ announce: true }));

  newFileBtn.addEventListener("click", async () => {
    await flushLocalSave();
    const next = await notes.newDatedNote();
    await switchNote(next, `New note — ${next.path} is created on the first save.`);
    pathInput.select();
  });

  // ---- Note, File & Directory actions (Quick Bar + Workspace Panel) ------------------
  async function handleOpenTodayNote() {
    await flushLocalSave();
    const next = await notes.openToday();
    await switchNote(next, next.body
      ? `Reopened today's note (${next.path}) — anything you add goes into it.`
      : `Today's note is ${next.path} — it reopens all day so you can keep adding to it.`);
  }

  async function handleNewDatedNote() {
    await flushLocalSave();
    const next = await notes.newDatedNote();
    await switchNote(next, `Started a separate note: ${next.path}.`);
  }

  async function createDirectoryEverywhere(rawDir) {
    let dirPath;
    try {
      dirPath = normalizeWorkspacePath(rawDir);
    } catch (err) {
      setWsStatus(err.message, "error");
      setStatus("scratchpad-status", err.message, "error");
      return { ok: false };
    }
    if (!dirPath) {
      setWsStatus("Type a folder path — notes/2026-11-09, for example.", "error");
      return { ok: false };
    }
    const localResult = await notes.createFolder(dirPath);
    if (wsFileDirInput) wsFileDirInput.value = dirPath;
    if (renameDirFromInput && !renameDirFromInput.value) renameDirFromInput.value = dirPath;
    updateWorkspacePreviews();
    await refreshWorkspaceList();

    const repo = repoSelect?.value || "";
    const branch = branchInput?.value.trim() || "";
    if (lastConnectionState.ready && repo) {
      const keepPath = `${dirPath}/.gitkeep`;
      try {
        const existing = await gh.readRepoFile(repo, keepPath, branch);
        if (!existing) {
          const res = await engine.saveNote({ repo, path: keepPath, branch, content: "", forced: true });
          if (res.status === "queued") {
            const msg = `Created folder "${dirPath}" on this device; queued .gitkeep for ${repo} when online.`;
            setWsStatus(msg, "success");
            setStatus("scratchpad-status", msg, "success");
            await refreshOutboxBadge();
            return { ok: true, dirPath };
          }
          if (res.status !== "created" && res.status !== "updated") {
            const msg = `Created folder "${dirPath}" locally (GitHub returned: ${res.error?.message || res.status}).`;
            setWsStatus(msg, "error");
            return { ok: false, dirPath };
          }
        }
        if (!remoteWorkspace.dirs.includes(dirPath)) remoteWorkspace.dirs.push(dirPath);
        await refreshWorkspaceList();
        const msg = localResult.existed && existing
          ? `Folder "${dirPath}" is ready locally and in ${repo}.`
          : `Created folder "${dirPath}" locally and in ${repo}.`;
        setWsStatus(msg, "success");
        setStatus("scratchpad-status", msg, "success");
        return { ok: true, dirPath };
      } catch (err) {
        const msg = `Created folder "${dirPath}" on this device (${err.message}).`;
        setWsStatus(msg, "error");
        return { ok: true, dirPath };
      }
    }

    const localMsg = localResult.existed
      ? `Folder "${dirPath}" is ready on this device.`
      : `Created folder "${dirPath}" on this device (connect GitHub to sync folders to a repo).`;
    setWsStatus(localMsg, "success");
    setStatus("scratchpad-status", localMsg, "success");
    return { ok: true, dirPath };
  }

  async function handleTodayFolder() {
    const dirPath = todayFolderPath();
    await createDirectoryEverywhere(dirPath);
  }

  async function handleTodayNoteInFolder() {
    await flushLocalSave();
    const dirPath = todayFolderPath();
    await notes.createFolder(dirPath);
    const next = await notes.newDatedNote({ folder: dirPath });
    await switchNote(next, `Created ${next.path} inside today's folder.`);
    setWsStatus(`Opened ${next.path} inside today's folder (${dirPath}).`, "success");
  }

  async function handleCreateWorkspaceFile({ copyCurrent = false } = {}) {
    let targetPath;
    try {
      targetPath = computeWorkspaceTargetPath();
    } catch (err) {
      setWsStatus(err.message, "error");
      return;
    }
    if (!targetPath) {
      setWsStatus("Enter a file name first (e.g. standup or meeting-notes).", "error");
      wsFileNameInput?.focus();
      return;
    }
    const existingLocal = (await notes.list()).some(item => item.path === targetPath);
    if (existingLocal) {
      setWsStatus(`A file already exists at "${targetPath}" on this device — pick it from the list or choose another name.`, "error");
      return;
    }

    await flushLocalSave();
    const content = copyCurrent ? textarea.value : createNoteOutline(targetPath);
    const repo = repoSelect?.value || "";
    const branch = branchInput?.value.trim() || "";

    if (lastConnectionState.ready && repo) {
      try {
        const remoteExisting = await gh.readRepoFile(repo, targetPath, branch);
        if (remoteExisting) {
          setWsStatus(`${repo} already has "${targetPath}" — refresh the explorer to open it or pick a new name.`, "error");
          return;
        }
      } catch (err) {
        // Proceed locally if transient check fails; saveNote handles queuing.
      }
    }

    const createdNote = await notes.switchTo(targetPath, { repo, branch, initialBody: content });
    note = await notes.setBody(content, { dirty: true });
    if (wsFileNameInput) wsFileNameInput.value = "";
    await switchNote(createdNote);

    if (lastConnectionState.ready && repo) {
      const syncRes = await engine.saveNote({ repo, path: targetPath, branch, content, forced: true });
      if (syncRes.status === "created" || syncRes.status === "updated") {
        await notes.markSynced(targetPath);
        await refreshOutboxBadge();
        await refreshWorkspaceList();
        const msg = `Created ${targetPath} locally and in ${repo}.`;
        setWsStatus(msg, "success");
        setStatus("scratchpad-status", msg, "success");
        setBarState(`Synced to GitHub · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "success");
        paintStorageClarity();
        return;
      }
      if (syncRes.status === "queued") {
        await refreshOutboxBadge();
        const msg = `Created ${targetPath} on this device — queued for ${repo} when online.`;
        setWsStatus(msg, "success");
        setStatus("scratchpad-status", msg, "success");
        paintStorageClarity();
        return;
      }
      if (syncRes.error) {
        setWsStatus(`Created ${targetPath} locally, but GitHub returned: ${syncRes.error.message}`, "error");
        return;
      }
    }

    const localMsg = `Created ${targetPath} on this device.`;
    setWsStatus(localMsg, "success");
    setStatus("scratchpad-status", localMsg, "success");
  }

  async function handleRenameActiveFile() {
    await flushLocalSave();
    const oldPath = note?.path || normalizePath(pathInput.value);
    let newPath;
    try {
      newPath = normalizeWorkspacePath(renameFileInput?.value || "");
    } catch (err) {
      setWsStatus(err.message, "error");
      return;
    }
    if (!oldPath) {
      setWsStatus("No active file selected to rename.", "error");
      return;
    }
    if (!newPath) {
      setWsStatus("Enter the new file name or path.", "error");
      renameFileInput?.focus();
      return;
    }
    if (oldPath === newPath) {
      setWsStatus("Choose a different file name or path to rename.", "error");
      renameFileInput?.focus();
      return;
    }
    const existingLocal = (await notes.list()).some(item => item.path === newPath);
    if (existingLocal) {
      setWsStatus(`A note already exists at "${newPath}" — open it or pick a different name.`, "error");
      return;
    }

    const repo = repoSelect?.value || "";
    const branch = branchInput?.value.trim() || "";
    setWsStatus(`Renaming ${oldPath} → ${newPath}…`);
    if (renameFileBtn) renameFileBtn.disabled = true;

    try {
      const syncRes = await engine.renameFile({
        repo,
        oldPath,
        newPath,
        branch,
        content: textarea.value
      });
      if (syncRes.status === "error") {
        setWsStatus(syncRes.error?.message || "Could not rename file on GitHub.", "error");
        return;
      }

      const moved = await notes.renameNote(oldPath, newPath, { body: textarea.value });
      note = moved.note;
      if (syncRes.status === "renamed") {
        await notes.markSynced(newPath);
      }
      pathInput.value = newPath;
      await store.kvSet(GH_KEYS.path, newPath);
      if (noteCurrentLabel) noteCurrentLabel.textContent = newPath;
      if (renameFileCurrent) renameFileCurrent.textContent = newPath;

      if (remoteWorkspace.repo === repo && remoteWorkspace.files.length) {
        remoteWorkspace.files = remoteWorkspace.files.map(f => (f.path === oldPath ? { ...f, path: newPath } : f));
      }
      await refreshOutboxBadge();
      paintFileBar();
      paintStorageClarity();
      updateWorkspacePreviews();
      await refreshWorkspaceList();

      let msg;
      if (syncRes.status === "renamed") {
        msg = `Renamed "${oldPath}" to "${newPath}" locally and in ${repo}.`;
        setBarState(`Synced to GitHub · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "success");
      } else if (syncRes.status === "partial") {
        msg = `Renamed "${oldPath}" to "${newPath}" locally and created the new file in ${repo}, though deleting the old file returned: ${syncRes.deleteError?.message || "an error"}.`;
      } else if (syncRes.status === "not-remote") {
        msg = `Renamed "${oldPath}" to "${newPath}" on this device (the old file wasn't on GitHub yet).`;
      } else {
        msg = `Renamed "${oldPath}" to "${newPath}" on this device.`;
      }
      setWsStatus(msg, syncRes.status === "partial" ? "error" : "success");
      setStatus("scratchpad-status", msg, syncRes.status === "partial" ? "error" : "success");
      pulseElement($("scratchpad-filebar"), "is-pulsing");
    } catch (err) {
      setWsStatus(err.message, "error");
    } finally {
      if (renameFileBtn) renameFileBtn.disabled = false;
    }
  }

  async function handleRenameDirectory() {
    await flushLocalSave();
    let oldDir;
    let newDir;
    try {
      oldDir = normalizeWorkspacePath(renameDirFromInput?.value || "");
      newDir = normalizeWorkspacePath(renameDirToInput?.value || "");
    } catch (err) {
      setWsStatus(err.message, "error");
      return;
    }
    if (!oldDir) {
      setWsStatus("Choose or enter the folder you want to rename.", "error");
      renameDirFromInput?.focus();
      return;
    }
    if (!newDir) {
      setWsStatus("Enter the new folder name or path.", "error");
      renameDirToInput?.focus();
      return;
    }
    if (oldDir === newDir) {
      setWsStatus("The new folder name must be different from the current folder.", "error");
      return;
    }
    if (newDir.startsWith(`${oldDir}/`)) {
      setWsStatus("Cannot move a folder inside itself.", "error");
      return;
    }

    const repo = repoSelect?.value || "";
    const branch = branchInput?.value.trim() || "";
    setWsStatus(`Renaming folder "${oldDir}" → "${newDir}"…`);
    if (renameDirBtn) renameDirBtn.disabled = true;

    try {
      const syncRes = await engine.renameDirectory({ repo, oldDir, newDir, branch });
      if (syncRes.status === "error") {
        setWsStatus(syncRes.error?.message || "Could not rename folder on GitHub.", "error");
        return;
      }

      const localMoved = await notes.renameDirectory(oldDir, newDir);
      note = notes.current;
      if (note?.path) {
        pathInput.value = note.path;
        await store.kvSet(GH_KEYS.path, note.path);
        if (noteCurrentLabel) noteCurrentLabel.textContent = note.path;
      }

      const prefix = `${oldDir}/`;
      if (remoteWorkspace.repo === repo) {
        remoteWorkspace.files = remoteWorkspace.files.map(f => (
          f.path.startsWith(prefix) ? { ...f, path: `${newDir}/${f.path.slice(prefix.length)}` } : f
        ));
        remoteWorkspace.dirs = remoteWorkspace.dirs.map(d => {
          if (d === oldDir) return newDir;
          if (d.startsWith(prefix)) return `${newDir}/${d.slice(prefix.length)}`;
          return d;
        });
      }

      if (renameDirFromInput) renameDirFromInput.value = newDir;
      if (renameDirToInput) renameDirToInput.value = "";
      await refreshOutboxBadge();
      paintFileBar();
      paintStorageClarity();
      updateWorkspacePreviews();
      await refreshWorkspaceList();

      const localCount = localMoved.movedNotes.length;
      const remoteCount = (syncRes.moved || []).length;
      let msg;
      if (syncRes.status === "renamed") {
        msg = `Renamed folder "${oldDir}" → "${newDir}" (${remoteCount} file${remoteCount === 1 ? "" : "s"} moved in ${repo}, ${localCount} updated locally).`;
        setBarState(`Synced to GitHub · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "success");
      } else if (syncRes.status === "partial") {
        msg = `Renamed folder "${oldDir}" → "${newDir}" locally; some old GitHub files could not be deleted automatically.`;
      } else {
        msg = `Renamed folder "${oldDir}" → "${newDir}" on this device (${localCount} note${localCount === 1 ? "" : "s"} updated).`;
      }
      setWsStatus(msg, syncRes.status === "partial" ? "error" : "success");
      setStatus("scratchpad-status", msg, syncRes.status === "partial" ? "error" : "success");
      pulseElement(wsExplorer, "is-pulsing");
    } catch (err) {
      setWsStatus(err.message, "error");
    } finally {
      if (renameDirBtn) renameDirBtn.disabled = false;
    }
  }

  $("note-open-today")?.addEventListener("click", handleOpenTodayNote);
  wsTodayNoteBtn?.addEventListener("click", handleOpenTodayNote);
  $("note-new-dated")?.addEventListener("click", handleNewDatedNote);
  todayFolderBtn?.addEventListener("click", handleTodayFolder);
  wsTodayFolderBtn?.addEventListener("click", handleTodayFolder);
  wsTodayInFolderBtn?.addEventListener("click", handleTodayNoteInFolder);

  filesToggleBtn?.addEventListener("click", () => {
    if (wsPanel?.hidden) openWorkspacePanel({ sectionCard: wsExplorer });
    else closeWorkspacePanel();
  });
  wsCloseBtn?.addEventListener("click", closeWorkspacePanel);
  wsRefreshBtn?.addEventListener("click", () => refreshRemoteWorkspace({ announce: true }));
  wsFilterInput?.addEventListener("input", () => refreshWorkspaceList());

  wsFillTodayDirBtn?.addEventListener("click", () => {
    if (wsFileDirInput) wsFileDirInput.value = todayFolderPath();
    updateWorkspacePreviews();
    wsFileNameInput?.focus();
  });
  wsFillTodayFolderBtn?.addEventListener("click", () => {
    if (wsNewDirInput) wsNewDirInput.value = todayFolderPath();
    updateWorkspacePreviews();
    wsNewDirInput?.focus();
  });

  [wsFileDirInput, wsFileNameInput, wsFileExtSelect, wsNewDirInput, renameFileInput, renameDirFromInput, renameDirToInput].forEach(el => {
    el?.addEventListener("input", updateWorkspacePreviews);
    el?.addEventListener("change", updateWorkspacePreviews);
  });

  wsCreateBlankBtn?.addEventListener("click", () => handleCreateWorkspaceFile({ copyCurrent: false }));
  wsCreateFromCurrentBtn?.addEventListener("click", () => handleCreateWorkspaceFile({ copyCurrent: true }));
  wsFileNameInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); handleCreateWorkspaceFile({ copyCurrent: false }); }
  });

  wsCreateDirBtn?.addEventListener("click", async () => {
    const res = await createDirectoryEverywhere(wsNewDirInput?.value || "");
    if (res.ok && wsNewDirInput) wsNewDirInput.value = "";
    updateWorkspacePreviews();
  });
  wsNewDirInput?.addEventListener("keydown", async event => {
    if (event.key === "Enter") {
      event.preventDefault();
      const res = await createDirectoryEverywhere(wsNewDirInput.value);
      if (res.ok) wsNewDirInput.value = "";
      updateWorkspacePreviews();
    }
  });

  const openRenameFileFlow = () => {
    if (renameFileInput) renameFileInput.value = note?.path || "";
    openWorkspacePanel({ focusTarget: renameFileInput, sectionCard: wsRenameCard });
  };
  renameFileOpenBtn?.addEventListener("click", openRenameFileFlow);
  filebarRenameBtn?.addEventListener("click", openRenameFileFlow);

  renameDirOpenBtn?.addEventListener("click", async () => {
    const parent = parentFolderOf(note?.path || "");
    const folders = await notes.listFolders();
    const initialDir = parent || folders[0] || todayFolderPath();
    if (renameDirFromInput) renameDirFromInput.value = initialDir;
    openWorkspacePanel({
      focusTarget: renameDirFromInput?.value ? renameDirToInput : renameDirFromInput,
      sectionCard: wsRenameCard
    });
  });

  renameFileBtn?.addEventListener("click", handleRenameActiveFile);
  renameFileInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); handleRenameActiveFile(); }
  });
  renameDirBtn?.addEventListener("click", handleRenameDirectory);
  renameDirToInput?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); handleRenameDirectory(); }
  });

  scratchBtn.addEventListener("click", () => { scratchAttempted = false; ensureScratchRepo(); });

  repoSelect.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.repo, repoSelect.value);
    engine.conflictPaused = false;
    showOverwrite(false);
    setFileStatus("");
    setBarState("Not saved to this repo yet");
    paintStorageClarity();
    refreshRemoteWorkspace().catch(() => {});
  });
  pathInput.addEventListener("change", async () => {
    const cleanPath = normalizePath(pathInput.value);
    await store.kvSet(GH_KEYS.path, cleanPath);
    notes.current.path = cleanPath;
    await store.putNote(notes.current);
    if (noteCurrentLabel) noteCurrentLabel.textContent = cleanPath;
    engine.conflictPaused = false;
    showOverwrite(false);
    setBarState("Not saved to this file yet");
    paintStorageClarity();
    refreshWorkspaceList();
  });
  pathInput.addEventListener("input", paintFileBar);
  branchInput.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.branch, branchInput.value.trim());
    engine.conflictPaused = false;
    showOverwrite(false);
    refreshRemoteWorkspace().catch(() => {});
  });

  const applyAutosaveChange = async enabled => {
    autosaveCheckbox.checked = enabled;
    await store.kvSet(GH_KEYS.autosave, String(enabled));
    const msg = enabled
      ? "Repo autosave is ON — edits also commit to GitHub a few seconds after you stop typing."
      : "Repo autosave is OFF — edits still save on this device immediately; use Save to repo when you want to commit.";
    setFileStatus(msg);
    setStatus("scratchpad-status", msg);
    paintStorageClarity();
  };
  autosaveCheckbox.addEventListener("change", () => applyAutosaveChange(autosaveCheckbox.checked));
  quickAutosaveBtn?.addEventListener("click", () => applyAutosaveChange(!autosaveCheckbox.checked));

  tokenSaveBtn.addEventListener("click", async () => {
    const value = tokenInput.value.trim();
    if (!value) { setGhStatus("Paste a token first.", "error"); return; }
    setGhStatus("Checking the token…");
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${value}`, "X-GitHub-Api-Version": "2022-11-28" }
      });
      const user = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(user.message || `GitHub rejected that token (${res.status})`);
      await store.kvDelete(GH_KEYS.app);
      await store.kvSet(GH_KEYS.token, JSON.stringify({ access_token: value, login: user.login || "" }));
      tokenInput.value = "";
      reposLoaded = false;
      await render();
      setGhStatus(`Using a pasted token${user.login ? ` for @${user.login}` : ""}. Save now will commit your notes.`, "success");
    } catch (error) {
      setGhStatus(error.message, "error");
    }
  });
  tokenClearBtn.addEventListener("click", async () => {
    await store.kvDelete(GH_KEYS.token);
    reposLoaded = false;
    remoteWorkspace = { files: [], dirs: [], repo: "" };
    await render();
    setGhStatus("Pasted token removed.", "success");
  });

  const ghSync = {
    handleLocalEdit() {
      if (!autosaveCheckbox?.checked || engine.conflictPaused || engine.saving) return;
      clearTimeout(ghSaveTimer);
      ghSaveTimer = setTimeout(() => saveNotes({ auto: true }), 3000);
    }
  };

  window.addEventListener("online", () => flushOutbox());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushOutbox();
  });
  window.addEventListener("appinstalled", refreshOutboxBadge);

  // ---- the ⚙ sheet and the ⋯ menu -----------------------------------------------------
  ghOpenBtn?.addEventListener("click", openGhModal);
  ghCloseBtn?.addEventListener("click", () => panel?.close?.());
  panel?.addEventListener("click", event => { if (event.target === panel) panel.close?.(); });

  function closeMenu() {
    if (!actionMenu || actionMenu.hidden) return;
    actionMenu.hidden = true;
    menuBtn?.setAttribute("aria-expanded", "false");
  }
  function positionMenu() {
    if (!actionMenu || !menuBtn) return;
    const rect = menuBtn.getBoundingClientRect();
    const width = actionMenu.offsetWidth || 208;
    const height = actionMenu.offsetHeight || 224;
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
    const above = rect.top - height - 6;
    const top = above >= 8 ? above : Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - height - 8));
    actionMenu.style.left = `${left}px`;
    actionMenu.style.top = `${top}px`;
  }
  function toggleMenu() {
    if (!actionMenu) return;
    const next = actionMenu.hidden;
    actionMenu.hidden = !next;
    menuBtn?.setAttribute("aria-expanded", String(next));
    if (next) { positionMenu(); actionMenu.querySelector("button:not([hidden])")?.focus(); }
  }
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", closeMenu, true);
  menuBtn?.addEventListener("click", event => { event.stopPropagation(); toggleMenu(); });
  actionMenu?.addEventListener("click", event => { if (event.target.closest("button")) closeMenu(); });
  document.addEventListener("click", event => {
    if (!actionMenu || actionMenu.hidden) return;
    if (event.target.closest("#scratchpad-menu, #scratchpad-menu-btn")) return;
    closeMenu();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });

  // ---- day, date and time -------------------------------------------------------------
  function paintClock() {
    if (!clockEl) return;
    const now = new Date();
    const day = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    clockEl.textContent = `${day} · ${time}`;
    clockEl.title = now.toLocaleString();
  }
  paintClock();
  setInterval(paintClock, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") paintClock(); });

  // ---- creating files and folders inside the GitHub dialog ----------------------------
  async function createRepoPath({ path, content, folder = false }) {
    const connection = await gh.connection();
    if (!connection.ready) { openGhModal(); setGhStatus("Connect GitHub first — the ⚙ GitHub sync button sets it up.", "error"); return; }
    const repo = repoSelect.value;
    if (!repo) { setGhStatus("Pick a repository first.", "error"); return; }
    const branch = branchInput.value.trim();
    setGhStatus(folder ? `Creating the folder “${path}”…` : `Creating “${path}”…`);
    try {
      const existing = await gh.readRepoFile(repo, path, branch);
      if (existing) {
        setGhStatus(`${repo} already has ${path} — put that path in File path to switch to it.`, "error");
        return;
      }
      const result = await engine.saveNote({ repo, path, branch, content, forced: true });
      if (result.status === "queued") {
        setGhStatus(`Offline: ${path} is queued and will be created as soon as the connection is back.`);
        return;
      }
      if (result.status !== "created") {
        setGhStatus(result.reason || result.error?.message || `GitHub didn't create ${path}.`, "error");
        return;
      }
      if (folder) {
        const dirPath = path.replace(/\/\.gitkeep$/, "");
        await notes.createFolder(dirPath);
        await refreshWorkspaceList();
        setGhStatus(`Created the folder “${path}” in ${repo} — a .gitkeep file is what keeps an empty folder in git.`, "success");
        return;
      }
      pathInput.value = path;
      await store.kvSet(GH_KEYS.path, path);
      await notes.switchTo(path, { repo, branch, initialBody: content });
      await notes.markSynced(path);
      note = notes.current;
      if (noteCurrentLabel) noteCurrentLabel.textContent = path;
      engine.conflictPaused = false;
      showOverwrite(false);
      paintFileBar();
      paintStorageClarity();
      await refreshWorkspaceList();
      setGhStatus(`Created ${repo}/${path} with the notes in this pad — it now saves there.`, "success");
      setFileStatus(`Created ${path}.`);
    } catch (error) {
      setGhStatus(error.message, "error");
    }
  }

  createFileBtn?.addEventListener("click", () => {
    const path = pathWithExtension(newPathInput.value, newTypeSelect?.value ?? "md");
    if (!path) { setGhStatus("Type a path for the new file — notes/2026-10-31.md, for example.", "error"); newPathInput?.focus(); return; }
    createRepoPath({ path, content: textarea.value });
  });
  createFolderBtn?.addEventListener("click", () => {
    const path = normalizePath(newFolderInput.value);
    if (!path) { setGhStatus("Type a folder path — notes/2026-10, for example.", "error"); newFolderInput?.focus(); return; }
    createRepoPath({ path: `${path}/.gitkeep`, content: "", folder: true }).then(() => {
      newFolderInput.value = "";
    });
  });
  newPathInput?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createFileBtn?.click(); } });
  newFolderInput?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createFolderBtn?.click(); } });

  // ---- launch-time URL handoff (manifest callback / install return) -------------------
  (async () => {
    const handled = await handleManifestCallback();
    if (handled) { try { sessionStorage.removeItem(GH_KEYS.pending); } catch (error) {} return; }
    try {
      const here = new URL(window.location.href);
      const setupAction = here.searchParams.get("setup_action");
      const installationId = here.searchParams.get("installation_id");
      if (setupAction || installationId) {
        try { window.history.replaceState({}, document.title, `${here.origin}${here.pathname}${here.hash}`); } catch (error) {}
        try { sessionStorage.removeItem(GH_KEYS.pending); } catch (error) {}
        openGhModal();
        await resolveInstallation(installationId);
        return;
      }
      const pending = JSON.parse(sessionStorage.getItem(GH_KEYS.pending) || "null");
      if (pending?.state === "install") {
        try { sessionStorage.removeItem(GH_KEYS.pending); } catch (error) {}
        openGhModal();
        await resolveInstallation();
        return;
      }
    } catch (error) { /* malformed URL: normal render */ }
    const connection = await gh.connection();
    if (connection.kind === "app") await resolveInstallation(null, { quiet: true });
    await render();
    if (migration.migrated) {
      setStatus("scratchpad-status",
        `Imported ${migration.noteCopied ? "your saved notes" : "your settings"} from the dashboard's browser storage.`,
        "success");
    }
  })();

  paintFileBar();
  paintStorageClarity();
  updateWorkspacePreviews();
  await refreshOutboxBadge();
  await refreshWorkspaceList();

  // Ask the browser not to evict the note database under disk pressure.
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (error) {}

  // ---- embedded mode (rendered inside the dashboard dialog's iframe) -----------------
  let framed = false;
  try { framed = window.self !== window.top; } catch (error) { framed = true; }
  const embedded = isEmbedded({ search: location.search, framed });
  const embedBanner = $("embed-banner");
  if (embedded) {
    document.body.classList.add("is-embedded");
    embedBanner?.classList.remove("hidden");
    $("install-app")?.classList.add("hidden");
  }

  await setupPwaInstall({ embedded });
}

main().catch(error => {
  console.error("Scratchpad failed to start:", error);
  const status = document.getElementById("scratchpad-status");
  if (status) { status.textContent = `Failed to start: ${error.message}`; status.classList.add("is-error"); }
});
