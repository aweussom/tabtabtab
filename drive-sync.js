// Drive sync — push/pull the user's UG-import library to/from their own
// Google Drive `appDataFolder`. See PLAN.md "cross-device sync" + DRIVE-SETUP.md.
//
// Architecture: the user's data lives in their own hidden Drive folder
// (scope `drive.appdata`). We host nothing. Google handles auth, storage,
// and cross-device propagation. The token flow is Google Identity
// Services (GIS), lazy-loaded on first sign-in so users who never sync
// don't fetch from Google.
//
// Public surface:
//   isReady()         → true once GIS is loaded + we have a Client ID
//   isSignedIn()      → cached access token is valid (not expired)
//   signIn()          → triggers GIS popup, resolves with token (or throws)
//   signOut()         → drops local token + remembered file id (data stays on Drive)
//   push(payload)     → write the JSON to appDataFolder (create or update)
//   pull()            → read the JSON from appDataFolder, returns object or null
//   getLastSyncedAt() → ISO string of last successful push/pull (or null)
//
// Conflict resolution lives in the CALLER. push/pull are byte movers; the
// caller decides merge semantics (last-write-wins, per-tab merge, etc.).

// ---- CONFIG ----------------------------------------------------------------
// Replace CLIENT_ID with the value from your Google Cloud Console OAuth
// client setup. See DRIVE-SETUP.md for the step-by-step. The Client ID is
// public info (no secret here); it's fine to commit. Each origin you
// serve the app from must be registered as an "Authorized JavaScript
// origin" in the same OAuth client config.
export const DRIVE_CONFIG = {
  CLIENT_ID: 'TODO-PUT-CLIENT-ID-HERE.apps.googleusercontent.com',
  SCOPE: 'https://www.googleapis.com/auth/drive.appdata',
  FILE_NAME: 'tabtabtab-local-imports.json',
  GIS_SRC: 'https://accounts.google.com/gsi/client',
};

const TOKEN_KEY = 'nortabs:drive:token:v1';        // { access_token, expires_at }
const FILE_ID_KEY = 'nortabs:drive:file-id:v1';    // remembered Drive file id
const LAST_SYNCED_KEY = 'nortabs:drive:last-synced:v1';

let _tokenClient = null;
let _gisLoading = null;

function isConfigured() {
  return DRIVE_CONFIG.CLIENT_ID && !DRIVE_CONFIG.CLIENT_ID.startsWith('TODO');
}

async function loadGis() {
  if (window.google?.accounts?.oauth2) return;
  if (_gisLoading) return _gisLoading;
  _gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = DRIVE_CONFIG.GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Kunne ikke laste Google Identity Services'));
    document.head.appendChild(s);
  });
  return _gisLoading;
}

function getStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.access_token || !parsed?.expires_at) return null;
    if (Date.now() >= parsed.expires_at) return null;
    return parsed;
  } catch { return null; }
}

function setStoredToken(token) {
  // GIS gives us expires_in (seconds). Convert to absolute ms timestamp,
  // with a 60-second safety margin so we never try a call with a token
  // that's about to expire.
  const expires_at = Date.now() + (token.expires_in - 60) * 1000;
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: token.access_token,
    expires_at,
  }));
}

export function isReady() {
  return isConfigured() && !!window.google?.accounts?.oauth2;
}

export function isSignedIn() {
  return !!getStoredToken();
}

export function getLastSyncedAt() {
  return localStorage.getItem(LAST_SYNCED_KEY);
}

/**
 * Initiate sign-in. Lazy-loads GIS, then triggers the OAuth popup. The
 * caller awaits this; resolves with the access token, throws on cancel
 * or config errors.
 */
export async function signIn() {
  if (!isConfigured()) {
    throw new Error('Drive Client ID ikke konfigurert. Se DRIVE-SETUP.md.');
  }
  await loadGis();
  if (!_tokenClient) {
    _tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CONFIG.CLIENT_ID,
      scope: DRIVE_CONFIG.SCOPE,
      callback: () => {}, // overridden per requestAccessToken
    });
  }
  return new Promise((resolve, reject) => {
    _tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(`OAuth-feil: ${resp.error}${resp.error_description ? ' — ' + resp.error_description : ''}`));
        return;
      }
      setStoredToken(resp);
      resolve(resp.access_token);
    };
    _tokenClient.error_callback = (err) => {
      reject(new Error(`OAuth-feil: ${err?.type || err?.message || 'ukjent'}`));
    };
    // prompt:'' tries silent re-grant when the user is still signed into
    // Google with prior consent; falls back to a popup otherwise.
    _tokenClient.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(FILE_ID_KEY);
  localStorage.removeItem(LAST_SYNCED_KEY);
}

async function ensureToken() {
  const t = getStoredToken();
  if (t) return t.access_token;
  return signIn();
}

async function driveFetch(url, opts = {}) {
  const token = await ensureToken();
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    // Token rejected; clear and retry once. GIS usually re-grants silently
    // if the user is still signed into Google.
    localStorage.removeItem(TOKEN_KEY);
    const fresh = await ensureToken();
    return fetch(url, { ...opts, headers: { ...headers, Authorization: `Bearer ${fresh}` } });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  return res;
}

async function findExistingFileId() {
  const cached = localStorage.getItem(FILE_ID_KEY);
  if (cached) return cached;
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(`name = '${DRIVE_CONFIG.FILE_NAME}' and trashed = false`)}&fields=files(id,name,modifiedTime)`;
  const res = await driveFetch(url);
  const data = await res.json();
  const file = data.files?.[0];
  if (file) {
    localStorage.setItem(FILE_ID_KEY, file.id);
    return file.id;
  }
  return null;
}

/**
 * Write `payload` (any JSON-serializable object) to the appDataFolder
 * file. Creates the file the first time, updates in place after that.
 * Returns the file id on success.
 */
export async function push(payload) {
  const body = JSON.stringify(payload);
  let fileId = await findExistingFileId();
  if (fileId) {
    // PATCH with media: replace content, keep metadata.
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
    );
  } else {
    // Multipart create: metadata + content in one request.
    const boundary = `tttb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const meta = { name: DRIVE_CONFIG.FILE_NAME, parents: ['appDataFolder'] };
    const multipart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${body}\r\n` +
      `--${boundary}--`;
    const res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart },
    );
    const data = await res.json();
    fileId = data.id;
    localStorage.setItem(FILE_ID_KEY, fileId);
  }
  localStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());
  return fileId;
}

/**
 * Read the appDataFolder file. Returns the parsed object, or `null` if
 * no file exists yet (first-time sync from this device).
 */
export async function pull() {
  const fileId = await findExistingFileId();
  if (!fileId) return null;
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const payload = await res.json();
  localStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());
  return payload;
}
