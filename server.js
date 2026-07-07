/**
 * Rock Kids – Local HTTP Server
 * Serves board, admin, and settings pages.
 * Provides JSON APIs for classroom status and app config.
 * Uses only Node.js built-ins — no npm packages required.
 *
 * Security model:
 *   - Volunteers on the local network can view the board, use the admin
 *     page, and read/write classroom STATUS only.
 *   - Settings, config writes, logo changes, and NDI control are
 *     LOCALHOST-ONLY (i.e. only from the machine running the app).
 *   - Planning Center credentials are never sent to remote devices.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT   = 8080;
const PUBLIC = path.join(__dirname, 'public');

// ── User data directory (survives app updates, always writable) ────────────
let DATA_DIR;
try {
  const { app } = require('electron');
  DATA_DIR = app.getPath('userData');
} catch (e) {
  DATA_DIR = __dirname; // fallback for running outside Electron
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE      = path.join(DATA_DIR, 'classroom_state.json');
const CONFIG_FILE     = path.join(DATA_DIR, 'app_config.json');
const CHECKLISTS_FILE = path.join(DATA_DIR, 'checklists.json');
const LOGO_FILE       = path.join(DATA_DIR, 'custom-logo.png');

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  churchName:      'Rock Church',
  ministryName:    'Rock Kids',
  accentColor:     '#C5B99A',
  openColor:       '#3dbd7a',
  closedColor:     '#e06070',
  serviceLabel:    'Sunday Service',
  showFloor:       true,
  showAgeGroup:    true,
  showCapacity:    false,
  refreshInterval: 2,
  planningCenter: {
    enabled:      false,
    appId:        '',
    secret:       '',
    eventId:      ''
  }
};

const DEFAULT_CLASSROOMS = [
  { id: 0, name: 'Babies',      age: 'Birth – 14 months',       status: 'closed', floor: '',           capacity: 10 },
  { id: 1, name: 'Nursery',     age: '15 months – 2 years',     status: 'open',   floor: '1st Floor',  capacity: 15 },
  { id: 2, name: 'Preschool',   age: '3 years',                 status: 'open',   floor: '1st Floor',  capacity: 20 },
  { id: 3, name: 'Preschool',   age: '4 years',                 status: 'open',   floor: '1st Floor',  capacity: 20 },
  { id: 4, name: 'Preschool',   age: '5 years / Kindergarten',  status: 'open',   floor: '1st Floor',  capacity: 20 },
  { id: 5, name: 'Elementary',  age: '1st & 2nd Grade',         status: 'open',   floor: '2nd Floor',  capacity: 25 },
  { id: 6, name: 'Elementary',  age: '1st & 2nd Grade',         status: 'open',   floor: '2nd Floor',  capacity: 25 },
  { id: 7, name: 'Elementary',  age: '3rd Grade',               status: 'open',   floor: '2nd Floor',  capacity: 25 },
  { id: 8, name: 'Elementary',  age: '4th & 5th Grade',         status: 'open',   floor: '2nd Floor',  capacity: 25 },
];

// ── File helpers ──────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}

// Atomic write: write to a temp file, then rename. Prevents corrupted JSON
// if the machine loses power or the app is killed mid-write.
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadState()  { return readJSON(STATE_FILE,  DEFAULT_CLASSROOMS); }
function saveState(d) { writeJSON(STATE_FILE, d); }

function loadChecklists()    { return readJSON(CHECKLISTS_FILE, []); }
function saveChecklists(d)   { writeJSON(CHECKLISTS_FILE, d); }

// Shape guards for the two open-ended POST bodies. A malformed payload (not an
// array, wrong types) would otherwise be written to disk and then crash the
// board's renderer (forEach on a non-array) — a one-request denial of service.
function isValidClassrooms(d) {
  return Array.isArray(d) && d.every(r =>
    r && typeof r === 'object' && typeof r.id === 'number' &&
    (r.status === undefined || ['open', 'closed', 'full'].includes(r.status)));
}
function isValidChecklists(d) {
  return Array.isArray(d) && d.every(c =>
    c && typeof c === 'object' &&
    (c.items === undefined || (Array.isArray(c.items) && c.items.every(i => typeof i === 'string'))));
}

function loadConfig()  {
  const saved = readJSON(CONFIG_FILE, {});
  const cfg = Object.assign({}, DEFAULT_CONFIG, saved, {
    planningCenter: Object.assign({}, DEFAULT_CONFIG.planningCenter, saved.planningCenter || {})
  });
  // Clamp the board's poll interval so a stray/hostile value (e.g. 0.01)
  // can't make displays hammer the server.
  cfg.refreshInterval = Math.min(60, Math.max(2, Number(cfg.refreshInterval) || 2));
  return cfg;
}

// Merge-save: if the incoming config omits or blanks the Planning Center
// secret/appId, keep the previously saved values so a settings save from a
// client that never saw the secret can't accidentally wipe it.
function saveConfig(incoming) {
  const existing = loadConfig();
  const merged   = Object.assign({}, existing, incoming);
  const pcIn     = (incoming && incoming.planningCenter) || {};
  merged.planningCenter = Object.assign({}, existing.planningCenter, pcIn);
  if (!pcIn.secret) merged.planningCenter.secret = existing.planningCenter.secret;
  if (!pcIn.appId)  merged.planningCenter.appId  = existing.planningCenter.appId;
  writeJSON(CONFIG_FILE, merged);
}

// Remote devices (board displays elsewhere, volunteer phones) get branding
// only — never the Planning Center credentials.
function sanitizeConfig(cfg) {
  const safe = Object.assign({}, cfg);
  safe.planningCenter = {
    enabled:    !!(cfg.planningCenter && cfg.planningCenter.enabled),
    configured: !!(cfg.planningCenter && cfg.planningCenter.appId && cfg.planningCenter.secret),
    eventId:    (cfg.planningCenter && cfg.planningCenter.eventId) || ''
  };
  return safe;
}

// ── Network ───────────────────────────────────────────────────────────────

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Hosts that legitimately address this server: localhost and its own LAN IP.
function isAllowedHost(host) {
  const h = (host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === getLocalIP().toLowerCase();
}

// True only when the request comes from the machine running the app AND
// addresses it as localhost. The Host check blocks DNS-rebinding, where a
// foreign domain resolves to 127.0.0.1 to slip past the socket check.
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  const socketLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!socketLocal) return false;
  const h = (req.headers.host || '').split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// CSRF guard: if the browser disclosed where a request came from (Origin or
// Referer), require it to be one of our own pages. Header-less requests (curl,
// <img>, top-level navigation) pass here — the localhost gate is what protects
// the sensitive endpoints; this stops a foreign site from forging writes.
function crossSiteBlocked(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false;
  try { return !isAllowedHost(new URL(src).host); }
  catch (_) { return true; }
}

function forbidden(res) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end('{"ok":false,"error":"This action is only allowed from the board computer."}');
}

// ── MIME types ────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Body parser helper ────────────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — plenty for a logo image

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // No CORS headers: every Room Ready page is served from this same origin, so
  // nothing legitimate makes a cross-origin request. Withholding
  // Access-Control-Allow-Origin means a malicious page in a browser on the
  // board computer can't read our responses (e.g. Planning Center creds).

  const url = req.url.split('?')[0];

  // Block cross-site forgery of any state-changing request up front.
  const MUTATING_GET = new Set(['/api/save-config', '/api/set-status', '/api/remove-logo', '/api/ndi-control']);
  const isMutating = req.method === 'POST' || req.method === 'DELETE'
                   || (req.method === 'GET' && MUTATING_GET.has(url));
  if (isMutating && crossSiteBlocked(req)) { forbidden(res); return; }

  const NO_CACHE = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  // GET /api/status
  if (req.method === 'GET' && url === '/api/status') {
    res.writeHead(200, NO_CACHE);
    res.end(JSON.stringify(loadState()));
    return;
  }

  // POST /api/status  (localhost only — volunteers toggle via GET /api/set-status;
  // only the settings page rewrites the whole room list)
  if (req.method === 'POST' && url === '/api/status') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      const data = await readBody(req);
      if (!isValidClassrooms(data)) {
        res.writeHead(400, NO_CACHE); res.end('{"ok":false,"error":"invalid classroom data"}'); return;
      }
      saveState(data);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
    return;
  }

  // GET /api/save-config?data=BASE64_JSON  (localhost only)
  if (req.method === 'GET' && url === '/api/save-config') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const raw    = Buffer.from(params.get('data') || '', 'base64').toString('utf8');
      const data   = JSON.parse(raw);
      saveConfig(data);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400, NO_CACHE); res.end('{"ok":false}');
    }
    return;
  }

  // GET /api/checklists
  if (req.method === 'GET' && url === '/api/checklists') {
    res.writeHead(200, NO_CACHE);
    res.end(JSON.stringify(loadChecklists()));
    return;
  }

  // POST /api/checklists  (localhost only — edited on the settings page)
  if (req.method === 'POST' && url === '/api/checklists') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      const data = await readBody(req);
      if (!isValidChecklists(data)) {
        res.writeHead(400, NO_CACHE); res.end('{"ok":false,"error":"invalid checklist data"}'); return;
      }
      saveChecklists(data);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
    return;
  }

  // POST /api/upload-logo  — body: { base64: '...' }  (localhost only)
  if (req.method === 'POST' && url === '/api/upload-logo') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      const data = await readBody(req);
      const buf  = Buffer.from(data.base64, 'base64');
      if (!buf.length) throw new Error('empty');
      fs.writeFileSync(LOGO_FILE, buf);
      const cfg = loadConfig();
      cfg.hasCustomLogo = true;
      saveConfig(cfg);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
    return;
  }

  // DELETE /api/upload-logo — remove custom logo  (localhost only)
  if (req.method === 'DELETE' && url === '/api/upload-logo') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      if (fs.existsSync(LOGO_FILE)) fs.unlinkSync(LOGO_FILE);
      const cfg = loadConfig();
      cfg.hasCustomLogo = false;
      saveConfig(cfg);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
    return;
  }

  // GET /api/remove-logo  (localhost only)
  if (req.method === 'GET' && url === '/api/remove-logo') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      if (fs.existsSync(LOGO_FILE)) fs.unlinkSync(LOGO_FILE);
      const cfg = loadConfig();
      cfg.hasCustomLogo = false;
      saveConfig(cfg);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400, NO_CACHE); res.end('{"ok":false}');
    }
    return;
  }

  // NOTE: the old GET /api/save-logo endpoint was removed. Base64 images in
  // a URL blow past Node's ~16KB header limit for any real logo. The POST
  // /api/upload-logo endpoint (used by settings.html) is the correct path.

  // GET /custom-logo.png — serve uploaded logo from userData
  if (req.method === 'GET' && url === '/custom-logo.png') {
    if (fs.existsSync(LOGO_FILE)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(LOGO_FILE));
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // GET /api/set-status?id=0&status=open  (simple toggle save — no POST body needed)
  if (req.method === 'GET' && url === '/api/set-status') {
    try {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const id     = parseInt(params.get('id'));
      const status = params.get('status');
      if (isNaN(id) || !['open','closed','full'].includes(status)) {
        res.writeHead(400, NO_CACHE); res.end('{"ok":false,"error":"bad params"}'); return;
      }
      const state = loadState();
      const room  = state.find(r => r.id === id);
      if (room) { room.status = status; saveState(state); }
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(500, NO_CACHE); res.end('{"ok":false}');
    }
    return;
  }

  // GET /api/ndi-status — returns current NDI state (main.js injects ndiGetStatus)
  if (req.method === 'GET' && url === '/api/ndi-status') {
    const fn = server._ndiGetStatus;
    const s  = fn ? fn() : { available: false, running: false, sourceName: '' };
    res.writeHead(200, NO_CACHE);
    res.end(JSON.stringify(s));
    return;
  }

  // GET /api/ndi-control?action=start|stop  (localhost only)
  if (req.method === 'GET' && url === '/api/ndi-control') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const action = params.get('action');
    const fn     = server._ndiControl;
    if (fn && (action === 'start' || action === 'stop')) {
      fn(action); // async, fire and forget
    }
    res.writeHead(200, NO_CACHE);
    res.end('{"ok":true}');
    return;
  }

  // GET /api/info — returns server IP and shareable links
  if (req.method === 'GET' && url === '/api/info') {
    const ip = getLocalIP();
    res.writeHead(200, NO_CACHE);
    res.end(JSON.stringify({
      ip,
      port: PORT,
      adminURL:  `http://${ip}:${PORT}/admin.html`,
      boardURL:  `http://${ip}:${PORT}/classroom-board.html`,
    }));
    return;
  }

  // GET /api/config — full config for localhost (settings page),
  // sanitized (no Planning Center credentials) for everyone else
  if (req.method === 'GET' && url === '/api/config') {
    const cfg = loadConfig();
    const full = isLocalRequest(req) && !crossSiteBlocked(req);
    res.writeHead(200, NO_CACHE);
    res.end(JSON.stringify(full ? cfg : sanitizeConfig(cfg)));
    return;
  }

  // POST /api/config  (localhost only)
  if (req.method === 'POST' && url === '/api/config') {
    if (!isLocalRequest(req)) { forbidden(res); return; }
    try {
      const data = await readBody(req);
      saveConfig(data);
      res.writeHead(200, NO_CACHE);
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────
  // Settings page is localhost-only (it can change branding and NDI).
  if (url === '/settings.html' && !isLocalRequest(req)) {
    forbidden(res);
    return;
  }

  // Resolve the requested path and make sure it can't escape /public
  // (blocks path traversal like GET /../app_config.json).
  const requested = url === '/' ? '/classroom-board.html' : url;
  const filePath  = path.resolve(PUBLIC, '.' + requested);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

function start() {
  // Handle the 'error' event so a port conflict logs cleanly instead of
  // throwing an unhandled exception that crashes the app at launch.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`SERVER_ERROR: port ${PORT} is already in use — is Room Ready already running?`);
    } else {
      console.error('SERVER_ERROR:', err.message);
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('SERVER_READY');
    console.log(`LOCAL_IP:${ip}`);
    console.log(`PORT:${PORT}`);
  });
}

module.exports = { start, getLocalIP, PORT };
