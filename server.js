/* Dropline — share files, links and messages between devices.
   Node + Express + ws. Data persists to ./data, uploads to ./data/uploads. */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3210;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_FILE_MB = 500;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- store ---------- */
// sessions: { [code]: { code, name, createdAt, members: {deviceId: {name, joinedAt, lastSeen}}, messages: [] } }
let store = { sessions: {} };
try {
  store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  if (!store.sessions) store = { sessions: {} };
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STORE_FILE, JSON.stringify(store), (err) => {
      if (err) console.error('save failed:', err.message);
    });
  }, 150);
}

function newCode() {
  let code;
  do {
    code = String(crypto.randomInt(100000, 999999));
  } while (store.sessions[code]);
  return code;
}

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) return i.address;
    }
  }
  return 'localhost';
}

function publicSession(s, deviceId) {
  return {
    code: s.code,
    name: s.name,
    createdAt: s.createdAt,
    memberCount: Object.keys(s.members).length,
    members: Object.entries(s.members).map(([id, m]) => ({ deviceId: id, name: m.name })),
    lastMessage: s.messages[s.messages.length - 1] || null,
    unread: 0,
    you: deviceId,
  };
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, req.params.code);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

function requireSession(req, res, next) {
  const s = store.sessions[req.params.code];
  if (!s) return res.status(404).json({ error: 'Session not found. Check the code.' });
  req.session = s;
  next();
}

app.post('/api/sessions', (req, res) => {
  const { deviceId, userName, name } = req.body || {};
  if (!deviceId || !userName) return res.status(400).json({ error: 'deviceId and userName required' });
  const code = newCode();
  const s = {
    code,
    name: (name || '').trim().slice(0, 60) || `${userName}'s session`,
    createdAt: Date.now(),
    members: { [deviceId]: { name: userName.slice(0, 40), joinedAt: Date.now(), lastSeen: Date.now() } },
    messages: [],
  };
  s.messages.push(sysMsg(`${userName} created the session`));
  store.sessions[code] = s;
  save();
  res.json(publicSession(s, deviceId));
});

app.post('/api/sessions/:code/join', requireSession, (req, res) => {
  const { deviceId, userName } = req.body || {};
  if (!deviceId || !userName) return res.status(400).json({ error: 'deviceId and userName required' });
  const s = req.session;
  const isNew = !s.members[deviceId];
  s.members[deviceId] = {
    name: userName.slice(0, 40),
    joinedAt: s.members[deviceId]?.joinedAt || Date.now(),
    lastSeen: Date.now(),
  };
  if (isNew) {
    const m = sysMsg(`${userName} joined`);
    s.messages.push(m);
    broadcast(s.code, { type: 'message', message: m });
    broadcast(s.code, { type: 'members', members: publicSession(s, deviceId).members });
  }
  save();
  res.json(publicSession(s, deviceId));
});

app.post('/api/sessions/:code/leave', requireSession, (req, res) => {
  const { deviceId } = req.body || {};
  const s = req.session;
  const member = s.members[deviceId];
  if (member) {
    delete s.members[deviceId];
    const m = sysMsg(`${member.name} left`);
    s.messages.push(m);
    broadcast(s.code, { type: 'message', message: m });
    save();
  }
  res.json({ ok: true });
});

app.get('/api/sessions/:code', requireSession, (req, res) => {
  const s = req.session;
  res.json({ ...publicSession(s, req.query.deviceId), messages: s.messages.slice(-500) });
});

app.get('/api/my-sessions', (req, res) => {
  const { deviceId } = req.query;
  const list = Object.values(store.sessions)
    .filter((s) => deviceId && s.members[deviceId])
    .map((s) => publicSession(s, deviceId))
    .sort((a, b) => (b.lastMessage?.ts || b.createdAt) - (a.lastMessage?.ts || a.createdAt));
  res.json(list);
});

app.get('/api/sessions/:code/qr', requireSession, async (req, res) => {
  const joinUrl = `http://${lanIP()}:${PORT}/#join=${req.params.code}`;
  const dataUrl = await QRCode.toDataURL(joinUrl, { width: 480, margin: 2, color: { dark: '#0e1b16', light: '#ffffff' } });
  res.json({ joinUrl, dataUrl, code: req.params.code });
});

app.post('/api/sessions/:code/messages', requireSession, (req, res) => {
  const { deviceId, text } = req.body || {};
  const s = req.session;
  const member = s.members[deviceId];
  if (!member) return res.status(403).json({ error: 'Join the session first' });
  const clean = String(text || '').trim().slice(0, 8000);
  if (!clean) return res.status(400).json({ error: 'Empty message' });
  const m = {
    id: crypto.randomUUID(),
    type: 'text',
    text: clean,
    sender: { deviceId, name: member.name },
    ts: Date.now(),
  };
  s.messages.push(m);
  trim(s);
  save();
  broadcast(s.code, { type: 'message', message: m });
  res.json(m);
});

app.post('/api/sessions/:code/files', requireSession, upload.array('files', 10), (req, res) => {
  const { deviceId } = req.body || {};
  const s = req.session;
  const member = s.members[deviceId];
  if (!member) return res.status(403).json({ error: 'Join the session first' });
  const created = [];
  for (const f of req.files || []) {
    const m = {
      id: crypto.randomUUID(),
      type: 'file',
      file: {
        id: path.basename(f.filename),
        name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
        size: f.size,
        mime: f.mimetype,
      },
      sender: { deviceId, name: member.name },
      ts: Date.now(),
    };
    m.file.url = `/files/${s.code}/${m.file.id}/${encodeURIComponent(m.file.name)}`;
    s.messages.push(m);
    created.push(m);
    broadcast(s.code, { type: 'message', message: m });
  }
  trim(s);
  save();
  res.json(created);
});

app.get('/files/:code/:id/:name', (req, res) => {
  const { code, id, name } = req.params;
  if (!store.sessions[code]) return res.status(404).send('Not found');
  const fp = path.join(UPLOAD_DIR, code, path.basename(id));
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  const msg = store.sessions[code].messages.find((m) => m.file && m.file.id === id);
  const mime = msg?.file?.mime || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  const disp = req.query.dl ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(name)}`);
  fs.createReadStream(fp).pipe(res);
});

function sysMsg(text) {
  return { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() };
}

function trim(s) {
  if (s.messages.length > 2000) s.messages = s.messages.slice(-1500);
}

// multer / generic error handler → JSON, never an HTML stack page
app.use((err, req, res, next) => {
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_FILE_MB} MB)` : err.message || 'Server error';
    return res.status(400).json({ error: msg });
  }
  next();
});

/* ---------- websockets ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // code -> Set<ws>

function broadcast(code, payload) {
  const set = rooms.get(code);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  const deviceId = url.searchParams.get('deviceId');
  const s = code && store.sessions[code];
  if (!s || !deviceId || !s.members[deviceId]) { ws.close(4001, 'not a member'); return; }

  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'typing') {
      const name = s.members[deviceId]?.name;
      if (name) broadcast(code, { type: 'typing', deviceId, name });
    }
  });

  ws.on('close', () => {
    const set = rooms.get(code);
    if (set) { set.delete(ws); if (!set.size) rooms.delete(code); }
    if (s.members[deviceId]) { s.members[deviceId].lastSeen = Date.now(); save(); }
  });
});

// heartbeat: reap dead connections so rooms never leak
setInterval(() => {
  for (const set of rooms.values()) {
    for (const ws of set) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dropline running:`);
  console.log(`  This device:   http://localhost:${PORT}`);
  console.log(`  Other devices: http://${lanIP()}:${PORT}  (same Wi-Fi)`);
});
