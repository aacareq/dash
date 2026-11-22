import { createNoteOutline } from "./note-template.js";
import { datedFileName } from "./markdown.js";
import { createEditor } from "./editor.js";
import { initCapture, appendToNote } from "./capture.js";
import { initPromptCreator } from "./prompt-creator.js";
import { openStore, migrateLegacyStorage, withLocalStorageMirror, ACTIVE_NOTE_ID, LEGACY_KEYS } from "./notes-store.js";
import { GitHubAppClient, GH_KEYS, normalizePath } from "./github-app.js";
import { SyncEngine } from "./sync-engine.js";
import { NoteManager, todayNoteFileName, todayFolderPath, todayFolderNotePath, normalizeWorkspacePath, parentFolderOf } from "./notes-manager.js";
import { setupPwaInstall } from "./pwa-install.js";
import { parseOutline, buildOutlineTree, extractSection, replaceSection, focusLines, unfocusLines, enhanceCollapsibleLists } from "./notebook-outline.js";
import { parseTasks, groupTasks, taskStats, toggleTaskLine, insertTask } from "./notebook-tasks.js";
import { NOTEBOOK_STARTERS, STARTER_LABELS, STARTER_CATEGORIES } from "./notebook-templates.js";
import { expandSection, getStoredKey as getStoredBYOK, providerLabels } from "./notebook-assistant.js";

// Notebook -- main controller, modeled on scratchpad.js but with simplified UX
// and new features: outline focus, inline tasks, BYOK expand, transparent save log.

const $ = id => document.getElementById(id);
const NB_KEYS = {
  path: "dash-notebook-path",
  branch: "dash-notebook-branch",
  autosave: "dash-notebook-autosave",
  shas: "dash-notebook-shas-v1",
  notebookRepo: "dash-notebook-repo",
};

function setStatus(id, msg, tone) {
  const el = $(id); if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("is-error", tone === "error");
  el.classList.toggle("is-success", tone === "success");
}
function pulse(el, cls="is-pulsing", ms=650){ if(!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(()=>el.classList.remove(cls), ms); }

function logSave(msg){
  const el = $("nb-save-log"); if(!el) return;
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.textContent = (el.textContent + "\n" + line).split("\n").slice(-80).join("\n");
  el.scrollTop = el.scrollHeight;
}

async function main(){
  const baseStore = await openStore();
  const store = withLocalStorageMirror(baseStore);
  await migrateLegacyStorage(store);
  const gh = new GitHubAppClient(store);
  const engine = new SyncEngine(store, gh);
  const notes = new NoteManager(store);

  // Boot note
  const migrated = await store.getNote(ACTIVE_NOTE_ID);
  await notes.boot({ fallbackPath: todayNoteFileName(), initialBody: migrated?.body || undefined });
  // If URL has ?new=1 start new dated note with outline
  if(new URL(location.href).searchParams.get("new")) notes.newDatedNote().then(n=>{ textarea.value=n.body; });
  let note = notes.current;

  const textarea = $("nb-text");
  const toolbar = document.querySelector(".md-toolbar");
  const preview = $("nb-preview");
  const previewToggle = $("nb-preview-toggle");

  textarea.value = note.body || "";

  // Capture + prompt with extended starters
  initCapture({ root: $("nb-capture"), textarea, target: ()=> notes.current?.path || "notebook" });
  // Custom prompt creator with notebook starters: we instantiate vanilla then swap starter select
  initPromptCreator({ root: $("nb-prompt"), textarea, target: ()=> notes.current?.path || "notebook" });
  setTimeout(()=>{
    const root = $("nb-prompt");
    if(!root) return;
    const sel = root.querySelector('[data-prompt="starter"]');
    if(!sel) return;
    sel.innerHTML = "";
    for(const [cat, keys] of Object.entries(STARTER_CATEGORIES)){
      const grp = document.createElement("optgroup"); grp.label = cat;
      for(const k of keys){ const opt=document.createElement("option"); opt.value=k; opt.textContent=STARTER_LABELS[k] || k; grp.appendChild(opt); }
      sel.appendChild(grp);
    }
    // Override load handler to use NOTEBOOK_STARTERS
    const btn = root.querySelector("[data-load]");
    if(btn){
      const old = btn.onclick;
      btn.onclick = ()=>{
        const key = sel.value;
        const tpl = NOTEBOOK_STARTERS[key];
        if(!tpl) return old?.();
        const FIELDS = ['task','role','context','audience','tone','rules','length','scope','format','examples','steps'];
        const field = k=> root.querySelector(`[data-prompt="${k}"]`);
        if(FIELDS.some(k=>!['tone','format'].includes(k) && field(k)?.value.trim()) || field('preview')?.value.trim()){
          if(!confirm("Replace prompt inputs and preview with this starter?")) return;
        }
        for(const k of FIELDS) if(field(k)) field(k).value = tpl[k] || "";
        const b = root.querySelector('[data-prompt="bindings"]'); if(b) b.value="";
        const pv = root.querySelector('[data-prompt="preview"]'); if(pv) pv.value="";
        root.querySelector("[role=status]").textContent = `Loaded "${STARTER_LABELS[key]}" starter. Customize then Generate preview.`;
      };
    }
  }, 300);

  let localSaveTimer, localSaving=false, lastLocalSavedAt= note.updatedAt ? new Date(note.updatedAt) : null;
  let remoteWorkspace = { files:[], dirs:[], repo:"" };
  let ghSaveTimer, reposLoaded=false, scratchAttempted=false;
  let barState = { text: "Saved locally", tone:"" };
  let lastConnection = { kind:"none", ready:false };
  let pendingOutboxTotal=0;
  let focusSection=null, fullSourceBackup="";

  // Editor
  const editor = createEditor({
    textarea, toolbar, preview, previewToggle,
    workerUrl: new URL("./markdown-worker.js", import.meta.url),
    previewPref: { get: ()=> store.kvGet(NB_KEYS.path+"_preview"), set: v=> store.kvSet(NB_KEYS.path+"_preview", String(v)) },
    emojiElements: { button: $("nb-emoji-btn"), picker: $("nb-emoji-picker"), search: $("nb-emoji-search"), list: $("nb-emoji-list") },
    onInput: ()=>{ persistLocal(); handleLocalEdit(); renderOutline(); renderTasks(); scheduleAISectionRefresh(); }
  });

  // Enhance preview collapsible lists after each render
  const origRender = editor.renderPreview.bind(editor);
  editor.renderPreview = ()=>{ origRender(); setTimeout(()=> enhanceCollapsibleLists(preview), 50); };

  // Handle Toggle toolbar: insert details block
  toolbar?.addEventListener("click", e=>{
    const btn = e.target.closest("[data-md='toggle']");
    if(!btn) return;
    e.preventDefault();
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const sel = textarea.value.slice(start,end) || "Details";
    const ins = `\n<details>\n<summary>${sel}</summary>\n\nWrite the hidden content here.\n\n</details>\n`;
    const before = textarea.value.slice(0,start), after = textarea.value.slice(end);
    textarea.value = before + ins + after;
    const pos = start + ins.indexOf("Write");
    textarea.setSelectionRange(pos, pos+ "Write the hidden content here.".length);
    textarea.dispatchEvent(new Event("input", {bubbles:true}));
  });

  async function flushLocalSave(){
    clearTimeout(localSaveTimer); localSaving=false;
    note = await notes.setBody(textarea.value, { dirty:true });
    lastLocalSavedAt = new Date(); paintClarity(); logSave(`💾 Local save: ${note.path} (${textarea.value.length.toLocaleString()} chars)`);
    return note;
  }
  const persistLocal = ()=>{
    localSaving=true; if(note) note.dirty=true; paintClarity();
    clearTimeout(localSaveTimer);
    localSaveTimer=setTimeout(async()=>{
      localSaving=false; note=await notes.setBody(textarea.value, {dirty:true});
      lastLocalSavedAt=new Date();
      setStatus("nb-status","Saved on this device.","success");
      paintClarity(); pulse($("nb-local-state"),"is-pulsing"); refreshWorkspaceList();
      logSave(`💾 Autosaved locally → ${note.path} at ${lastLocalSavedAt.toLocaleTimeString()}`);
    },400);
  };
  function handleLocalEdit(){
    const autosave = $("nb-gh-autosave")?.checked;
    if(!autosave || engine.conflictPaused || engine.saving) return;
    clearTimeout(ghSaveTimer);
    ghSaveTimer=setTimeout(()=> saveNotes({auto:true}),3000);
  }

  // --- Storage clarity
  const localDot=$("nb-local-dot"), localSummary=$("nb-local-summary"), localStateBadge=$("nb-local-state"), repoPill=$("nb-repo-pill"), repoDot=$("nb-repo-dot"), repoSummary=$("nb-repo-summary"), autosavePill=$("nb-autosave-toggle"), quickSaveBtn=$("nb-quick-save"), quickPullBtn=$("nb-quick-pull");
  function setBarState(text,tone=""){ barState={text,tone}; paintFileBar(); }
  function paintFileBar(){
    const repo=$("nb-gh-repo")?.value||"", path=normalizePath($("nb-gh-path")?.value||"");
    const fr=$("nb-filebar-repo"), fs=$("nb-filebar-sep"), ff=$("nb-filebar-file"), fst=$("nb-filebar-state");
    if(fr){ fr.textContent = repo || "Local only"; fr.title = repo ? repo : "Notes kept in this browser until GitHub is connected"; }
    if(fs) fs.hidden=!repo;
    if(ff){ ff.textContent = path||"—"; ff.title=path||""; }
    if(fst){ fst.textContent=barState.text; fst.classList.toggle("is-saved", barState.tone==="success"); fst.classList.toggle("is-error", barState.tone==="error"); }
    const cur=$("nb-current"); if(cur) cur.textContent=path||"";
    const rc=$("nb-rename-file-current"); if(rc) rc.textContent= note?.path || path || "—";
  }
  function paintClarity(){
    const tl = lastLocalSavedAt ? lastLocalSavedAt.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "";
    if(localSaving){ localDot?.classList.remove("is-local-ok"); localDot?.classList.add("is-saving"); if(localSummary) localSummary.textContent="Saving on this device…"; if(localStateBadge){ localStateBadge.textContent="💾 Local: Saving…"; localStateBadge.classList.add("is-saving"); } }
    else { localDot?.classList.remove("is-saving"); localDot?.classList.add("is-local-ok"); if(localSummary) localSummary.textContent= tl ? `Autosaved locally · ${tl}` : "Autosaves locally"; if(localStateBadge){ localStateBadge.textContent="💾 Local: Saved"; localStateBadge.classList.remove("is-saving"); } }
    const repo=$("nb-gh-repo")?.value||""; const connected=Boolean(lastConnection.ready && repo);
    if(quickSaveBtn) quickSaveBtn.hidden=!connected;
    if(quickPullBtn) quickPullBtn.hidden=!connected;
    if(repoPill && repoDot && repoSummary){
      repoPill.classList.remove("is-connected","is-warning"); repoDot.classList.remove("is-connected","is-warning","is-error");
      if(!connected) repoSummary.textContent= lastConnection.kind==="app" && !lastConnection.installationId ? "Finish installing GitHub App to sync" : "Local only (not connected)";
      else if(pendingOutboxTotal>0){ repoPill.classList.add("is-warning"); repoDot.classList.add("is-warning"); repoSummary.textContent=`${repo} · ${pendingOutboxTotal} commit${pendingOutboxTotal===1?"":"s"} queued offline`; }
      else if(note?.dirty){ repoPill.classList.add("is-warning"); repoDot.classList.add("is-warning"); repoSummary.textContent=`${repo} · Local edits not synced yet`; }
      else { repoPill.classList.add("is-connected"); repoDot.classList.add("is-connected"); repoSummary.textContent=`${repo} · Synced`; }
    }
    if(autosavePill){ const cb=$("nb-gh-autosave"); const en=cb?.checked; autosavePill.setAttribute("aria-pressed", String(!!en)); autosavePill.classList.toggle("is-on", !!en); autosavePill.textContent= en ? (connected ? "⚡ Repo auto-save: ON" : "⚡ Repo auto-save: ON (when connected)") : "⏸ Repo auto-save: OFF"; }
  }

  // --- Outline + focus
  function renderOutline(){
    const out=$("nb-outline"), cnt=$("nb-outline-count"), secSel=$("nb-ai-section");
    if(!out) return;
    const sections = parseOutline(textarea.value);
    if(cnt) cnt.textContent = sections.length ? `${sections.length} sections` : "";
    const activeIdx = getActiveSectionIndex(sections);
    out.replaceChildren();
    sections.forEach((s, i)=>{
      const row=document.createElement("div");
      row.className="nb-outline-item"+(i===activeIdx?" is-active":"");
      row.setAttribute("role","listitem");
      const badge=document.createElement("span");
      badge.textContent = "#".repeat(s.level); badge.style.opacity="0.5"; badge.style.fontSize="0.70rem";
      const title=document.createElement("span");
      title.textContent = s.title; title.style.flex="1 1 auto"; title.title=`Line ${s.lineStart+1}`;
      title.addEventListener("click", ()=>{
        // jump to line in textarea
        const lines=textarea.value.split("\n");
        let pos=0; for(let k=0;k<s.lineStart;k++) pos+= lines[k].length+1;
        textarea.focus(); textarea.setSelectionRange(pos, pos);
        // also scroll preview to heading if visible
        const head = preview.querySelectorAll("h1,h2,h3,h4,h5,h6")[i];
        head?.scrollIntoView({behavior:"smooth", block:"nearest"});
      });
      const focusBtn=document.createElement("button");
      focusBtn.type="button"; focusBtn.className="ws-chip-btn"; focusBtn.textContent="Focus";
      focusBtn.title="Zoom into this section only";
      focusBtn.addEventListener("click", (e)=>{ e.stopPropagation(); enterFocus(s); });
      const expandBtn=document.createElement("button");
      expandBtn.type="button"; expandBtn.className="ws-chip-btn"; expandBtn.textContent="✦ Expand";
      expandBtn.title="Expand with AI";
      expandBtn.addEventListener("click", (e)=>{ e.stopPropagation(); openAssistantFor(s); });
      row.append(badge, title, focusBtn, expandBtn);
      out.appendChild(row);
    });
    if(secSel){
      const prev = secSel.value;
      secSel.replaceChildren();
      const opt0=document.createElement("option"); opt0.value=""; opt0.textContent="Choose a section…"; secSel.appendChild(opt0);
      sections.forEach(s=>{ const o=document.createElement("option"); o.value=s.id; o.textContent=`${"#".repeat(s.level)} ${s.title}`; secSel.appendChild(o); });
      if(prev) secSel.value=prev;
    }
  }
  function getActiveSectionIndex(sections){
    if(!sections.length) return -1;
    const pos = textarea.selectionStart;
    const lines=textarea.value.slice(0,pos).split("\n").length -1;
    let best=-1;
    for(let i=0;i<sections.length;i++) if(lines >= sections[i].lineStart) best=i;
    return best;
  }
  function enterFocus(section){
    if(focusSection) exitFocus();
    focusSection = section;
    fullSourceBackup = textarea.value;
    const {filtered}= focusLines(textarea.value, section);
    textarea.value = filtered;
    textarea.dispatchEvent(new Event("input",{bubbles:true}));
    $("nb-focus-banner").hidden=false;
    $("nb-focus-title").textContent = section.title;
    logSave(`🔍 Focus mode: zoomed into "${section.title}" (${section.lineStart+1}–${section.lineEnd+1})`);
    renderOutline();
  }
  function exitFocus(){
    if(!focusSection) return;
    const cur = textarea.value;
    const restored = unfocusLines(fullSourceBackup, cur, focusSection);
    textarea.value = restored;
    textarea.dispatchEvent(new Event("input",{bubbles:true}));
    logSave(`🔍 Exit focus: restored full document`);
    focusSection=null; fullSourceBackup="";
    $("nb-focus-banner").hidden=true;
    renderOutline();
  }
  $("nb-exit-focus")?.addEventListener("click", exitFocus);
  textarea.addEventListener("keyup", renderOutline);
  textarea.addEventListener("click", renderOutline);

  function scheduleAISectionRefresh(){ /* outline refresh already */ }
  function openAssistantFor(section){
    const sel=$("nb-ai-section"); if(sel) sel.value=section.id;
    $("nb-ai-instruction")?.focus();
    document.querySelector(".nb-side-right")?.scrollIntoView({behavior:"smooth"});
  }

  // --- Tasks aggregation
  function renderTasks(){
    const root=$("nb-tasks"), sum=$("nb-task-summary"), prog=$("nb-task-progress");
    if(!root) return;
    const tasks = parseTasks(textarea.value);
    const {total,done,percent}= taskStats(tasks);
    if(sum) sum.textContent = total ? `${done}/${total} done` : "No tasks";
    if(prog) prog.style.width = `${percent}%`;
    root.replaceChildren();
    if(!tasks.length){
      const p=document.createElement("p"); p.className="nb-soft"; p.textContent="No tasks yet — add a checkbox with • List → ☑ Task or type '- [ ] Buy milk'.";
      root.appendChild(p); return;
    }
    const groups = groupTasks(tasks);
    for(const g of groups){
      const gh=document.createElement("div"); gh.className="nb-task-group"; gh.textContent=g.group;
      root.appendChild(gh);
      for(const t of g.items){
        const row=document.createElement("div"); row.className="nb-task-row";
        const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=t.checked; cb.setAttribute("aria-label", t.text);
        cb.addEventListener("change", ()=>{
          const next = toggleTaskLine(textarea.value, t.lineIndex, cb.checked);
          if(next!==textarea.value){ textarea.value=next; textarea.dispatchEvent(new Event("input",{bubbles:true})); renderTasks(); editor.renderPreview(); logSave(`✅ Task ${cb.checked ? "done" : "reopened"}: "${t.text.slice(0,40)}"`); }
        });
        const txt=document.createElement("span"); txt.className="nb-task-text"+(t.checked?" is-done":""); txt.textContent=t.text; txt.title=t.text;
        txt.addEventListener("click", ()=>{
          // jump to line
          const lines=textarea.value.split("\n"); let pos=0; for(let k=0;k<t.lineIndex;k++) pos+= lines[k].length+1;
          textarea.focus(); textarea.setSelectionRange(pos, pos + lines[t.lineIndex].length);
        });
        const meta=document.createElement("span"); meta.className="nb-task-meta"; meta.textContent=`L${t.lineIndex+1}`;
        row.append(cb, txt, meta);
        root.appendChild(row);
      }
    }
  }
  $("nb-add-task")?.addEventListener("click", ()=>{
    const inp=$("nb-new-task"); const text=(inp?.value||"").trim()||"New task";
    const curSections=parseOutline(textarea.value);
    const active = curSections[getActiveSectionIndex(curSections)]?.title || "";
    textarea.value = insertTask(textarea.value, {groupTitle: active, text});
    textarea.dispatchEvent(new Event("input",{bubbles:true}));
    if(inp) inp.value=""; renderTasks(); textarea.focus();
    logSave(`➕ Added task "${text.slice(0,40)}"`);
  });
  $("nb-new-task")?.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); $("nb-add-task")?.click(); } });
  $("nb-copy-tasks")?.addEventListener("click", async()=>{
    const tasks=parseTasks(textarea.value);
    const md = tasks.map(t=>`- [${t.checked?"x":" "}] ${t.text}`).join("\n") || "";
    try{ await navigator.clipboard.writeText(md); setStatus("nb-status","Tasks copied.","success"); } catch{ setStatus("nb-status","Select and copy manually.", "error"); }
  });

  // --- BYOK assistant
  let pendingAI=null, aiAbort=null;
  function currentSectionForAI(){
    const sel=$("nb-ai-section")?.value || "";
    if(!sel) return null;
    const sections=parseOutline(textarea.value);
    return sections.find(s=>s.id===sel) || null;
  }
  $("nb-ai-preview")?.addEventListener("click", ()=>{
    const sec=currentSectionForAI();
    if(!sec){ setStatus("nb-ai-status","Choose a section first.","error"); return; }
    const instr=$("nb-ai-instruction")?.value || "";
    const preview = `Will expand "${sec.title}" (${sec.lineStart+1}–${sec.lineEnd+1}) with ${providerLabels()[$("nb-ai-provider")?.value] || $("nb-ai-provider")?.value}.\nExtra instruction: ${instr || "(none)"}\n---\n` + extractSection(textarea.value, sec).slice(0,1200);
    const ctx=$("nb-ai-context"); if(ctx){ ctx.textContent = preview; ctx.hidden=false; }
    pendingAI = { section: sec, instruction: instr };
    $("nb-ai-send").disabled=false;
    setStatus("nb-ai-status","Preview ready. Check what will be sent, then click Expand section.","");
  });
  $("nb-ai-section")?.addEventListener("change", ()=>{ pendingAI=null; $("nb-ai-send").disabled=true; const c=$("nb-ai-context"); if(c) c.hidden=true; setStatus("nb-ai-status","Preview your request before sending.",""); });
  $("nb-ai-instruction")?.addEventListener("input", ()=>{ pendingAI=null; $("nb-ai-send").disabled=true; });
  $("nb-ai-send")?.addEventListener("click", async()=>{
    if(!pendingAI) { setStatus("nb-ai-status","Preview the request first.","error"); return; }
    const provider=$("nb-ai-provider")?.value || "groq";
    const model=$("nb-ai-model")?.value?.trim() || "";
    let key = $("nb-ai-key")?.value?.trim() || "";
    if(!key) key = getStoredBYOK(provider);
    if(!key){ setStatus("nb-ai-status", `Enter a ${provider} API key or save one in Harness Hub.`, "error"); return; }
    const sec = pendingAI.section;
    if(aiAbort) aiAbort.abort();
    aiAbort = new AbortController();
    const sendBtn=$("nb-ai-send"); if(sendBtn) sendBtn.disabled=true;
    setStatus("nb-ai-status", `Expanding "${sec.title}" via ${providerLabels()[provider]}…`, "busy");
    logSave(`✦ AI expand: "${sec.title}" via ${provider}…`);
    try{
      const expanded = await expandSection({ provider, apiKey:key, model, sectionTitle: sec.title, sectionContent: extractSection(textarea.value, sec), instruction: pendingAI.instruction }, { signal: aiAbort.signal });
      // Replace section with expanded content
      const next = replaceSection(textarea.value, sec, expanded);
      textarea.value = next;
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
      setStatus("nb-ai-status", `Expanded "${sec.title}". Review and save.`, "success");
      logSave(`✦ AI expanded "${sec.title}" (${expanded.length} chars) — review then save`);
      renderOutline(); renderTasks();
    }catch(e){
      const msg = e.name==="AbortError" ? "Request cancelled." : e.message || "AI request failed";
      setStatus("nb-ai-status", msg, "error"); logSave(`✦ AI error: ${msg}`);
    } finally { if(sendBtn) sendBtn.disabled=false; aiAbort=null; }
  });
  $("nb-ai-provider")?.addEventListener("change", ()=>{
    const p=$("nb-ai-provider").value; $("nb-ai-model").value=""; $("nb-ai-key").value=getStoredBYOK(p) ? "" : "";
    pendingAI=null; $("nb-ai-send").disabled=true;
  });

  // --- Workspace manager (reuse NoteManager patterns)
  const panel=$("nb-files-panel"), filesBtn=$("nb-files-toggle"), closeBtn=$("nb-files-close");
  const listEl=$("nb-list"), filterEl=$("nb-filter"), dirsList=$("nb-dirs-list"), countEl=$("nb-files-count");
  const fileDirIn=$("nb-file-dir"), fileNameIn=$("nb-file-name"), fileExtSel=$("nb-file-ext"), filePreview=$("nb-file-preview"), newDirIn=$("nb-new-dir"), dirPreview=$("nb-dir-preview");
  const renameFileCur=$("nb-rename-file-current"), renameFileIn=$("nb-rename-file-input"), renameFilePrev=$("nb-rename-file-preview"), renameFileBtn=$("nb-rename-file-btn"), renameDirFrom=$("nb-rename-dir-from"), renameDirTo=$("nb-rename-dir-to"), renameDirPrev=$("nb-rename-dir-preview"), renameDirBtn=$("nb-rename-dir-btn");
  const pathIn=$("nb-gh-path"), branchIn=$("nb-gh-branch"), repoSel=$("nb-gh-repo"), saveBtn=$("nb-gh-save"), pullBtn=$("nb-gh-pull"), overBtn=$("nb-gh-overwrite"), autosaveCb=$("nb-gh-autosave");
  const ghPanel=$("nb-gh-panel"), ghOpenBtn=$("nb-gh-open"), ghCloseBtn=$("nb-gh-close"), ghSetupBtn=$("nb-gh-setup"), ghInstallBtn=$("nb-gh-install"), ghCheckBtn=$("nb-gh-check"), ghForgetBtn=$("nb-gh-forget"), ghExportBtn=$("nb-gh-export"), ghHint=$("nb-gh-hint"), ghTarget=$("nb-gh-target"), ghAccount=$("nb-gh-account"), ghStatusSet=(m,t)=>setStatus("nb-gh-status",m,t), fileStatusSet=(m,t)=>setStatus("nb-gh-file-status",m,t), wsStatusSet=(m,t)=>setStatus("nb-ws-status",m,t);

  let restoreText="";
  const NOTEBOOK_REPO="notebook";
  function showRepoHelp(html){ const el=$("nb-gh-repo-help"); if(el){ el.hidden=!html; el.innerHTML=html||""; } }
  function targetIsValid({quiet=false}={}){ const r=repoSel?.value, p=normalizePath(pathIn?.value); if(!r||!p){ if(!quiet) fileStatusSet("Choose a repository and file path first.","error"); return false; } return true; }

  // Path helpers
  const HAS_EXT=/\.[a-z0-9]{1,8}$/i;
  const pathWithExt=(v,ext)=>{ const p=normalizePath(v); if(!p) return ""; if(!ext||HAS_EXT.test(p.split("/").pop())) return p; return `${p}.${ext}`; };
  function computeTarget(){ const d=fileDirIn?.value.trim()||"", n=fileNameIn?.value.trim()||"", e=fileExtSel?.value ?? "md"; if(!n) return ""; const c=d?`${d}/${n}`:n; return pathWithExt(normalizeWorkspacePath(c), e); }
  function updatePreviews(){
    if(filePreview){ try{ const p=computeTarget(); if(p){ filePreview.innerHTML="Will create: <strong></strong>"; filePreview.querySelector("strong").textContent=p; } else filePreview.innerHTML=`Enter a file name (e.g. <strong>standup</strong> or <strong>${todayNoteFileName()}</strong>)`; } catch(e){ filePreview.textContent=e.message; } }
    if(dirPreview){ try{ const d=newDirIn?.value.trim() ? normalizeWorkspacePath(newDirIn.value) : ""; if(d){ dirPreview.innerHTML="Folder path: <strong></strong>"; dirPreview.querySelector("strong").textContent=d; } else dirPreview.innerHTML=`Today's folder: <strong>${todayFolderPath()}</strong>`; } catch(e){ dirPreview.textContent=e.message; } }
    if(renameFilePrev){ try{ const t=renameFileIn?.value.trim() ? normalizeWorkspacePath(renameFileIn.value) : ""; if(!t) renameFilePrev.textContent="Enter new path to preview"; else{ renameFilePrev.innerHTML="<strong></strong> → <strong></strong>"; const s=renameFilePrev.querySelectorAll("strong"); s[0].textContent = note?.path || normalizePath(pathIn?.value)||"—"; s[1].textContent=t; } } catch(e){ renameFilePrev.textContent=e.message; } }
    if(renameDirPrev){ try{ const f=renameDirFrom?.value.trim() ? normalizeWorkspacePath(renameDirFrom.value) : ""; const t=renameDirTo?.value.trim() ? normalizeWorkspacePath(renameDirTo.value) : ""; if(!f||!t) renameDirPrev.textContent="Choose folder and new name"; else{ renameDirPrev.innerHTML="📁 <strong></strong> → 📁 <strong></strong>"; const s=renameDirPrev.querySelectorAll("strong"); s[0].textContent=f; s[1].textContent=t; } } catch(e){ renameDirPrev.textContent=e.message; } }
  }
  [fileDirIn,fileNameIn,fileExtSel,newDirIn,renameFileIn,renameDirFrom,renameDirTo].forEach(el=>{ el?.addEventListener("input", updatePreviews); el?.addEventListener("change", updatePreviews); });

  function paintFileBarNb(){
    if(!pathIn) return;
    const repo=repoSel?.value||"", path=normalizePath(pathIn.value);
    $("nb-filebar-repo").textContent = repo || "Local only";
    $("nb-filebar-repo").title = repo ? repo : "Notes kept in this browser until GitHub connected";
    $("nb-filebar-sep").hidden=!repo;
    if($("nb-filebar-file")){ $("nb-filebar-file").textContent = path||"—"; $("nb-filebar-file").title=path||""; }
    const st=$("nb-filebar-state"); if(st){ st.textContent=barState.text; st.classList.toggle("is-saved", barState.tone==="success"); st.classList.toggle("is-error", barState.tone==="error"); }
    if($("nb-current")) $("nb-current").textContent=path||"";
    if(renameFileCur) renameFileCur.textContent= note?.path || path || "—";
  }
  function setBarStateNb(t, tone=""){ barState={text:t,tone}; paintFileBarNb(); }

  // Load initial notebook path
  pathIn.value = (await store.kvGet(NB_KEYS.path)) || todayNoteFileName();
  branchIn.value = (await store.kvGet(NB_KEYS.branch)) || "";
  if(autosaveCb) autosaveCb.checked = (await store.kvGet(NB_KEYS.autosave)) !== "false";
  // Ensure current note index has this path
  {
    const mapPath = normalizePath(pathIn.value);
    const all = await notes.list();
    if(!all.some(x=>x.path===mapPath)){
      // will be handled by switch
    }
  }

  async function refreshWorkspaceList(){
    if(!listEl) return;
    const localNotes = await notes.list();
    const localFolders = await notes.listFolders();
    const activeRepo = repoSel?.value||"";
    const hasRemote = Boolean(lastConnection.ready && activeRepo && remoteWorkspace.repo===activeRepo);
    const allDirs = new Set(localFolders);
    if(hasRemote) remoteWorkspace.dirs.forEach(d=>allDirs.add(d));
    const noteMap=new Map();
    for(const it of localNotes) noteMap.set(it.path, {path:it.path, local:true, dirty:!!it.dirty, syncedAt:it.syncedAt||0, remote: hasRemote && remoteWorkspace.files.some(f=>f.path===it.path), updatedAt:it.updatedAt||0});
    if(hasRemote) for(const f of remoteWorkspace.files){ if(f.path.endsWith("/.gitkeep")|| f.path===".gitkeep") continue; if(!noteMap.has(f.path)) noteMap.set(f.path, {path:f.path, local:false, dirty:false, syncedAt:1, remote:true, updatedAt:0}); }
    if(countEl) countEl.textContent= String(noteMap.size||1);
    if(dirsList){ dirsList.replaceChildren(); [...allDirs].sort().forEach(d=>{ const o=document.createElement("option"); o.value=d; dirsList.appendChild(o); }); }
    const q=(filterEl?.value||"").trim().toLowerCase();
    const dirs=[...allDirs].sort().filter(d=>!q || d.toLowerCase().includes(q));
    const notesArr=[...noteMap.values()].filter(n=>!q || n.path.toLowerCase().includes(q)).sort((a,b)=>{
      if(a.path===note?.path) return -1; if(b.path===note?.path) return 1;
      if(b.updatedAt!==a.updatedAt) return b.updatedAt-a.updatedAt; return a.path.localeCompare(b.path);
    });
    listEl.replaceChildren();
    if(dirs.length){
      const h=document.createElement("div"); h.className="ws-mini-label"; h.textContent=`Folders (${dirs.length})`; listEl.appendChild(h);
      for(const d of dirs){
        const row=document.createElement("div"); row.className="ws-item"; row.setAttribute("role","listitem");
        const ic=document.createElement("span"); ic.textContent="📁";
        const lb=document.createElement("span"); lb.className="ws-item-path"; lb.textContent=d; lb.title=d;
        const add=document.createElement("button"); add.type="button"; add.className="ws-chip-btn"; add.textContent="+ File"; add.addEventListener("click", ()=>{ if(fileDirIn) fileDirIn.value=d; updatePreviews(); fileNameIn?.focus(); });
        const ren=document.createElement("button"); ren.type="button"; ren.className="ws-chip-btn"; ren.textContent="Rename"; ren.addEventListener("click", ()=>{ if(renameDirFrom) renameDirFrom.value=d; updatePreviews(); renameDirTo?.focus(); pulse($("nb-rename-card"),"is-pulsing"); });
        row.append(ic, lb, add, ren); listEl.appendChild(row);
      }
    }
    const nh=document.createElement("div"); nh.className="ws-mini-label"; nh.style.marginTop=dirs.length?".35rem":"0"; nh.textContent=`Files (${notesArr.length})`; listEl.appendChild(nh);
    if(!notesArr.length){ const e=document.createElement("p"); e.className="modal-hint"; e.textContent= q ? `No files match "${q}".` : "No files yet."; listEl.appendChild(e); return; }
    for(const entry of notesArr){
      const active= entry.path===note?.path;
      const row=document.createElement("div"); row.className="ws-item"+(active?" is-active":""); row.setAttribute("role","listitem");
      const open=document.createElement("button"); open.type="button"; open.className="ws-item-open";
      const ico=document.createElement("span"); ico.textContent= active?"📝":"📄";
      const lb=document.createElement("span"); lb.className="ws-item-path"; lb.textContent=entry.path;
      open.append(ico,lb);
      open.addEventListener("click", async()=>{
        if(active){ textarea.focus(); return; }
        await flushLocalSave();
        if(entry.local){ const nxt=await notes.switchTo(entry.path); await switchNote(nxt, `Switched to ${entry.path}.`); return; }
        const repo=repoSel?.value||"", branch=branchIn?.value.trim()||"";
        wsStatusSet(`Loading ${entry.path} from ${repo}…`);
        try{
          const remote=await gh.readRepoFile(repo, entry.path, branch);
          if(!remote){ wsStatusSet(`${entry.path} not found in ${repo}.`,"error"); return; }
          await gh.rememberSha(engine.fileKey(repo, entry.path, branch), remote.sha);
          const nxt=await notes.switchTo(entry.path, {repo, branch, initialBody: remote.content});
          await notes.markSynced(entry.path); await switchNote(nxt, `Opened ${entry.path} from ${repo}.`); wsStatusSet(`Opened ${entry.path}.`,"success");
        }catch(err){ wsStatusSet(err.message,"error"); }
      });
      const badge=document.createElement("span"); badge.className="ws-badge";
      if(active){ badge.classList.add("is-active"); badge.textContent="Active"; }
      else if(entry.remote && !entry.local){ badge.classList.add("is-repo"); badge.textContent="Repo"; }
      else if(entry.local && lastConnection.ready && entry.dirty){ badge.classList.add("is-local"); badge.textContent="Unsynced"; }
      else if(entry.local && entry.syncedAt && !entry.dirty){ badge.classList.add("is-repo"); badge.textContent="Synced"; }
      else { badge.classList.add("is-local"); badge.textContent="Device"; }
      row.append(open, badge);
      if(active){
        const rb=document.createElement("button"); rb.type="button"; rb.className="ws-chip-btn"; rb.textContent="Rename"; rb.addEventListener("click", ()=>{ if(renameFileIn) renameFileIn.value=entry.path; updatePreviews(); renameFileIn?.focus(); renameFileIn?.select(); pulse($("nb-rename-card"),"is-pulsing"); });
        row.appendChild(rb);
      }
      listEl.appendChild(row);
    }
  }
  async function refreshRemoteWorkspace({announce=false}={}){
    const repo=repoSel?.value||""; if(!lastConnection.ready || !repo){ remoteWorkspace={files:[],dirs:[],repo:""}; await refreshWorkspaceList(); if(announce) wsStatusSet("Showing files on this device. Connect GitHub to see remote files."); return; }
    if(announce) wsStatusSet(`Refreshing from ${repo}…`);
    const branch=branchIn?.value.trim()||""; const tree=await engine.listWorkspace({repo, branch});
    if(tree.status==="loaded"){ remoteWorkspace={files:tree.files||[], dirs:tree.dirs||[], repo}; await refreshWorkspaceList(); if(announce) wsStatusSet(`Loaded ${remoteWorkspace.files.length} files and ${remoteWorkspace.dirs.length} folders from ${repo}.`,"success"); }
    else if(announce && tree.error) wsStatusSet(`Could not load repo tree: ${tree.error.message}`,"error");
  }
  function openPanel(){ if(!panel) return; panel.hidden=false; filesBtn?.setAttribute("aria-expanded","true"); filesBtn?.classList.add("is-open"); updatePreviews(); refreshWorkspaceList(); }
  function closePanel(){ if(!panel) return; panel.hidden=true; filesBtn?.setAttribute("aria-expanded","false"); filesBtn?.classList.remove("is-open"); }

  async function switchNote(next, msg){
    note=next; textarea.value= note.body||""; pathIn.value=note.path; if(note.branch) branchIn.value=note.branch;
    await store.kvSet(NB_KEYS.path, note.path);
    engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true;
    paintFileBarNb(); paintClarity(); editor.renderPreview(); renderOutline(); renderTasks();
    const cur=$("nb-current"); if(cur) cur.textContent=note.path;
    if(renameFileIn && document.activeElement!==renameFileIn) renameFileIn.value=note.path;
    updatePreviews(); await refreshWorkspaceList();
    if(msg) setStatus("nb-status", msg, "success");
    textarea.focus();
  }

  // Quick actions
  async function handleToday(){
    await flushLocalSave();
    const nxt=await notes.openToday();
    await switchNote(nxt, nxt.body ? `Reopened today's note (${nxt.path})` : `Today's note is ${nxt.path} — reuse it all day.`);
  }
  async function handleNewTimed(){
    await flushLocalSave();
    const nxt=await notes.newDatedNote();
    // ensure outline if .md
    if(/\.md$/i.test(nxt.path) && !nxt.body?.trim()) nxt.body = createNoteOutline(nxt.path);
    await switchNote(nxt, `Started new timed note: ${nxt.path}.`);
  }
  async function handleTodayFolder(){ await createDirectoryEverywhere(todayFolderPath()); }
  async function createDirectoryEverywhere(rawDir){
    let dirPath; try{ dirPath=normalizeWorkspacePath(rawDir); } catch(e){ wsStatusSet(e.message,"error"); return {ok:false}; }
    if(!dirPath){ wsStatusSet("Type a folder path — notes/2026-11-09, for example.","error"); return {ok:false}; }
    const localRes=await notes.createFolder(dirPath);
    if(fileDirIn) fileDirIn.value=dirPath; if(renameDirFrom && !renameDirFrom.value) renameDirFrom.value=dirPath; updatePreviews(); await refreshWorkspaceList();
    const repo=repoSel?.value||"", branch=branchIn?.value.trim()||"";
    if(lastConnection.ready && repo){
      const keep=`${dirPath}/.gitkeep`;
      try{
        const existing=await gh.readRepoFile(repo, keep, branch);
        if(!existing){
          const res=await engine.saveNote({repo, path:keep, branch, content:"", forced:true});
          if(res.status==="queued"){ const m=`Created "${dirPath}" on device; queued .gitkeep for ${repo} when online.`; wsStatusSet(m,"success"); logSave(m); return {ok:true, dirPath}; }
          if(res.status!=="created" && res.status!=="updated"){ const m=`Created "${dirPath}" locally (GitHub: ${res.error?.message||res.status})`; wsStatusSet(m,"error"); return {ok:false, dirPath}; }
        }
        if(!remoteWorkspace.dirs.includes(dirPath)) remoteWorkspace.dirs.push(dirPath); await refreshWorkspaceList();
        const msg= localRes.existed ? `Folder "${dirPath}" ready locally and in ${repo}.` : `Created folder "${dirPath}" locally and in ${repo}.`; wsStatusSet(msg,"success"); logSave(msg); return {ok:true, dirPath};
      }catch(err){ const m=`Created "${dirPath}" on device (${err.message})`; wsStatusSet(m,"error"); return {ok:true, dirPath}; }
    }
    const msg= localRes.existed ? `Folder "${dirPath}" ready on this device.` : `Created folder "${dirPath}" on this device (connect GitHub to sync).`; wsStatusSet(msg,"success"); logSave(msg); return {ok:true, dirPath};
  }
  $("nb-today")?.addEventListener("click", handleToday);
  $("nb-preset-today")?.addEventListener("click", handleToday);
  $("nb-new-timed")?.addEventListener("click", handleNewTimed);
  $("nb-today-folder")?.addEventListener("click", handleTodayFolder);
  $("nb-preset-today-folder")?.addEventListener("click", handleTodayFolder);
  $("nb-preset-today-in-folder")?.addEventListener("click", async()=>{ await flushLocalSave(); const dir=todayFolderPath(); await notes.createFolder(dir); const nxt=await notes.newDatedNote({folder: dir}); await switchNote(nxt, `Created ${nxt.path} inside ${dir}.`); wsStatusSet(`Opened ${nxt.path} inside today's folder.`,"success"); logSave(`📁 Created timed note in today's folder: ${nxt.path}`); });
  filesBtn?.addEventListener("click", ()=> panel.hidden ? openPanel() : closePanel());
  $("nb-files-close")?.addEventListener("click", closePanel);
  filterEl?.addEventListener("input", refreshWorkspaceList);
  $("nb-refresh")?.addEventListener("click", ()=> refreshRemoteWorkspace({announce:true}));
  $("nb-fill-today-dir")?.addEventListener("click", ()=>{ if(fileDirIn) fileDirIn.value=todayFolderPath(); updatePreviews(); fileNameIn?.focus(); });
  $("nb-fill-today-folder")?.addEventListener("click", ()=>{ if(newDirIn) newDirIn.value=todayFolderPath(); updatePreviews(); newDirIn?.focus(); });
  $("nb-create-blank")?.addEventListener("click", ()=> handleCreateFile(false));
  $("nb-create-from-current")?.addEventListener("click", ()=> handleCreateFile(true));
  fileNameIn?.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); handleCreateFile(false); }});
  $("nb-create-dir")?.addEventListener("click", async()=>{ const r=await createDirectoryEverywhere(newDirIn?.value||""); if(r.ok && newDirIn) newDirIn.value=""; updatePreviews(); });
  newDirIn?.addEventListener("keydown", async e=>{ if(e.key==="Enter"){ e.preventDefault(); const r=await createDirectoryEverywhere(newDirIn.value); if(r.ok) newDirIn.value=""; updatePreviews(); }});

  async function handleCreateFile(copyCurrent){
    let targetPath; try{ targetPath=computeTarget(); } catch(e){ wsStatusSet(e.message,"error"); return; }
    if(!targetPath){ wsStatusSet("Enter a file name first.","error"); fileNameIn?.focus(); return; }
    const existingLocal=(await notes.list()).some(x=>x.path===targetPath);
    if(existingLocal){ wsStatusSet(`A file already exists at "${targetPath}" — pick it or choose another name.`,"error"); return; }
    await flushLocalSave();
    const content = copyCurrent ? textarea.value : createNoteOutline(targetPath);
    const repo=repoSel?.value||"", branch=branchIn?.value.trim()||"";
    if(lastConnection.ready && repo){
      try{ const remoteExisting=await gh.readRepoFile(repo, targetPath, branch); if(remoteExisting){ wsStatusSet(`${repo} already has "${targetPath}" — refresh to open it.`,"error"); return; } } catch{}
    }
    const created=await notes.switchTo(targetPath, {repo, branch, initialBody: content});
    note=await notes.setBody(content, {dirty:true});
    if(fileNameIn) fileNameIn.value=""; await switchNote(created);
    if(lastConnection.ready && repo){
      const res=await engine.saveNote({repo, path:targetPath, branch, content, forced:true});
      if(res.status==="created"||res.status==="updated"){ await notes.markSynced(targetPath); await refreshOutboxBadge(); await refreshWorkspaceList(); const m=`Created ${targetPath} locally and in ${repo}.`; wsStatusSet(m,"success"); logSave(m); setBarStateNb(`Synced to GitHub · ${new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`,"success"); paintClarity(); return; }
      if(res.status==="queued"){ await refreshOutboxBadge(); const m=`Created ${targetPath} on device — queued for ${repo} when online.`; wsStatusSet(m,"success"); logSave(m); paintClarity(); return; }
      if(res.error){ wsStatusSet(`Created ${targetPath} locally, but GitHub: ${res.error.message}`,"error"); return; }
    }
    const m=`Created ${targetPath} on this device.`; wsStatusSet(m,"success"); logSave(m);
  }

  async function handleRenameFile(){
    await flushLocalSave();
    const oldPath=note?.path || normalizePath(pathIn.value);
    let newPath; try{ newPath=normalizeWorkspacePath(renameFileIn?.value||""); } catch(e){ wsStatusSet(e.message,"error"); return; }
    if(!oldPath){ wsStatusSet("No active file to rename.","error"); return; }
    if(!newPath){ wsStatusSet("Enter new file name/path.","error"); renameFileIn?.focus(); return; }
    if(oldPath===newPath){ wsStatusSet("Choose a different path.","error"); return; }
    if((await notes.list()).some(x=>x.path===newPath)){ wsStatusSet(`A note already exists at "${newPath}".`,"error"); return; }
    const repo=repoSel?.value||"", branch=branchIn?.value.trim()||"";
    wsStatusSet(`Renaming ${oldPath} → ${newPath}…`);
    if(renameFileBtn) renameFileBtn.disabled=true;
    try{
      const syncRes=await engine.renameFile({repo, oldPath, newPath, branch, content:textarea.value});
      if(syncRes.status==="error"){ wsStatusSet(syncRes.error?.message || "Could not rename on GitHub.","error"); return; }
      const moved=await notes.renameNote(oldPath, newPath, {body:textarea.value});
      note=moved.note;
      if(syncRes.status==="renamed") await notes.markSynced(newPath);
      pathIn.value=newPath; await store.kvSet(NB_KEYS.path, newPath);
      if(remoteWorkspace.repo===repo) remoteWorkspace.files = remoteWorkspace.files.map(f=> f.path===oldPath ? {...f, path:newPath} : f);
      await refreshOutboxBadge(); paintFileBarNb(); paintClarity(); updatePreviews(); await refreshWorkspaceList();
      let msg; if(syncRes.status==="renamed"){ msg=`Renamed "${oldPath}" → "${newPath}" locally and in ${repo}.`; setBarStateNb(`Synced to GitHub · ${new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`,"success"); }
      else if(syncRes.status==="partial") msg=`Renamed locally and created new file in ${repo}, but deleting old file failed: ${syncRes.deleteError?.message||"error"}.`;
      else if(syncRes.status==="not-remote") msg=`Renamed "${oldPath}" → "${newPath}" on device (old file wasn't on GitHub yet).`;
      else msg=`Renamed "${oldPath}" → "${newPath}" on device.`;
      wsStatusSet(msg, syncRes.status==="partial" ? "error" : "success"); logSave(msg); pulse($("nb-filebar"),"is-pulsing");
    }catch(err){ wsStatusSet(err.message,"error"); } finally{ if(renameFileBtn) renameFileBtn.disabled=false; }
  }
  async function handleRenameDir(){
    await flushLocalSave();
    let oldDir, newDir; try{ oldDir=normalizeWorkspacePath(renameDirFrom?.value||""); newDir=normalizeWorkspacePath(renameDirTo?.value||""); } catch(e){ wsStatusSet(e.message,"error"); return; }
    if(!oldDir){ wsStatusSet("Choose folder to rename.","error"); renameDirFrom?.focus(); return; }
    if(!newDir){ wsStatusSet("Enter new folder name.","error"); renameDirTo?.focus(); return; }
    if(oldDir===newDir){ wsStatusSet("New folder must differ.","error"); return; }
    if(newDir.startsWith(`${oldDir}/`)){ wsStatusSet("Cannot move folder inside itself.","error"); return; }
    const repo=repoSel?.value||"", branch=branchIn?.value.trim()||"";
    wsStatusSet(`Renaming folder "${oldDir}" → "${newDir}"…`); if(renameDirBtn) renameDirBtn.disabled=true;
    try{
      const syncRes=await engine.renameDirectory({repo, oldDir, newDir, branch});
      if(syncRes.status==="error"){ wsStatusSet(syncRes.error?.message || "Could not rename folder on GitHub.","error"); return; }
      const localMoved=await notes.renameDirectory(oldDir, newDir);
      note=notes.current;
      if(note?.path){ pathIn.value=note.path; await store.kvSet(NB_KEYS.path, note.path); }
      const prefix=`${oldDir}/`;
      if(remoteWorkspace.repo===repo){
        remoteWorkspace.files = remoteWorkspace.files.map(f=> f.path.startsWith(prefix) ? {...f, path:`${newDir}/${f.path.slice(prefix.length)}`} : f);
        remoteWorkspace.dirs = remoteWorkspace.dirs.map(d=> d===oldDir ? newDir : d.startsWith(prefix) ? `${newDir}/${d.slice(prefix.length)}` : d);
      }
      if(renameDirFrom) renameDirFrom.value=newDir; if(renameDirTo) renameDirTo.value="";
      await refreshOutboxBadge(); paintFileBarNb(); paintClarity(); updatePreviews(); await refreshWorkspaceList();
      const lc=localMoved.movedNotes.length, rc=(syncRes.moved||[]).length;
      let msg; if(syncRes.status==="renamed"){ msg=`Renamed folder "${oldDir}" → "${newDir}" (${rc} files in ${repo}, ${lc} locally).`; setBarStateNb(`Synced to GitHub · ${new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`,"success"); }
      else if(syncRes.status==="partial") msg=`Renamed folder "${oldDir}" → "${newDir}" locally; some old GitHub files couldn't be deleted.`;
      else msg=`Renamed folder "${oldDir}" → "${newDir}" on device (${lc} notes updated).`;
      wsStatusSet(msg, syncRes.status==="partial" ? "error":"success"); logSave(msg); pulse($("nb-explorer"),"is-pulsing");
    }catch(err){ wsStatusSet(err.message,"error"); } finally{ if(renameDirBtn) renameDirBtn.disabled=false; }
  }
  $("nb-rename-file-open")?.addEventListener("click", ()=>{ if(renameFileIn) renameFileIn.value=note?.path||""; panel.hidden=false; filesBtn?.setAttribute("aria-expanded","true"); updatePreviews(); renameFileIn?.focus(); renameFileIn?.select(); pulse($("nb-rename-card"),"is-pulsing"); });
  $("nb-filebar-rename")?.addEventListener("click", ()=> $("nb-rename-file-open")?.click());
  $("nb-rename-dir-open")?.addEventListener("click", async()=>{ const p=parentFolderOf(note?.path||""); const folders=await notes.listFolders(); const init=p||folders[0]||todayFolderPath(); if(renameDirFrom) renameDirFrom.value=init; panel.hidden=false; updatePreviews(); renameDirTo?.focus(); });
  renameFileBtn?.addEventListener("click", handleRenameFile);
  renameFileIn?.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); handleRenameFile(); }});
  renameDirBtn?.addEventListener("click", handleRenameDir);
  renameDirTo?.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); handleRenameDir(); }});

  // GitHub sync (simplified but transparent)
  async function renderGh(){
    const conn=await gh.connection(); lastConnection=conn;
    const secure=gh.cryptoReady();
    ghSetupBtn.hidden = conn.kind!=="none";
    ghInstallBtn.hidden= !(conn.kind==="app" && !conn.installationId);
    ghCheckBtn.hidden= !(conn.kind==="app" && conn.installationId);
    ghForgetBtn.hidden= conn.kind==="none";
    $("nb-gh-token-clear").hidden = conn.kind!=="token";
    ghTarget.hidden = !conn.ready;
    if(exportBtn) exportBtn.hidden = conn.kind!=="app";
    if($("nb-gh-keep")) $("nb-gh-keep").hidden = !(conn.kind==="app" && !conn.app.connection_saved_at);
    const badge=$("nb-gh-launch"); if(badge){ badge.textContent = conn.kind==="app" ? (conn.installationId ? "connected" : "install") : conn.kind==="token" ? "token" : ""; badge.classList.toggle("is-connected", conn.kind==="app" && !!conn.installationId); }
    if(conn.kind==="app"){ ghAccount.textContent = conn.installationId ? `Connected${conn.label?` — ${conn.label}`:""}` : `App registered${conn.app.owner?` as @${conn.app.owner}`:""} — not installed yet`; ghAccount.classList.toggle("is-connected", !!conn.installationId); }
    else if(conn.kind==="token"){ ghAccount.textContent=`Using token${conn.label?` (@${conn.label})`:""}`; ghAccount.classList.add("is-connected"); }
    else { ghAccount.textContent=""; ghAccount.classList.remove("is-connected"); }
    if(ghHint){
      if(!secure) ghHint.textContent="GitHub setup needs https:// or http://localhost — use a token under Advanced for file://.";
      else if(conn.kind==="none") ghHint.textContent="One click registers a private GitHub App owned by you, then you pick the repo it may write to. Restore an existing app via Reconnect instead of creating another.";
      else if(conn.kind==="app" && !conn.installationId) ghHint.textContent="Last step: choose repos the app may write to on GitHub, then you'll be back here.";
      else ghHint.textContent="Connected. Notes commit with short-lived tokens minted on this device. No sign-in needed on return.";
    }
    paintFileBarNb(); paintClarity();
    if(conn.ready && !reposLoaded) await loadRepos();
    await refreshOutboxBadge(); await refreshWorkspaceList();
  }
  async function loadRepos({announce=false, createScratch=true}={}){
    let hasScratch=false;
    try{
      const repos=await gh.listRepositories();
      const previous = await store.kvGet(NB_KEYS.notebookRepo) || await store.kvGet(GH_KEYS.repo) || repoSel?.value || "";
      // Offer notebook repo as default
      const scratchEntry = repos.find(r=> r.name===NOTEBOOK_REPO) || null;
      const defaultName = scratchEntry ? scratchEntry.full_name : await gh.scratchRepoFullName().then(n=> n.replace(/\/scratch$/, `/${NOTEBOOK_REPO}`)).catch(()=> "");
      repoSel.replaceChildren();
      if(!repos.length){ const o=document.createElement("option"); o.value=""; o.textContent="No repos yet — Use notebook repo creates one"; repoSel.appendChild(o); }
      repos.forEach(r=>{ const o=document.createElement("option"); o.value=r.full_name; o.textContent= r.name===NOTEBOOK_REPO ? `${r.full_name} (default)` : r.full_name; repoSel.appendChild(o); });
      if(defaultName && !repos.some(r=>r.full_name===defaultName)){ const o=document.createElement("option"); o.value=defaultName; o.textContent=`${defaultName} (default)`; repoSel.insertBefore(o, repoSel.firstChild); }
      if(defaultName) repoSel.value=defaultName;
      if(!repoSel.value){ const m=repos.find(r=>r.full_name===previous); repoSel.value = m ? m.full_name : (repos.length ? repos[0].full_name : ""); }
      if(repoSel.value) await store.kvSet(NB_KEYS.notebookRepo, repoSel.value);
      hasScratch = Boolean(scratchEntry);
      reposLoaded=true; paintFileBarNb(); paintClarity();
      if(hasScratch) showRepoHelp("");
      if(announce) ghStatusSet(`${repos.length} repos available.`,"success");
      else if(!repos.length) ghStatusSet("No repos yet — app can create one for you.","");
    }catch(e){ ghStatusSet(e.message,"error"); return; }
    if(!hasScratch && createScratch) await ensureNotebookRepo({automatic:true});
    if(repoSel?.value) refreshRemoteWorkspace().catch(()=>{});
  }
  async function ensureNotebookRepo({automatic=false}={}){
    if(!lastConnection.ready) return;
    if(automatic && scratchAttempted) return;
    scratchAttempted=true;
    ghStatusSet(`Creating private “${NOTEBOOK_REPO}” repo…`); showRepoHelp("");
    let result;
    try{
      // reuse scratch logic but with notebook name
      const conn=await gh.connection();
      const owner= conn.kind==="app" ? (conn.app.installation_account || conn.app.owner || "") : "";
      const accountType= conn.kind==="app" ? (conn.app.installation_type || "User") : "User";
      const createPath = accountType==="Organization" && owner ? `/orgs/${owner}/repos` : "/user/repos";
      const res=await gh.authorizedFetch(createPath, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ name: NOTEBOOK_REPO, description:"Notebook notes from Dash.", private:true, auto_init:true })});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) throw Object.assign(new Error(data.message || `GitHub API error (${res.status})`), {status: res.status});
      const fullName=data.full_name || `${owner}/${NOTEBOOK_REPO}`;
      await store.kvSet(NB_KEYS.notebookRepo, fullName);
      reposLoaded=false; await loadRepos({createScratch:false});
      if(![...repoSel.options].some(o=>o.value===fullName)){ const o=document.createElement("option"); o.value=fullName; o.textContent=fullName; repoSel.appendChild(o); }
      repoSel.value=fullName; paintFileBarNb(); paintClarity();
      ghStatusSet(`Ready — notes saved to private “${NOTEBOOK_REPO}” repo (${fullName}).`,"success"); logSave(`📦 Created repo ${fullName}`); showRepoHelp("");
      result={ok:true, repo:fullName};
    }catch(error){
      const app=await gh.readApp(); const slug=app && (app.slug||app.name); const settingsUrl= slug ? `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions` : "https://github.com/settings/apps";
      const newRepoUrl=`https://github.com/new?name=${encodeURIComponent(NOTEBOOK_REPO)}&private=1`;
      const alreadyExists= error.status===422 && /already exists/i.test(error.message);
      const usable=repoSel?.value;
      if(alreadyExists) ghStatusSet(`A repo named “${NOTEBOOK_REPO}” already exists but app can't see it. Add it to installation, then Re-check.`,"error");
      else if(automatic && usable) ghStatusSet(`Tip: “${NOTEBOOK_REPO}” not created (${error.message}). Notes still save to ${usable}.`);
      else ghStatusSet(`GitHub couldn't create “${NOTEBOOK_REPO}” (${error.message}).`,"error");
      showRepoHelp(`Grant <strong>Repository creation: write</strong> in <a href="${settingsUrl}" target="_blank" rel="noopener">app permissions</a> and accept on installation — or <a href="${newRepoUrl}" target="_blank" rel="noopener">create “${NOTEBOOK_REPO}” yourself</a> then Re-check.`);
      return;
    }
    return result;
  }
  async function saveNotes({forced=false, auto=false}={}){
    if(engine.saving) return;
    if(!targetIsValid({quiet:auto})){ if(!auto) ghPanel.showModal?.(); return; }
    await flushLocalSave();
    const repo=repoSel.value, path=normalizePath(pathIn.value), branch=branchIn.value.trim();
    if(!auto){ fileStatusSet("Checking file hasn't changed on GitHub…"); logSave(`☁️ Save check: ${repo}/${path}${branch?` @${branch}`:""}`); }
    saveBtn.disabled=true; if(quickSaveBtn) quickSaveBtn.disabled=true;
    try{
      const res=await engine.saveNote({repo, path, branch, content:textarea.value, forced, auto});
      const now=()=> new Date().toLocaleTimeString([],{hour:"2-digit", minute:"2-digit"});
      switch(res.status){
        case "disconnected": ghPanel.showModal?.(); fileStatusSet("Connect GitHub first.","error"); logSave("☁️ Save failed: not connected"); break;
        case "invalid-target": fileStatusSet("Choose repo and file path.","error"); break;
        case "busy": break;
        case "conflict": $("nb-gh-overwrite").hidden=false; fileStatusSet(res.knownSha ? `${path} changed on GitHub since last sync. Pull latest or Overwrite anyway.` : `${path} already exists in ${repo}. Pull latest or Overwrite anyway.`, "error"); logSave(`⚠️ Conflict: ${path} changed on GitHub`); break;
        case "queued": await refreshOutboxBadge(); fileStatusSet("No connection — commit queued and will send when online.",""); logSave(`📥 Queued commit for ${path} (offline)`); setBarStateNb("Offline — queued for GitHub","error"); break;
        case "created": case "updated": $("nb-gh-overwrite").hidden=true; note.dirty=false; await notes.markSynced(path); await refreshOutboxBadge(); fileStatusSet(`${res.status==="updated"?"Updated":"Created"} ${path} in ${repo} at ${new Date().toLocaleTimeString()}${auto?" (autosave)":""}.`,"success"); setBarStateNb(`Synced to GitHub · ${now()}`,"success"); logSave(`☁️ ${res.status==="updated"?"Updated":"Created"} ${repo}/${path} @ ${now()}${auto?" (autosave)":""} — SHA ${res.sha?.slice(0,7)||""}`); pulse(repoPill,"is-pulsing"); await refreshWorkspaceList(); break;
        case "error": if(res.kind==="auth" && repo){ fileStatusSet(`App can't write to ${repo}. Add it to installation, then Re-check.`,"error"); setBarStateNb(`Can't write to ${repo}`,"error"); showRepoHelp(`The notes target <code>${repo}</code> isn't available (${res.error.message}). <a href="https://github.com/settings/installations" target="_blank" rel="noopener">Add repo to app installation</a> then Re-check.`); logSave(`❌ Save error: ${res.error.message}`); } else { fileStatusSet(res.error.message,"error"); logSave(`❌ Save error: ${res.error.message}`); setBarStateNb(res.error.message,"error"); } break;
      }
    } finally { saveBtn.disabled=false; if(quickSaveBtn) quickSaveBtn.disabled=false; paintClarity(); }
  }
  async function pullNotes(){
    if(!targetIsValid()) return;
    const repo=repoSel.value, path=normalizePath(pathIn.value);
    try{
      fileStatusSet("Fetching latest from GitHub…"); logSave(`⬇ Pull ${repo}/${path}…`);
      const r=await engine.pull({repo, path, branch:branchIn.value.trim()});
      if(r.status==="disconnected"){ ghPanel.showModal?.(); fileStatusSet("Connect GitHub first.","error"); return; }
      if(r.status==="invalid-target"){ fileStatusSet("Choose repo and file path.","error"); return; }
      if(r.status==="missing"){ engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true; fileStatusSet(`Nothing saved at ${path} in ${repo} yet — Save now will create it.`); logSave(`⬇ Pull: nothing at ${path} yet`); return; }
      if(r.status!=="loaded") return;
      if(textarea.value && textarea.value!==r.content && !confirm("Replace editor with GitHub version? Local edits will be lost.")){ fileStatusSet("Pull cancelled.",""); return; }
      textarea.value=r.content; await notes.setBody(r.content, {dirty:false, syncedAt:Date.now()}); note=notes.current; lastLocalSavedAt=new Date(); engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true; editor.renderPreview(); renderOutline(); renderTasks(); fileStatusSet(`Pulled ${path} from ${repo} at ${new Date().toLocaleTimeString()}.`,"success"); setBarStateNb(`Loaded from GitHub · ${new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`,"success"); logSave(`⬇ Pulled ${repo}/${path} (${r.content.length} chars)`); paintClarity(); await refreshWorkspaceList();
    } catch(e){ fileStatusSet(e.message,"error"); logSave(`❌ Pull error: ${e.message}`); }
  }
  async function refreshOutboxBadge(){
    const entries=(await store.listOutbox()).filter(e=> !NOTEBOOK_REPO || e.repo.toLowerCase().includes(NOTEBOOK_REPO.toLowerCase()) || true); // show all for now
    pendingOutboxTotal=entries.length;
    const c=$("outbox-count"); if(c){ c.textContent= entries.length ? `${entries.length} pending` : ""; c.classList.toggle("hidden", !entries.length); }
    $("nb-sync-now")?.classList.toggle("has-pending", entries.length>0);
    paintClarity();
  }
  async function flushOutbox({announce=false}={}){
    const r=await engine.flush({});
    await refreshOutboxBadge();
    if(r.status==="empty"){ if(announce) fileStatusSet("Nothing pending — all on GitHub.",""); return; }
    if(r.status==="disconnected"){ if(announce) fileStatusSet("Connect GitHub first — pending stay on device.","error"); return; }
    if(r.status==="offline"){ setBarStateNb("Still offline — keeping queued","error"); logSave("📡 Offline — keeping queued commits"); return; }
    if(r.status==="conflict"){ $("nb-gh-overwrite").hidden=false; fileStatusSet(`Pending commit for ${r.entry.path} paused: file changed on GitHub. Pull latest or Overwrite anyway.`,"error"); logSave(`⚠️ Outbox conflict: ${r.entry.path}`); return; }
    if(r.status==="error"){ fileStatusSet(`Pending failed: ${r.error.message}`,"error"); logSave(`❌ Outbox error: ${r.error.message}`); return; }
    if(note) await notes.markSynced(note.path);
    setBarStateNb(`Synced to GitHub · ${new Date().toLocaleTimeString([],{hour:"2-digit", minute:"2-digit"})}`,"success"); fileStatusSet(`Delivered ${r.delivered} pending commit${r.delivered===1?"":"s"}.`,"success"); logSave(`📤 Delivered ${r.delivered} queued commits`); paintClarity(); await refreshWorkspaceList();
  }

  // Wiring
  pathIn.value = note.path;
  branchIn.value = await store.kvGet(NB_KEYS.branch) || "";
  if(autosaveCb) autosaveCb.checked = (await store.kvGet(NB_KEYS.autosave)) !== "false";
  $("nb-gh-setup")?.addEventListener("click", ()=>{
    if(!gh.cryptoReady()){ ghStatusSet("GitHub setup needs https:// or http://localhost.","error"); return; }
    const redirectUrl=gh.pageUrl(); if(!redirectUrl){ ghStatusSet("GitHub setup needs real page URL — open live site, not file://.","error"); return; }
    const state=gh.randomState();
    try{ sessionStorage.setItem(GH_KEYS.pending, JSON.stringify({state, redirectUrl, startedAt:Date.now()})); } catch{ ghStatusSet("Browser blocked session storage — allow storage and try again.","error"); return; }
    const manifest=gh.buildManifest(redirectUrl);
    const form=document.createElement("form"); form.method="post"; form.action=`https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`; form.style.display="none";
    const f=document.createElement("input"); f.type="hidden"; f.name="manifest"; f.value=JSON.stringify(manifest); form.appendChild(f); document.body.appendChild(form);
    ghStatusSet("Opening GitHub to name and create the app…"); logSave("↗ Opening GitHub App creation…");
    form.submit(); form.remove();
  });
  $("nb-gh-install")?.addEventListener("click", async()=>{
    const app=await gh.readApp(); if(!app) return;
    const slug=app.slug || app.name?.toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"");
    if(!slug){ ghStatusSet("Couldn't work out install URL — open app on GitHub and install there.","error"); return; }
    try{ sessionStorage.setItem(GH_KEYS.pending, JSON.stringify({state:"install", startedAt:Date.now()})); } catch{}
    ghStatusSet("Opening GitHub to install app — pick repos, then you'll be back here."); window.location.assign(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  });
  $("nb-gh-check")?.addEventListener("click", async()=>{ reposLoaded=false; scratchAttempted=false; const conn=await gh.connection(); if(conn.kind==="app") { try{ await gh.resolveInstallation(); } catch(e){ ghStatusSet(e.message,"error"); } await renderGh(); }});
  $("nb-gh-forget")?.addEventListener("click", async()=>{ await gh.forgetApp(); try{ await store.kvDelete(GH_KEYS.token); } catch{} reposLoaded=false; remoteWorkspace={files:[], dirs:[], repo:""}; engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true; await renderGh(); ghStatusSet("Disconnected — credentials removed from this browser.","success"); logSave("🔌 Disconnected GitHub"); fileStatusSet(""); });
  $("nb-gh-export")?.addEventListener("click", async()=>{
    const app=await gh.readApp(); if(!app){ ghStatusSet("Nothing to download — set up saving first.","error"); return; }
    try{
      const { connectionFileName, connectionFileText } = await import("./github-app.js");
      const name=connectionFileName(app); const url=URL.createObjectURL(new Blob([connectionFileText(app)], {type:"application/json"}));
      const a=document.createElement("a"); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      await gh.markConnectionSaved(); await renderGh(); ghStatusSet(`Saved ${name}. Keep in password manager — use Reconnect on another browser.`,"success"); logSave(`💾 Saved connection file ${name}`);
    }catch(e){ ghStatusSet(e.message,"error"); }
  });
  $("nb-gh-restore-file")?.addEventListener("change", async()=>{
    const file=$("nb-gh-restore-file").files?.[0]; if(!file) return;
    try{
      restoreText=await file.text();
      const {parseConnectionInput, parsePrivateKey}= await import("./github-app.js");
      const parsed= restoreText.trim().startsWith("{") ? parseConnectionInput(restoreText, {appId: $("nb-gh-restore-app-id").value}) : {app_id:null, pem: parsePrivateKey(restoreText), slug:""};
      if(parsed.app_id) $("nb-gh-restore-app-id").value=String(parsed.app_id);
      $("nb-gh-restore-pem").value=parsed.pem;
      setStatus("nb-gh-restore-status", $("nb-gh-restore-app-id").value.trim() ? `Loaded ${file.name}${parsed.slug?` (${parsed.slug})`:""} — click Reconnect.` : `Loaded ${file.name}. Add App ID, then Reconnect.`,"success");
    } catch(e){ restoreText=""; setStatus("nb-gh-restore-status", `${file.name}: ${e.message}`,"error"); }
  });
  $("nb-gh-restore-go")?.addEventListener("click", async()=>{
    let input; try{
      const {parseConnectionInput}= await import("./github-app.js");
      const src=$("nb-gh-restore-pem").value.trim() || restoreText;
      if(!src) throw new Error("Choose connection file or paste private key.");
      input=parseConnectionInput(src, {appId: $("nb-gh-restore-app-id").value});
    }catch(e){ setStatus("nb-gh-restore-status", e.message,"error"); return; }
    setStatus("nb-gh-restore-status","Asking GitHub to confirm…"); $("nb-gh-restore-go").disabled=true;
    try{
      const app=await gh.adoptApp(input);
      $("nb-gh-restore").open=false; $("nb-gh-restore-pem").value=""; restoreText=""; reposLoaded=false; scratchAttempted=false;
      await renderGh();
      const lead=`Reconnected ${app.slug ? `(${app.slug})` : ""} — no new app created. `;
      try{ await gh.resolveInstallation(); ghStatusSet(lead + "Connected.","success"); } catch(e){ ghStatusSet(lead + e.message,"error"); }
      logSave(`🔗 Reconnected app ${app.slug || app.app_id}`);
    }catch(e){ setStatus("nb-gh-restore-status", e.message,"error"); await renderGh(); } finally{ $("nb-gh-restore-go").disabled=false; }
  });
  $("nb-gh-save")?.addEventListener("click", ()=> saveNotes());
  $("nb-quick-save")?.addEventListener("click", ()=> saveNotes());
  $("nb-gh-pull")?.addEventListener("click", pullNotes);
  $("nb-quick-pull")?.addEventListener("click", pullNotes);
  $("nb-gh-overwrite")?.addEventListener("click", ()=> saveNotes({forced:true}));
  $("nb-sync-now")?.addEventListener("click", ()=> flushOutbox({announce:true}));
  $("nb-gh-new-file")?.addEventListener("click", async()=>{
    await flushLocalSave(); const nxt=await notes.newDatedNote(); await switchNote(nxt, `New note — ${nxt.path} created on first save.`); pathIn.select();
  });
  $("nb-gh-scratch")?.addEventListener("click", ()=>{ scratchAttempted=false; ensureNotebookRepo(); });
  repoSel?.addEventListener("change", async()=>{ await store.kvSet(NB_KEYS.notebookRepo, repoSel.value); engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true; fileStatusSet(""); setBarStateNb("Not saved to this repo yet"); paintClarity(); refreshRemoteWorkspace().catch(()=>{}); logSave(`📁 Repo switched to ${repoSel.value}`); });
  pathIn.addEventListener("change", async()=>{ const c=normalizePath(pathIn.value); await store.kvSet(NB_KEYS.path, c); if(notes.current) { notes.current.path=c; await store.putNote(notes.current); } paintFileBarNb(); paintClarity(); refreshWorkspaceList(); logSave(`📄 Path changed to ${c}`); });
  pathIn.addEventListener("input", paintFileBarNb);
  branchIn.addEventListener("change", async()=>{ await store.kvSet(NB_KEYS.branch, branchIn.value.trim()); engine.conflictPaused=false; $("nb-gh-overwrite").hidden=true; refreshRemoteWorkspace().catch(()=>{}); });
  const applyAutosave= async enabled=>{ if(autosaveCb) autosaveCb.checked=enabled; await store.kvSet(NB_KEYS.autosave, String(enabled)); const msg= enabled ? "Repo autosave ON — edits commit a few seconds after typing." : "Repo autosave OFF — use Save now to commit."; fileStatusSet(msg); setStatus("nb-status",msg); paintClarity(); logSave(msg); };
  autosaveCb?.addEventListener("change", ()=> applyAutosave(autosaveCb.checked));
  autosavePill?.addEventListener("click", ()=> applyAutosave(!autosaveCb?.checked));

  $("nb-gh-token-save")?.addEventListener("click", async()=>{
    const v=$("nb-gh-token").value.trim(); if(!v){ ghStatusSet("Paste a token first.","error"); return; }
    ghStatusSet("Checking token…");
    try{
      const res=await fetch("https://api.github.com/user", {headers:{Accept:"application/vnd.github+json", Authorization:`Bearer ${v}`, "X-GitHub-Api-Version":"2022-11-28"}});
      const u=await res.json().catch(()=>({})); if(!res.ok) throw new Error(u.message || `GitHub rejected token (${res.status})`);
      await store.kvDelete(GH_KEYS.app); await store.kvSet(GH_KEYS.token, JSON.stringify({access_token:v, login:u.login||""}));
      $("nb-gh-token").value=""; reposLoaded=false; await renderGh(); ghStatusSet(`Using token${u.login?` for @${u.login}`:""} — Save now will commit.`,"success"); logSave(`🔑 Token saved for @${u.login||"token"}`);
    }catch(e){ ghStatusSet(e.message,"error"); }
  });
  $("nb-gh-token-clear")?.addEventListener("click", async()=>{ await store.kvDelete(GH_KEYS.token); reposLoaded=false; remoteWorkspace={files:[],dirs:[],repo:""}; await renderGh(); ghStatusSet("Token removed.","success"); });

  // Create file/folder via GH panel
  $("nb-gh-create-file")?.addEventListener("click", ()=>{
    const p= (function(){ const v=$("nb-gh-new-path").value; const e=$("nb-gh-new-type")?.value || "md"; const has=/\.[a-z0-9]{1,8}$/i.test(v.split("/").pop()); if(!v.trim()) return ""; const n=normalizePath(v); if(!n) return ""; if(!has && e) return `${n}.${e}`; return n; })();
    if(!p){ ghStatusSet("Type a path for new file.","error"); $("nb-gh-new-path")?.focus(); return; }
    const repo=repoSel.value; if(!repo){ ghStatusSet("Pick a repository first.","error"); return; }
    gh.readRepoFile(repo, p, branchIn.value.trim()).then(ex=>{
      if(ex){ ghStatusSet(`${repo} already has ${p} — put that path in Active file path to switch.`,"error"); return; }
      engine.saveNote({repo, path:p, branch:branchIn.value.trim(), content:textarea.value, forced:true}).then(res=>{
        if(res.status==="queued"){ ghStatusSet(`Offline: ${p} queued and will be created.`); return; }
        if(res.status!=="created"){ ghStatusSet(res.error?.message || `GitHub didn't create ${p}.`,"error"); return; }
        pathIn.value=p; store.kvSet(NB_KEYS.path, p); notes.switchTo(p, {repo, branch:branchIn.value.trim(), initialBody:textarea.value}).then(n=> notes.markSynced(p).then(()=> switchNote(n))).then(()=>{ ghStatusSet(`Created ${repo}/${p} with current notes.`,"success"); fileStatusSet(`Created ${p}.`); logSave(`📄 Created ${repo}/${p}`); });
      });
    });
  });
  $("nb-gh-create-folder")?.addEventListener("click", ()=>{
    const p=normalizePath($("nb-gh-new-folder").value); if(!p){ ghStatusSet("Type a folder path.","error"); return; }
    const repo=repoSel.value; if(!repo){ ghStatusSet("Pick a repository first.","error"); return; }
    engine.saveNote({repo, path:`${p}/.gitkeep`, branch:branchIn.value.trim(), content:"", forced:true}).then(res=>{
      if(res.status==="queued"){ ghStatusSet(`Offline: ${p}/.gitkeep queued.`); return; }
      if(res.status!=="created" && res.status!=="updated"){ ghStatusSet(res.error?.message || "Could not create folder.","error"); return; }
      notes.createFolder(p).then(()=>{ $("nb-gh-new-folder").value=""; ghStatusSet(`Created folder “${p}/.gitkeep” in ${repo}.`,"success"); logSave(`📁 Created folder ${repo}/${p}`); refreshWorkspaceList(); });
    });
  });

  // Menu
  const menuBtn=$("nb-menu-btn"), menu=$("nb-menu");
  function closeMenu(){ if(menu && !menu.hidden){ menu.hidden=true; menuBtn?.setAttribute("aria-expanded","false"); } }
  function posMenu(){ if(!menu||!menuBtn) return; const r=menuBtn.getBoundingClientRect(); const w=menu.offsetWidth||208, h=menu.offsetHeight||200; const left=Math.min(Math.max(8, r.right-w),Math.max(8, window.innerWidth-w-8)); const top= r.top - h -6 >=8 ? r.top - h -6 : Math.min(r.bottom+6, window.innerHeight - h -8); menu.style.left=`${left}px`; menu.style.top=`${top}px`; }
  menuBtn?.addEventListener("click", e=>{ e.stopPropagation(); const nxt=menu.hidden; menu.hidden=!nxt; menuBtn.setAttribute("aria-expanded", String(nxt)); if(nxt){ posMenu(); menu.querySelector("button")?.focus(); } });
  document.addEventListener("click", e=>{ if(menu && !menu.hidden && !e.target.closest("#nb-menu, #nb-menu-btn")) closeMenu(); });
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeMenu(); });
  window.addEventListener("resize", closeMenu); window.addEventListener("scroll", closeMenu, true);
  $("nb-copy")?.addEventListener("click", async()=>{ try{ await navigator.clipboard.writeText(textarea.value); setStatus("nb-status","Copied all notes.","success"); } catch{ setStatus("nb-status","Select and copy manually.","error"); } });
  const dl=(ext,mime)=>{ const blob=new Blob([textarea.value],{type:`${mime};charset=utf-8`}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`notebook-${datedFileName().slice(6,16)}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); };
  $("nb-export-txt")?.addEventListener("click", ()=> dl("txt","text/plain"));
  $("nb-export-md")?.addEventListener("click", ()=> dl("md","text/markdown"));
  let fileHandle=null; const fsSup= typeof window.showSaveFilePicker==="function";
  $("nb-save-file")?.addEventListener("click", async()=>{ if(!fsSup){ dl("md","text/markdown"); return; } try{ fileHandle=await window.showSaveFilePicker({suggestedName: datedFileName().replace(/^notes-/,"notebook-"), types:[{description:"Markdown", accept:{"text/markdown":[".md"]}}]}); const w=await fileHandle.createWritable(); await w.write(textarea.value); await w.close(); setStatus("nb-status",`Written to ${fileHandle.name}.`,"success"); } catch(e){ if(e.name!=="AbortError") setStatus("nb-status", e.message,"error"); } });
  $("nb-open-file")?.addEventListener("click", async()=>{ if(!fsSup){ $("nb-file-input")?.click(); return; } try{ const [h]=await window.showOpenFilePicker({types:[{description:"Markdown or text", accept:{"text/markdown":[".md",".txt"]}}]}); fileHandle=h; const f=await h.getFile(); textarea.value=await f.text(); textarea.dispatchEvent(new Event("input",{bubbles:true})); editor.renderPreview(); setStatus("nb-status",`Opened ${f.name}.`,"success"); } catch(e){ if(e.name!=="AbortError") setStatus("nb-status", e.message,"error"); } });
  $("nb-file-input")?.addEventListener("change", e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ textarea.value=String(r.result||""); textarea.dispatchEvent(new Event("input",{bubbles:true})); editor.renderPreview(); }; r.readAsText(f); });
  $("nb-clear")?.addEventListener("click", ()=>{ if(!textarea.value.trim() || confirm("Clear the current note? This does not delete the file on GitHub until you save.")){ textarea.value=""; textarea.dispatchEvent(new Event("input",{bubbles:true})); editor.renderPreview(); setStatus("nb-status","Cleared editor (not yet saved).",""); logSave("🗑 Cleared editor"); } });

  // Clock
  const clock=$("nb-clock"); function paintClock(){ if(!clock) return; const n=new Date(); clock.textContent= `${n.toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric"})} · ${n.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"})}`; clock.title=n.toLocaleString(); } paintClock(); setInterval(paintClock,15000);

  // GH modal
  ghOpenBtn?.addEventListener("click", ()=> ghPanel?.showModal?.());
  ghCloseBtn?.addEventListener("click", ()=> ghPanel?.close?.());
  ghPanel?.addEventListener("click", e=>{ if(e.target===ghPanel) ghPanel.close?.(); });

  // Online/offline
  window.addEventListener("online", ()=> flushOutbox());
  document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible") flushOutbox(); });

  // Manifest/callback handoff
  (async()=>{
    const handleManifest= async()=>{
      let url; try{ url=new URL(location.href); } catch{ return false; }
      const code=url.searchParams.get("code"), state=url.searchParams.get("state");
      if(!code||!state) return false;
      let pending=null; try{ pending=JSON.parse(sessionStorage.getItem(GH_KEYS.pending)||"null"); } catch{ }
      if(!pending || pending.state!==state) return false;
      try{ window.history.replaceState({}, document.title, `${url.origin}${url.pathname}${url.hash}`); } catch{}
      try{ sessionStorage.removeItem(GH_KEYS.pending); } catch{}
      ghPanel?.showModal?.();
      ghStatusSet("Registering GitHub app…");
      try{ await gh.exchangeManifestCode(code); ghStatusSet("App created. Next: install it on repos.","success"); await renderGh(); const app=await gh.readApp(); const slug=app.slug || app.name?.toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,""); if(slug){ try{ sessionStorage.setItem(GH_KEYS.pending, JSON.stringify({state:"install", startedAt:Date.now()})); } catch{} window.location.assign(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`); } } catch(e){ ghStatusSet(`Setup failed: ${e.message}`,"error"); await renderGh(); }
      return true;
    };
    if(await handleManifest()) return;
    try{
      const here=new URL(location.href);
      const setupAction=here.searchParams.get("setup_action"), instId=here.searchParams.get("installation_id");
      if(setupAction || instId){
        try{ window.history.replaceState({}, document.title, `${here.origin}${here.pathname}${here.hash}`);} catch{}
        try{ sessionStorage.removeItem(GH_KEYS.pending);} catch{}
        ghPanel?.showModal?.();
        try{ await gh.resolveInstallation(instId); } catch(e){ ghStatusSet(e.message,"error"); }
        await renderGh(); return;
      }
      const pending=JSON.parse(sessionStorage.getItem(GH_KEYS.pending)||"null");
      if(pending?.state==="install"){ try{ sessionStorage.removeItem(GH_KEYS.pending);} catch{} ghPanel?.showModal?.(); try{ await gh.resolveInstallation(); } catch(e){} await renderGh(); return; }
    }catch{}
    const conn=await gh.connection(); if(conn.kind==="app") try{ await gh.resolveInstallation(null);}catch{}
    await renderGh();
  })();

  paintFileBarNb(); paintClarity(); updatePreviews(); renderOutline(); renderTasks(); await refreshOutboxBadge(); await refreshWorkspaceList();
  try{ if(navigator.storage?.persist) await navigator.storage.persist(); } catch{}
  await setupPwaInstall({ embedded:false });
}

main().catch(e=>{
  console.error("Notebook failed:", e);
  const s=$("nb-status"); if(s){ s.textContent=`Failed to start: ${e.message}`; s.classList.add("is-error"); }
});
