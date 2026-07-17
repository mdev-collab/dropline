/* Dropline client — vanilla JS, no build step. */
'use strict';

const $ = (id) => document.getElementById(id);
const app = $('app');

/* ---------- identity ---------- */
const deviceId = localStorage.deviceId || (localStorage.deviceId = crypto.randomUUID());
let userName = localStorage.userName || '';

/* ---------- state ---------- */
let sessions = [];          // sidebar list
let current = null;         // active session object (with messages)
let ws = null;
let wsBackoff = 1000;
let typingTimer = null;
let typingHideTimer = null;

/* ---------- helpers ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('visible'), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkify(text) {
  return esc(text).replace(/\bhttps?:\/\/[^\s<]+/gi, (url) => {
    const clean = url.replace(/[.,;:!?)\]]+$/, '');
    const tail = esc(url.slice(clean.length));
    return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${esc(clean)}</a>${tail}`;
  });
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const today = now.toDateString(), that = d.toDateString();
  if (that === today) return 'Today';
  now.setDate(now.getDate() - 1);
  if (that === now.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const AVATAR_HUES = [165, 25, 265, 210, 330, 85, 45, 300];
function avatarColor(code) {
  let h = 0;
  for (const ch of String(code)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `oklch(0.55 0.13 ${AVATAR_HUES[h % AVATAR_HUES.length]})`;
}

function previewText(m) {
  if (!m) return 'No messages yet';
  if (m.type === 'file') return `📎 ${m.file.name}`;
  if (m.type === 'system') return m.text;
  return (m.sender ? m.sender.name + ': ' : '') + m.text;
}

/* ---------- sidebar ---------- */
async function loadSessions() {
  try {
    sessions = await api(`/api/my-sessions?deviceId=${deviceId}`);
  } catch { sessions = []; }
  renderSidebar();
}

function renderSidebar() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('session-list');
  const items = sessions.filter((s) => !q || s.name.toLowerCase().includes(q) || s.code.includes(q));
  if (!items.length) {
    list.innerHTML = `<div class="sidebar-empty"><strong>${sessions.length ? 'No matches' : 'No sessions yet'}</strong>${sessions.length ? 'Try a different search.' : 'Create one, or join with a code from another device.'}</div>`;
    return;
  }
  list.innerHTML = items.map((s) => `
    <button class="session-item ${current && current.code === s.code ? 'active' : ''}" data-code="${s.code}">
      <span class="avatar" style="background:${avatarColor(s.code)}">${esc(s.name.trim().charAt(0).toUpperCase() || '#')}</span>
      <span class="s-body">
        <span class="s-row">
          <span class="s-name">${esc(s.name)}</span>
          <span class="s-time">${s.lastMessage ? fmtTime(s.lastMessage.ts) : ''}</span>
        </span>
        <span class="s-preview">${esc(previewText(s.lastMessage))}</span>
      </span>
    </button>`).join('');
  list.querySelectorAll('.session-item').forEach((el) =>
    el.addEventListener('click', () => openSession(el.dataset.code)));
}

/* ---------- chat ---------- */
async function openSession(code) {
  try {
    current = await api(`/api/sessions/${code}?deviceId=${deviceId}`);
  } catch (e) { toast(e.message); return; }
  app.classList.add('in-chat');
  $('welcome').style.display = 'none';
  $('chat').classList.add('visible');
  $('chat-name').textContent = current.name;
  $('code-chip-text').textContent = current.code.slice(0, 3) + ' ' + current.code.slice(3);
  updateSub();
  renderMessages();
  renderSidebar();
  connectWS();
  $('input').focus();
}

function closeChat() {
  app.classList.remove('in-chat');
  current = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  $('chat').classList.remove('visible');
  $('welcome').style.display = '';
  renderSidebar();
}

function updateSub(typingName) {
  const sub = $('chat-sub');
  if (typingName) {
    sub.innerHTML = `<span class="typing">${esc(typingName)} is typing…</span>`;
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => updateSub(), 2500);
  } else {
    const n = current ? current.memberCount : 0;
    sub.textContent = `${n} member${n === 1 ? '' : 's'} · code ${current ? current.code : ''}`;
  }
}

function msgHTML(m, prev) {
  if (m.type === 'system') return `<div class="sys-msg">${esc(m.text)}</div>`;
  const mine = m.sender.deviceId === deviceId;
  const same = prev && prev.type !== 'system' && prev.sender && prev.sender.deviceId === m.sender.deviceId && m.ts - prev.ts < 180000;
  let body;
  if (m.type === 'file') {
    const isImg = m.file.mime && m.file.mime.startsWith('image/');
    if (isImg) {
      body = `<div class="bubble img-bubble">
        <img src="${esc(m.file.url)}" alt="${esc(m.file.name)}" loading="lazy" data-full="${esc(m.file.url)}">
        <div class="img-caption file-size">${esc(m.file.name)} · ${fmtSize(m.file.size)}</div>
      </div>`;
    } else {
      body = `<div class="bubble"><div class="file-card">
        <span class="file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></span>
        <span class="file-info"><span class="file-name">${esc(m.file.name)}</span><span class="file-size">${fmtSize(m.file.size)}</span></span>
        <a class="file-dl icon-btn" href="${esc(m.file.url)}?dl=1" download="${esc(m.file.name)}" title="Download" aria-label="Download ${esc(m.file.name)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        </a>
      </div></div>`;
    }
  } else {
    body = `<div class="bubble">${linkify(m.text)}</div>`;
  }
  return `<div class="msg ${mine ? 'mine' : 'theirs'} ${same ? 'same' : ''}">
    ${!mine && !same ? `<div class="msg-sender">${esc(m.sender.name)}</div>` : ''}
    ${body}
    ${!same ? `<div class="msg-meta">${fmtTime(m.ts)}</div>` : ''}
  </div>`;
}

function renderMessages() {
  const box = $('messages');
  let html = '', prev = null, prevDay = '';
  for (const m of current.messages) {
    const day = fmtDay(m.ts);
    if (day !== prevDay) { html += `<div class="day-sep">${day}</div>`; prevDay = day; prev = null; }
    html += msgHTML(m, prev);
    prev = m;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  if (!current) return;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prev = current.messages[current.messages.length - 1];
  const day = fmtDay(m.ts);
  if (!prev || fmtDay(prev.ts) !== day) box.insertAdjacentHTML('beforeend', `<div class="day-sep">${day}</div>`);
  current.messages.push(m);
  box.insertAdjacentHTML('beforeend', msgHTML(m, prev && fmtDay(prev.ts) === day ? prev : null));
  if (nearBottom || (m.sender && m.sender.deviceId === deviceId)) box.scrollTop = box.scrollHeight;
  const side = sessions.find((s) => s.code === current.code);
  if (side) { side.lastMessage = m; renderSidebar(); }
}

/* ---------- websocket ---------- */
function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }
  if (!current) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?code=${current.code}&deviceId=${deviceId}`);
  ws.onopen = () => { wsBackoff = 1000; };
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === 'message') {
      appendMessage(d.message);
      if (d.message.type === 'system') refreshCurrentMeta();
    } else if (d.type === 'typing' && d.deviceId !== deviceId) {
      updateSub(d.name);
    } else if (d.type === 'members') {
      refreshCurrentMeta();
    }
  };
  ws.onclose = () => {
    if (!current) return;
    setTimeout(() => { if (current) connectWS(); }, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);
  };
}

async function refreshCurrentMeta() {
  if (!current) return;
  try {
    const fresh = await api(`/api/sessions/${current.code}?deviceId=${deviceId}`);
    current.memberCount = fresh.memberCount;
    current.members = fresh.members;
    updateSub();
  } catch { /* ignore */ }
}

/* ---------- sending ---------- */
async function sendText() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = '';
  autosize();
  try {
    await api(`/api/sessions/${current.code}/messages`, { method: 'POST', body: { deviceId, text } });
  } catch (e) { toast(e.message); input.value = text; }
}

async function sendFiles(files) {
  if (!current || !files.length) return;
  const fd = new FormData();
  fd.append('deviceId', deviceId);
  for (const f of files) fd.append('files', f);
  const bar = $('upload-bar');
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/sessions/${current.code}/files`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) bar.style.transform = `scaleX(${e.loaded / e.total})`;
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else { try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch { reject(new Error('Upload failed')); } }
      };
      xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
      xhr.send(fd);
    });
  } catch (e) { toast(e.message); }
  bar.style.transform = 'scaleX(0)';
}

/* ---------- name flow ---------- */
function askName() {
  return new Promise((resolve) => {
    const dlg = $('name-dialog');
    $('name-input').value = userName;
    dlg.showModal();
    $('name-form').onsubmit = (e) => {
      const v = $('name-input').value.trim();
      if (!v) { e.preventDefault(); $('name-error').textContent = 'Please enter a name.'; return; }
      userName = v;
      localStorage.userName = v;
      resolve(v);
    };
  });
}

async function ensureName() {
  if (!userName) await askName();
  return userName;
}

/* ---------- create / join ---------- */
async function createSession() {
  await ensureName();
  const dlg = $('create-dialog');
  $('create-name').value = '';
  $('create-error').textContent = '';
  dlg.showModal();
  $('create-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const s = await api('/api/sessions', { method: 'POST', body: { deviceId, userName, name: $('create-name').value } });
      dlg.close();
      await loadSessions();
      await openSession(s.code);
      showInvite();
    } catch (err) { $('create-error').textContent = err.message; }
  };
}

async function joinSession(prefill) {
  await ensureName();
  const dlg = $('join-dialog');
  $('join-code').value = prefill || '';
  $('join-error').textContent = '';
  dlg.showModal();
  $('join-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('join-code').value.replace(/\D/g, '');
    if (code.length !== 6) { $('join-error').textContent = 'The code is 6 digits.'; return; }
    try {
      await api(`/api/sessions/${code}/join`, { method: 'POST', body: { deviceId, userName } });
      dlg.close();
      await loadSessions();
      await openSession(code);
    } catch (err) { $('join-error').textContent = err.message; }
  };
}

async function showInvite() {
  if (!current) return;
  try {
    const q = await api(`/api/sessions/${current.code}/qr`);
    $('qr-img').src = q.dataUrl;
    $('invite-code').textContent = current.code.slice(0, 3) + ' ' + current.code.slice(3);
    $('invite-url').textContent = q.joinUrl;
    $('copy-link-btn').onclick = () => { navigator.clipboard.writeText(q.joinUrl).then(() => toast('Link copied')); };
    $('invite-dialog').showModal();
  } catch (e) { toast(e.message); }
}

async function leaveSession() {
  if (!current) return;
  if (!confirm(`Leave "${current.name}"? You can rejoin with code ${current.code}.`)) return;
  const code = current.code;
  try { await api(`/api/sessions/${code}/leave`, { method: 'POST', body: { deviceId } }); } catch { /* ignore */ }
  closeChat();
  sessions = sessions.filter((s) => s.code !== code);
  renderSidebar();
}

/* ---------- composer niceties ---------- */
function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}

/* ---------- wire up ---------- */
$('new-session-btn').addEventListener('click', createSession);
$('welcome-new').addEventListener('click', createSession);
$('join-session-btn').addEventListener('click', () => joinSession());
$('welcome-join').addEventListener('click', () => joinSession());
$('back-btn').addEventListener('click', closeChat);
$('leave-btn').addEventListener('click', leaveSession);
$('invite-btn').addEventListener('click', showInvite);
$('send-btn').addEventListener('click', sendText);
$('search').addEventListener('input', renderSidebar);
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { sendFiles([...e.target.files]); e.target.value = ''; });
$('rename-btn').addEventListener('click', async () => {
  await askName();
  toast(`You're now "${userName}"`);
});

$('code-chip').addEventListener('click', () => {
  if (!current) return;
  navigator.clipboard.writeText(current.code).then(() => toast('Code copied'));
});

const input = $('input');
input.addEventListener('input', () => {
  autosize();
  if (ws && ws.readyState === 1 && !typingTimer) {
    ws.send(JSON.stringify({ type: 'typing' }));
    typingTimer = setTimeout(() => { typingTimer = null; }, 1500);
  }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); sendFiles(files); }
});

/* drag & drop */
let dragDepth = 0;
const main = $('main');
main.addEventListener('dragenter', (e) => {
  if (!current || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').classList.add('visible');
});
main.addEventListener('dragover', (e) => { if (current) e.preventDefault(); });
main.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.remove('visible'); }
});
main.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.remove('visible');
  if (current) sendFiles([...e.dataTransfer.files]);
});

/* dialogs: cancel buttons + click-outside close */
document.querySelectorAll('dialog').forEach((dlg) => {
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
});

/* image lightbox */
$('messages').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-full]');
  if (img) { $('lightbox-img').src = img.dataset.full; $('lightbox').showModal(); }
});

/* refresh sidebar occasionally when idle in list */
setInterval(() => { if (!current) loadSessions(); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { loadSessions(); if (current) refreshCurrentMeta(); }
});

/* ---------- boot ---------- */
(async function boot() {
  await loadSessions();
  const m = location.hash.match(/join=(\d{6})/);
  if (m) {
    history.replaceState(null, '', location.pathname);
    await ensureName();
    try {
      await api(`/api/sessions/${m[1]}/join`, { method: 'POST', body: { deviceId, userName } });
      await loadSessions();
      await openSession(m[1]);
    } catch (e) { toast(e.message); }
  }
})();
