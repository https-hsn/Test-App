'use strict';
// Site Manager server — no npm dependencies. Requires Node.js 18+.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });
const DBF = path.join(DATA, 'db.json');

const ROLES = ['Admin', 'CEO', 'General Manager', 'Project Manager', 'Supervisor', 'Engineer', 'Technician'];
const MGR = ['Admin', 'CEO', 'General Manager', 'Project Manager'], SCH = [...MGR, 'Supervisor'], ALL = ROLES, NONE = [];
const STAT = ['Planned', 'In progress', 'On hold', 'Completed'], SEV = ['Low', 'Medium', 'High'];

let db = { ver: 1, users: {}, sites: {}, reports: {}, problems: {}, visits: {}, chat: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch (e) { }
let saving = false, dirty = false;
function save(bump = true) { if (bump) db.ver++; dirty = true; if (!saving) flush(); }
function flush() {
  saving = true; dirty = false;
  const tmp = DBF + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (err) { saving = false; return console.error('Save failed', err); }
    fs.rename(tmp, DBF, () => { saving = false; if (dirty) flush(); });
  });
}
function saveSync() { try { fs.writeFileSync(DBF, JSON.stringify(db)); } catch (e) { } }

// ---------- helpers ----------
class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const rid = () => crypto.randomBytes(8).toString('hex');
const str = (v, n = 2000) => String(v ?? '').trim().slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : today();
const num = v => Math.max(0, Math.min(1e9, +v || 0));
const must = (u, roles) => { if (!roles.includes(u.role)) throw new HttpErr(403, 'Your role is not allowed to do this'); };
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPw(pw, u) {
  const h = crypto.scryptSync(pw, u.salt, 32), s = Buffer.from(u.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
const DUMMY = hashPw('dummy');

// first run: create admin
if (!Object.keys(db.users).length) {
  const generated = !process.env.ADMIN_PASSWORD;
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.users.admin = { name: 'Administrator', role: 'Admin', ...hashPw(pw), must: true };
  saveSync();
  console.log('\n=== First run: admin account created ===\n  username: admin\n  password: ' + pw + '\n  (change it after first login)\n');
  if (generated) { try { fs.writeFileSync(path.join(DATA, 'initial-admin-password.txt'), 'username: admin\npassword: ' + pw + '\n(delete this file after changing the password)\n'); } catch (e) { } }
}

// ---------- collections ----------
const siteOk = id => { if (!db.sites[id]) throw new HttpErr(400, 'Unknown site'); return id; };
const photoOk = a => (Array.isArray(a) ? a : []).slice(0, 3).filter(id => /^[a-f0-9]{24}$/.test(id) && fs.existsSync(path.join(UP, id + '.jpg')));
const COL = {
  sites: {
    c: SCH, u: SCH, d: MGR,
    make: b => { if (!str(b.name)) throw new HttpErr(400, 'Site name required'); return { name: str(b.name, 200), client: str(b.client, 200), address: str(b.address, 300), status: STAT.includes(b.status) ? b.status : 'In progress' }; },
    patch: b => { const o = {}; if (b.name !== undefined && str(b.name)) o.name = str(b.name, 200); if (b.client !== undefined) o.client = str(b.client, 200); if (b.address !== undefined) o.address = str(b.address, 300); if (STAT.includes(b.status)) o.status = b.status; return o; }
  },
  reports: {
    c: ALL, u: NONE, d: MGR,
    make: (b, u) => {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60).map(i => ({ name: str(i.name, 100), taken: num(i.taken), returned: num(i.returned) })).filter(i => i.name && (i.taken || i.returned));
      const work = str(b.work, 4000); if (!work && !items.length) throw new HttpErr(400, 'Empty report');
      return { siteId: siteOk(b.siteId), date: dateOk(b.date), work, items, by: u.name };
    }
  },
  problems: {
    c: ALL, u: ALL, d: MGR,
    make: (b, u) => {
      const text = str(b.text, 4000), photos = photoOk(b.photos); if (!text && !photos.length) throw new HttpErr(400, 'Empty problem');
      return { siteId: siteOk(b.siteId), text, sev: SEV.includes(b.sev) ? b.sev : 'Medium', status: 'open', photos, date: today(), by: u.name };
    },
    patch: b => (['open', 'solved'].includes(b.status) ? { status: b.status } : {})
  },
  visits: {
    c: SCH, u: ALL, d: SCH,
    make: (b, u) => ({ siteId: siteOk(b.siteId), date: dateOk(b.date), time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '', note: str(b.note, 300), done: false, by: u.name }),
    patch: b => (typeof b.done === 'boolean' ? { done: b.done } : {})
  },
  chat: {
    c: ALL, u: NONE, d: MGR,
    make: (b, u) => { const t = str(b.text, 2000); if (!t) throw new HttpErr(400, 'Empty message'); return { siteId: siteOk(b.siteId), text: t, by: u.id, name: u.name, role: u.role }; }
  }
};
function removeDoc(col, id) {
  if (col === 'problems') (db.problems[id]?.photos || []).forEach(p => fs.unlink(path.join(UP, p + '.jpg'), () => { }));
  delete db[col][id];
}
function removeSite(id) {
  for (const c of ['reports', 'problems', 'visits', 'chat']) for (const k of Object.keys(db[c])) if (db[c][k].siteId === id) removeDoc(c, k);
  delete db.sites[id];
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUB = path.join(__dirname, 'public');
function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(new HttpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}
const json = async req => { const b = await readBody(req, 300000); if (!b.length) return {}; try { return JSON.parse(b.toString()); } catch (e) { throw new HttpErr(400, 'Bad JSON'); } };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
function authUser(req) {
  const t = cookies(req).sid, s = t && db.sessions[t];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users[s.u]; return u ? { id: s.u, ...u, token: t } : null;
}
const isHttps = req => req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress);
const fails = new Map();
const pub = u => ({ id: u.id, name: u.name, role: u.role, must: !!u.must });

async function api(req, res, url) {
  const m = req.method, parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
  const origin = req.headers.origin;
  if (m !== 'GET' && origin) { let h; try { h = new URL(origin).host; } catch (e) { } if (h !== req.headers.host) throw new HttpErr(403, 'Bad origin'); }

  if (parts[0] === 'login' && m === 'POST') {
    const ip = clientIp(req), f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 15 * 60000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 10) throw new HttpErr(429, 'Too many attempts. Try again in 15 minutes.');
    const b = await json(req), id = str(b.username, 60).toLowerCase(), u = db.users[id];
    const good = checkPw(String(b.password || ''), u || DUMMY) && !!u;
    if (!good) { f.n++; fails.set(ip, f); throw new HttpErr(401, 'Wrong username or password'); }
    fails.delete(ip);
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < Date.now()) delete db.sessions[k];
    const token = crypto.randomBytes(32).toString('hex'), age = 30 * 86400;
    db.sessions[token] = { u: id, exp: Date.now() + age * 1000 }; save(false);
    return send(res, 200, pub({ id, ...u }), { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${isHttps(req) ? '; Secure' : ''}` });
  }
  const user = authUser(req);
  if (!user) throw new HttpErr(401, 'Not signed in');

  if (parts[0] === 'logout' && m === 'POST') { delete db.sessions[user.token]; save(false); return send(res, 200, { ok: 1 }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' }); }
  if (parts[0] === 'me' && m === 'GET') return send(res, 200, pub(user));
  if (parts[0] === 'poll' && m === 'GET') return send(res, 200, { v: db.ver });
  if (parts[0] === 'data' && m === 'GET') {
    const out = { v: db.ver, users: Object.entries(db.users).map(([id, u]) => ({ id, name: u.name, role: u.role })) };
    for (const c of Object.keys(COL)) out[c] = Object.entries(db[c]).map(([id, d]) => ({ id, ...d }));
    return send(res, 200, out);
  }
  if (parts[0] === 'password' && m === 'POST') {
    const b = await json(req);
    if (!checkPw(String(b.old || ''), user)) throw new HttpErr(400, 'Current password is wrong');
    if (String(b.new || '').length < 6) throw new HttpErr(400, 'New password must be at least 6 characters');
    Object.assign(db.users[user.id], hashPw(String(b.new)), { must: false }); save(false); return send(res, 200, { ok: 1 });
  }
  if (parts[0] === 'upload' && m === 'POST') {
    const buf = await readBody(req, 8e6);
    if (buf.length < 100 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) throw new HttpErr(400, 'Only JPEG images are accepted');
    const id = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(UP, id + '.jpg'), buf); return send(res, 200, { id });
  }
  if (parts[0] === 'users') {
    must(user, ['Admin']);
    const id = parts[1];
    if (m === 'POST') {
      const b = await json(req), u = str(b.username, 40).toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new HttpErr(400, 'Username: 3+ characters, a-z 0-9 . _ -');
      if (db.users[u]) throw new HttpErr(400, 'Username already exists');
      if (!str(b.name) || !ROLES.includes(b.role) || String(b.password || '').length < 6) throw new HttpErr(400, 'Name, role and a password of 6+ characters are required');
      db.users[u] = { name: str(b.name, 100), role: b.role, ...hashPw(String(b.password)), must: true }; save(); return send(res, 200, { id: u });
    }
    const t = db.users[id]; if (!t) throw new HttpErr(404, 'No such user');
    if (m === 'PATCH') {
      const b = await json(req);
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role)) throw new HttpErr(400, 'Bad role');
        if (t.role === 'Admin' && b.role !== 'Admin' && Object.values(db.users).filter(x => x.role === 'Admin').length < 2) throw new HttpErr(400, 'Keep at least one Admin');
        t.role = b.role;
      }
      if (b.name !== undefined && str(b.name)) t.name = str(b.name, 100);
      if (b.password !== undefined) { if (String(b.password).length < 6) throw new HttpErr(400, 'Password must be 6+ characters'); Object.assign(t, hashPw(String(b.password)), { must: id !== user.id }); for (const k of Object.keys(db.sessions)) if (db.sessions[k].u === id && k !== user.token) delete db.sessions[k]; }
      save(); return send(res, 200, { ok: 1 });
    }
    if (m === 'DELETE') {
      if (id === user.id) throw new HttpErr(400, 'You cannot delete your own account');
      delete db.users[id]; for (const k of Object.keys(db.sessions)) if (db.sessions[k].u === id) delete db.sessions[k];
      save(); return send(res, 200, { ok: 1 });
    }
  }
  const C = COL[parts[0]];
  if (C) {
    const id = parts[1];
    if (m === 'POST') { must(user, C.c); const d = C.make(await json(req), user); d.ts = Date.now(); const nid = rid(); db[parts[0]][nid] = d; save(); return send(res, 200, { id: nid }); }
    const d = db[parts[0]][id]; if (!d) throw new HttpErr(404, 'Not found');
    if (m === 'PATCH') { must(user, C.u); Object.assign(d, C.patch ? C.patch(await json(req), d) : {}); save(); return send(res, 200, { ok: 1 }); }
    if (m === 'DELETE') { must(user, C.d); parts[0] === 'sites' ? removeSite(id) : removeDoc(parts[0], id); save(); return send(res, 200, { ok: 1 }); }
  }
  throw new HttpErr(404, 'Not found');
}

const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
};
http.createServer(async (req, res) => {
  for (const k in SEC) res.setHeader(k, SEC[k]);
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: 1 });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpErr(405, 'Method not allowed');
    if (url.pathname.startsWith('/uploads/')) {
      if (!authUser(req)) throw new HttpErr(401, 'Not signed in');
      const id = url.pathname.slice(9);
      if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpErr(404, 'Not found');
      return fs.readFile(path.join(UP, id + '.jpg'), (e, b) => {
        if (e) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); res.end(b);
      });
    }
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB + path.sep)) throw new HttpErr(403, 'Forbidden');
    fs.readFile(f, (e, b) => {
      if (e) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(b);
    });
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}).listen(PORT, HOST, () => console.log(`Site Manager running on http://${HOST}:${PORT}  (data: ${DATA})`));
process.on('SIGTERM', () => { saveSync(); process.exit(0); });
process.on('SIGINT', () => { saveSync(); process.exit(0); });
