// GitHub App client for the Scratchpad PWA.
//
// Port of the dashboard dialog's zero-config GitHub flow, with one change:
// persistence goes through an async KV interface (IndexedDB-backed) instead of
// synchronous localStorage. Key strings are unchanged so the storage migration
// in notes-store.js carries existing app registrations over untouched.
//
// Flow: app-from-manifest registration → self-signed RS256 app JWT →
// one-hour installation tokens (cached, minted on demand) → Contents API.

import { encodeUtf8Base64, decodeUtf8Base64 } from "./markdown.js";

export const GITHUB_API = "https://api.github.com";
export const SCRATCH_REPO = "scratch";
export const INSTALLATION_TOKEN_TTL_MS = 50 * 60 * 1000;

export const GH_KEYS = {
  app: "dash-scratchpad-gh-app-v2",
  pending: "dash-scratchpad-gh-app-pending-v2",
  token: "dash-scratchpad-gh-token-v1",
  repo: "dash-scratchpad-gh-repo",
  path: "dash-scratchpad-gh-path",
  branch: "dash-scratchpad-gh-branch",
  autosave: "dash-scratchpad-gh-autosave",
  shas: "dash-scratchpad-gh-file-shas-v1"
};

const API_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export function normalizePath(value) {
  return String(value || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function timestampSlug(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

// ---- base64url (RFC 7515) ---------------------------------------------------------------------------
export function base64UrlFromBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function base64UrlFromText(text) {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

function pemBodyBytes(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function derLength(length) {
  if (length < 0x80) return [length];
  if (length < 0x100) return [0x81, length];
  if (length < 0x10000) return [0x82, (length >> 8) & 0xff, length & 0xff];
  return [0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
}
function derWrap(tag, contents) {
  const head = [tag, ...derLength(contents.length)];
  const out = new Uint8Array(head.length + contents.length);
  out.set(head, 0);
  out.set(contents, head.length);
  return out;
}

// GitHub's manifest PEM is PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only.
// PKCS#8 = SEQ { INTEGER 0, SEQ { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }
export function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const privateKey = derWrap(0x04, pkcs1);
  const inner = new Uint8Array(version.length + rsaAlgorithm.length + privateKey.length);
  inner.set(version, 0);
  inner.set(rsaAlgorithm, version.length);
  inner.set(privateKey, version.length + rsaAlgorithm.length);
  return derWrap(0x30, inner);
}

async function importAppKey(pem) {
  const text = String(pem || "");
  const raw = pemBodyBytes(text);
  const der = /BEGIN RSA PRIVATE KEY/.test(text) ? pkcs1ToPkcs8(raw) : raw;
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export class GitHubAppClient {
  // kv: anything implementing async kvGet/kvSet/kvDelete (see notes-store.js)
  constructor(kv, { fetchImpl = (...args) => fetch(...args) } = {}) {
    this.kv = kv;
    this.fetchImpl = fetchImpl;
    this.tokenInFlight = null;
  }

  async readJson(key, fallback = null) {
    try {
      const raw = await this.kv.kvGet(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) { return fallback; }
  }
  async writeJson(key, value) { await this.kv.kvSet(key, JSON.stringify(value)); }
  async readStore(key, fallback = "") {
    const raw = await this.kv.kvGet(key);
    return raw === null || raw === undefined ? fallback : raw;
  }

  cryptoReady() {
    try { return Boolean(globalThis.isSecureContext && crypto?.subtle); } catch (error) { return false; }
  }
  pageUrl() {
    if (!location.origin || location.origin === "null") return "";
    return `${location.origin}${location.pathname}`;
  }

  async readApp() {
    const app = await this.readJson(GH_KEYS.app, null);
    return app && app.app_id && app.pem ? app : null;
  }
  async writeApp(app) { await this.writeJson(GH_KEYS.app, app); }
  async forgetApp() {
    for (const key of [GH_KEYS.app, GH_KEYS.token, GH_KEYS.shas]) {
      try { await this.kv.kvDelete(key); } catch (error) { /* storage optional */ }
    }
  }

  async appJwt(app) {
    const key = await importAppKey(app.pem);
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlFromText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64UrlFromText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(app.app_id) }));
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64UrlFromBytes(signature)}`;
  }

  async connection() {
    const app = await this.readApp();
    if (app) {
      const installationId = app.installation_id || null;
      return {
        kind: "app", app, installationId,
        label: app.installation_account || app.owner || "",
        ready: Boolean(installationId)
      };
    }
    const token = await this.readJson(GH_KEYS.token, null);
    if (token && token.access_token) {
      return { kind: "token", token: token.access_token, ready: true, label: token.login || "" };
    }
    return { kind: "none", ready: false };
  }

  async mintInstallationToken(app, installationId) {
    const cached = app.installation_token &&
      app.installation_token_expires_at > Date.now() &&
      app.installation_token_id === installationId
      ? app.installation_token : null;
    if (cached) return cached;
    if (this.tokenInFlight && String(this.tokenInFlight.id) === String(installationId)) return this.tokenInFlight.promise;
    const promise = this.#mintInstallationTokenUncached(app, installationId);
    this.tokenInFlight = { id: installationId, promise };
    try { return await promise; } finally { this.tokenInFlight = null; }
  }

  async #mintInstallationTokenUncached(app, installationId) {
    const jwt = await this.appJwt(app);
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.message || `GitHub refused to issue an installation token (${res.status})`);
    const current = await this.readApp() || app;
    await this.writeApp({
      ...current,
      installation_token: data.token,
      installation_token_expires_at: Date.now() + INSTALLATION_TOKEN_TTL_MS,
      installation_token_id: installationId
    });
    return data.token;
  }

  // Every Contents call funnels through here: apps get a minted installation
  // token; a pasted PAT is used as-is.
  async authorizedFetch(path, options = {}) {
    const connection = await this.connection();
    if (connection.kind === "app") {
      if (!connection.installationId) throw new Error("Finish GitHub setup first — install the app on a repository.");
      const token = await this.mintInstallationToken(connection.app, connection.installationId);
      return this.fetchImpl(`${GITHUB_API}${path}`, {
        ...options,
        headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      });
    }
    if (connection.kind === "token") {
      return this.fetchImpl(`${GITHUB_API}${path}`, {
        ...options,
        headers: { ...API_HEADERS, Authorization: `Bearer ${connection.token}`, ...(options.headers || {}) }
      });
    }
    throw new Error("Connect GitHub first.");
  }

  async appFetch(app, path) {
    const jwt = await this.appJwt(app);
    return this.fetchImpl(`${GITHUB_API}${path}`, { headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` } });
  }

  contentsPath(repo, path) {
    return `/repos/${repo}/contents/${normalizePath(path).split("/").map(encodeURIComponent).join("/")}`;
  }

  async readRepoFile(repo, path, branch) {
    const res = await this.authorizedFetch(
      `${this.contentsPath(repo, path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`
    );
    if (res.status === 404) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `GitHub API error (${res.status})`), { status: res.status });
    if (Array.isArray(data) || data.type !== "file") throw new Error("That path is a directory, not a file.");
    return { sha: data.sha, content: decodeUtf8Base64(data.content || ""), html_url: data.html_url || "" };
  }

  async writeRepoFile({ repo, path, content, message, branch, sha }) {
    const body = { message: message || `Update ${path} via scratchpad`, content: encodeUtf8Base64(content) };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    const res = await this.authorizedFetch(this.contentsPath(repo, path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `GitHub API error (${res.status})`), { status: res.status });
    return data;
  }

  async listRepositories() {
    const connection = await this.connection();
    const endpoint = connection.kind === "token"
      ? "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"
      : "/installation/repositories?per_page=100";
    const res = await this.authorizedFetch(endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `GitHub API error (${res.status})`), { status: res.status });
    return Array.isArray(data) ? data : (data.repositories || []);
  }

  // Creates the private `scratch` repo (auto_init gives it a default branch).
  async ensureScratchRepo() {
    const connection = await this.connection();
    if (!connection.ready) return { ok: false, error: new Error("Connect GitHub first.") };
    const owner = connection.kind === "app" ? (connection.app.installation_account || connection.app.owner || "") : "";
    const accountType = connection.kind === "app" ? (connection.app.installation_type || "User") : "User";
    const createPath = accountType === "Organization" && owner ? `/orgs/${owner}/repos` : "/user/repos";
    const res = await this.authorizedFetch(createPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: SCRATCH_REPO, description: "Scratchpad notes from the dash PWA.", private: true, auto_init: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: Object.assign(new Error(data.message || `GitHub API error (${res.status})`), { status: res.status }) };
    return { ok: true, repo: data.full_name || `${owner}/${SCRATCH_REPO}` };
  }

  async scratchRepoFullName() {
    const connection = await this.connection();
    const owner = connection.kind === "app" ? (connection.app.installation_account || connection.app.owner || "") : "";
    const remembered = await this.readStore(GH_KEYS.repo);
    const base = owner || (remembered.includes("/") ? remembered.split("/")[0] : "");
    return base ? `${base}/${SCRATCH_REPO}` : SCRATCH_REPO;
  }

  // ---- app-from-manifest registration ---------------------------------------------------------------
  buildManifest(redirectUrl) {
    return {
      name: `dash notes (${new URL(redirectUrl).hostname})`,
      url: redirectUrl,
      redirect_url: redirectUrl,
      setup_url: redirectUrl,
      callback_urls: [redirectUrl],
      description: "Saves scratchpad notes from the dash PWA to one of your repositories.",
      public: false,
      request_oauth_on_install: false,
      setup_on_update: false,
      default_permissions: { contents: "write", metadata: "read", repository_creation: "write" },
      default_events: []
    };
  }

  randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64UrlFromBytes(bytes);
  }

  // POST /app-manifests/{code}/conversions is CORS-enabled — the only step that
  // exchanges a one-time code for the app's ID and PEM without a server.
  async exchangeManifestCode(code) {
    const res = await this.fetchImpl(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: API_HEADERS
    });
    const app = await res.json().catch(() => ({}));
    if (!res.ok || !app.id || !app.pem) {
      throw Object.assign(new Error(app.message || `GitHub couldn't complete the setup (${res.status})`), { status: res.status });
    }
    await this.writeApp({
      app_id: app.id,
      slug: app.slug || "",
      name: app.name || "",
      owner: app.owner?.login || "",
      pem: app.pem,
      html_url: app.html_url || "",
      created_at: Date.now(),
      installation_id: null
    });
    return app;
  }

  async resolveInstallation(installationIdHint = null) {
    const app = await this.readApp();
    if (!app || !this.cryptoReady()) return null;
    const res = await this.appFetch(app, "/app/installations?per_page=100");
    const installs = await res.json().catch(() => []);
    if (!res.ok) throw new Error(installs.message || `GitHub API error (${res.status})`);
    if (!Array.isArray(installs) || !installs.length) {
      const error = new Error("The app isn't installed on any repository yet.");
      error.code = "NO_INSTALLATION";
      throw error;
    }
    const match = (installationIdHint && installs.find(item => String(item.id) === String(installationIdHint)))
      || installs.find(item => item.account?.login === app.owner)
      || installs[0];
    const current = await this.readApp();
    await this.writeApp({
      ...current,
      installation_id: match.id,
      installation_account: match.account?.login || "",
      installation_type: match.target_type || ""
    });
    return match;
  }

  // Per-(repo, branch, path) SHA memory: what makes in-place updates possible and
  // what detects that GitHub's copy moved on since the last sync.
  async storedSha(fileKey) {
    if (!fileKey) return null;
    const map = await this.readJson(GH_KEYS.shas, {}) || {};
    return map[fileKey] || null;
  }
  async rememberSha(fileKey, sha) {
    if (!fileKey) return;
    const map = await this.readJson(GH_KEYS.shas, {}) || {};
    if (sha) map[fileKey] = sha; else delete map[fileKey];
    await this.writeJson(GH_KEYS.shas, map);
  }
}
