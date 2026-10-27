// Scratchpad PWA — main controller.
//
// Standalone-page counterpart of the dashboard's scratchpad dialog, with the
// upgrades from scratch-pad-app.md:
//   • notes persist to IndexedDB (async, GB-scale) instead of a localStorage string
//   • one-time migration of the dialog's localStorage layout (incl. GitHub App creds)
//   • an offline commit outbox drained on reconnect (Background Sync is Chromium-only,
//     so the universal path is online/focus events plus a manual Sync now button)
//   • service worker registration with an update toast, PWA install prompt + iOS hint
//   • File System Access save/open where the browser supports it, downloads elsewhere

import { datedFileName } from "./markdown.js";
import { createEditor } from "./editor.js";
import { openStore, migrateLegacyStorage, ACTIVE_NOTE_ID, LEGACY_KEYS } from "./notes-store.js";
import { GitHubAppClient, GH_KEYS, normalizePath, SCRATCH_REPO } from "./github-app.js";
import { SyncEngine } from "./sync-engine.js";
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

async function main() {
  const store = await openStore();
  const migration = await migrateLegacyStorage(store);
  const gh = new GitHubAppClient(store);
  const engine = new SyncEngine(store, gh);

  const textarea = $("scratchpad-text");
  const toolbar = document.querySelector(".md-toolbar");
  const preview = $("scratchpad-preview");
  const previewToggle = $("scratchpad-preview-toggle");

  // ---- load the active note (or the one seeded by migration) --------------------------
  let note = await store.getNote(ACTIVE_NOTE_ID);
  if (!note) {
    note = { id: ACTIVE_NOTE_ID, title: "Quick notes", body: "", repo: "", path: "", branch: "", dirty: false };
    await store.putNote(note);
  }
  textarea.value = note.body || "";
  // Manifest shortcut ("New note") lands with ?new=1 — focus the editor immediately.
  if (new URL(window.location.href).searchParams.get("new")) textarea.focus();

  let localSaveTimer;
  const persistLocal = () => {
    clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(async () => {
      note.body = textarea.value;
      note.dirty = true;
      await store.putNote(note);
      setStatus("scratchpad-status", "Saved on this device.", "success");
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

  // ---- GitHub sync --------------------------------------------------------------------
  const panel = $("scratchpad-gh-panel");
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

  const setGhStatus = (message, tone) => setStatus("scratchpad-gh-status", message, tone);
  const setFileStatus = (message, tone) => setStatus("scratchpad-gh-file-status", message, tone);

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
  }

  const showOverwrite = visible => { if (overwriteBtn) overwriteBtn.hidden = !visible; };
  const showRepoHelp = html => { if (!repoHelp) return; repoHelp.hidden = !html; repoHelp.innerHTML = html || ""; };

  async function render() {
    const connection = await gh.connection();
    const secure = gh.cryptoReady();
    setupBtn.hidden = connection.kind !== "none";
    installBtn.hidden = !(connection.kind === "app" && !connection.installationId);
    checkBtn.hidden = !(connection.kind === "app" && connection.installationId);
    forgetBtn.hidden = connection.kind === "none";
    tokenClearBtn.hidden = connection.kind !== "token";
    target.hidden = !connection.ready;
    scratchBtn.hidden = !connection.ready;

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
        hint.textContent = "Nothing to copy or paste: one click registers a private GitHub App owned by you, then you pick the repo it may write to. The app renews its own short-lived credentials from then on.";
      } else if (connection.kind === "app" && !connection.installationId) {
        hint.textContent = "Last step: choose which repositories the app may write to. GitHub then sends you back here automatically.";
      } else {
        hint.textContent = "Connected. Notes are committed with short-lived installation tokens minted on this device — no sign-in, no stored long-lived credential.";
      }
    }
    paintFileBar();
    if (connection.ready && !reposLoaded) loadRepos();
    refreshOutboxBadge();
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
      if (hasScratch) showRepoHelp("");
      if (announce) setGhStatus(`${repos.length} repositor${repos.length === 1 ? "y" : "ies"} available to this app.`, "success");
      else if (!repos.length) setGhStatus("No repositories are available yet — the app can create one for you.", "");
    } catch (error) {
      setGhStatus(error.message, "error");
      return;
    }
    if (!hasScratch && createScratch) await ensureScratchRepo({ automatic: true });
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
    if (!outboxCount) return;
    const entries = await store.listOutbox();
    outboxCount.textContent = entries.length ? `${entries.length} pending` : "";
    outboxCount.classList.toggle("hidden", !entries.length);
    syncNowBtn?.classList.toggle("has-pending", entries.length > 0);
  }

  // Thin DOM wrappers over the DOM-free SyncEngine (assets/sync-engine.js).
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
    setBarState(`Synced to GitHub · ${now()}`, "success");
    setFileStatus(`Delivered ${result.delivered} pending commit${result.delivered === 1 ? "" : "s"}.`, "success");
  }

  async function saveNotes({ forced = false, auto = false } = {}) {
    if (engine.saving) return;
    if (!targetIsValid()) { panel.open = true; return; }
    const repo = repoSelect.value;
    const path = normalizePath(pathInput.value);
    const branch = branchInput.value.trim();
    if (!auto) setFileStatus("Checking the file hasn't changed on GitHub…");
    saveBtn.disabled = true;
    try {
      const result = await engine.saveNote({ repo, path, branch, content: textarea.value, forced, auto });
      const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      switch (result.status) {
        case "disconnected":
          panel.open = true;
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
          break;
        case "queued":
          await refreshOutboxBadge();
          setFileStatus("No connection right now — the commit is queued and will send when you're back online.", "");
          setBarState("Offline — saved here, queued for GitHub", "error");
          break;
        case "created":
        case "updated":
          showOverwrite(false);
          note.dirty = false;
          await store.putNote(note);
          await refreshOutboxBadge();
          setFileStatus(`${result.status === "updated" ? "Updated" : "Created"} ${path} in ${repo} at ${new Date().toLocaleTimeString()}${auto ? " (autosave)" : ""}.`, "success");
          setBarState(`Synced to GitHub · ${now()}`, "success");
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
            setBarState(result.error.message, "error");
          }
          break;
      }
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function pullNotes() {
    if (!targetIsValid()) return;
    const repo = repoSelect.value;
    const path = normalizePath(pathInput.value);
    try {
      setFileStatus("Fetching the latest notes from GitHub…");
      const result = await engine.pull({ repo, path, branch: branchInput.value.trim() });
      if (result.status === "disconnected") { panel.open = true; setFileStatus("Connect GitHub first.", "error"); return; }
      if (result.status === "invalid-target") { setFileStatus("Choose a repository and file path first.", "error"); return; }
      if (result.status === "missing") {
        engine.conflictPaused = false;
        showOverwrite(false);
        setFileStatus(`Nothing is saved at ${path} in ${repo} yet — Save now will create it.`);
        return;
      }
      if (result.status !== "loaded") return;
      if (textarea.value && textarea.value !== result.content &&
          !window.confirm("Replace the notes in this editor with the version on GitHub? Anything only in the editor will be lost.")) {
        setFileStatus("Pull cancelled — the editor was left untouched.");
        return;
      }
      textarea.value = result.content;
      note.body = result.content;
      await store.putNote(note);
      engine.conflictPaused = false;
      showOverwrite(false);
      editor.renderPreview();
      setFileStatus(`Pulled ${path} from ${repo} at ${new Date().toLocaleTimeString()}.`, "success");
      setBarState(`Loaded from GitHub · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "success");
    } catch (error) {
      setFileStatus(error.message, "error");
    }
  }


  // ---- registration: manifest form → code exchange → install → resolve ----------------
  function startSetup() {
    if (!gh.cryptoReady()) { setGhStatus("GitHub setup needs the page served over https:// or http://localhost.", "error"); return; }
    // GitHub's app-registration screens refuse to render inside an iframe. The
    // one-time setup therefore has to run in a top-level tab; once the app is
    // registered and installed, sync works fine embedded.
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

    panel.open = true;
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

  async function resolveInstallation(installationIdHint = null, { quiet = false } = {}) {
    try {
      if (!quiet) setGhStatus("Checking which repository you installed the app on…");
      const match = await gh.resolveInstallation(installationIdHint);
      if (!match) return;
      reposLoaded = false;
      await render();
      if (!quiet) setGhStatus(`Connected to ${match.account?.login || "your account"} — pick a repo and start saving.`, "success");
    } catch (error) {
      if (error.code === "NO_INSTALLATION") {
        await render();
        setGhStatus("The app isn't installed on any repository yet — click Install on a repository.", "error");
      } else {
        await render();
        setGhStatus(`Couldn't confirm the installation: ${error.message}. Click Re-check connection to retry.`, "error");
      }
    }
  }

  // ---- wiring -------------------------------------------------------------------------
  pathInput.value = (await store.kvGet(GH_KEYS.path)) || datedFileName();
  branchInput.value = (await store.kvGet(GH_KEYS.branch)) || "";
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
    engine.conflictPaused = false;
    showOverwrite(false);
    await render();
    setGhStatus("Disconnected and credentials removed from this browser. The GitHub App itself still exists — delete it in GitHub → Settings → Developer settings → GitHub Apps if you want it gone.", "success");
    setFileStatus("");
  });

  saveBtn.addEventListener("click", () => saveNotes());
  pullBtn.addEventListener("click", pullNotes);
  overwriteBtn.addEventListener("click", () => saveNotes({ forced: true }));
  syncNowBtn?.addEventListener("click", () => flushOutbox({ announce: true }));

  newFileBtn.addEventListener("click", async () => {
    pathInput.value = datedFileName();
    await store.kvSet(GH_KEYS.path, pathInput.value);
    engine.conflictPaused = false;
    showOverwrite(false);
    setFileStatus(`Next save creates ${pathInput.value}.`);
    setBarState("New file — saves on next sync");
    pathInput.focus();
    pathInput.select();
  });
  scratchBtn.addEventListener("click", () => { scratchAttempted = false; ensureScratchRepo(); });

  repoSelect.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.repo, repoSelect.value);
    engine.conflictPaused = false;
    showOverwrite(false);
    setFileStatus("");
    setBarState("Not saved to this repo yet");
  });
  pathInput.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.path, normalizePath(pathInput.value));
    engine.conflictPaused = false;
    showOverwrite(false);
    setBarState("Not saved to this file yet");
  });
  pathInput.addEventListener("input", paintFileBar);
  branchInput.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.branch, branchInput.value.trim());
    engine.conflictPaused = false;
    showOverwrite(false);
  });
  autosaveCheckbox.addEventListener("change", async () => {
    await store.kvSet(GH_KEYS.autosave, String(autosaveCheckbox.checked));
    setFileStatus(autosaveCheckbox.checked
      ? "Autosave is on — notes are committed a few seconds after you stop typing."
      : "Autosave is off — use Save now when you want to commit.");
  });

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

  // Reconnect triggers: universal path (Background Sync is not cross-browser).
  window.addEventListener("online", () => flushOutbox());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushOutbox();
  });
  window.addEventListener("appinstalled", refreshOutboxBadge);

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
        panel.open = true;
        await resolveInstallation(installationId);
        return;
      }
      const pending = JSON.parse(sessionStorage.getItem(GH_KEYS.pending) || "null");
      if (pending?.state === "install") {
        try { sessionStorage.removeItem(GH_KEYS.pending); } catch (error) {}
        panel.open = true;
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
  refreshOutboxBadge();

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
    // Installation is owned by the outer dashboard page.
    $("install-app")?.classList.add("hidden");
  }

  // Shared SW registration, update toast and install prompt live in pwa-install.js.
  await setupPwaInstall({ embedded });
}

main().catch(error => {
  console.error("Scratchpad failed to start:", error);
  const status = document.getElementById("scratchpad-status");
  if (status) { status.textContent = `Failed to start: ${error.message}`; status.classList.add("is-error"); }
});
