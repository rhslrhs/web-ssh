'use strict';
/* global Terminal, FitAddon */

const $ = (s, el = document) => el.querySelector(s);
const isTouch = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== 'api/login') { showView('login'); throw new Error('로그인이 필요합니다'); }
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.data = data; throw e; }
  return data;
}

function showView(name) {
  for (const v of ['login', 'list', 'term']) $('#view-' + v).hidden = v !== name;
  if (name === 'login') { disconnect(); setTimeout(() => $('#login-pw').focus(), 0); }
}

// ── 로그인 ──
function setNeedCode(on) {
  $('#login-code').hidden = !on;
  $('#login-code').required = !!on;
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await api('POST', 'api/login', { password: $('#login-pw').value, code: $('#login-code').value.trim() });
    $('#login-pw').value = '';
    $('#login-code').value = '';
    route();
  } catch (err) {
    $('#login-err').textContent = err.message;
    $('#login-code').value = '';
    if (err.data && err.data.needCode) setNeedCode(true);
  }
});
$('#btn-logout').addEventListener('click', async () => { await api('POST', 'api/logout').catch(() => {}); showView('login'); });

// ── 호스트 목록 ──
let hosts = [];
let statusMap = {};
let statusTimer = null;

async function loadHosts() {
  hosts = await api('GET', 'api/hosts');
  renderList();
  refreshStatus();
}

async function refreshStatus() {
  try { statusMap = await api('GET', 'api/status'); } catch { return; }
  for (const el of document.querySelectorAll('.host[data-id]')) {
    const s = statusMap[el.dataset.id];
    const dot = $('.dot', el);
    dot.className = 'dot' + (s === true ? ' on' : s === false ? ' off' : '');
    dot.title = s === true ? '온라인' : s === false ? '오프라인' : '경유 호스트 (확인 불가)';
  }
}

function renderList() {
  const list = $('#host-list');
  list.textContent = '';
  if (!hosts.length) {
    list.append(h('div', { class: 'empty' }, '등록된 호스트가 없습니다.', h('br'), '오른쪽 위 “+ 호스트”로 NAS, PC, 서버를 추가하세요.'));
    return;
  }
  const groups = new Map();
  for (const x of hosts) {
    const g = x.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'ko'));
  for (const g of names) {
    if (names.length > 1 || g) list.append(h('h2', {}, g || '기타'));
    list.append(h('div', { class: 'cards' }, groups.get(g).map(hostCard)));
  }
}

function hostCard(x) {
  const jump = x.jumpId && hosts.find((j) => j.id === x.jumpId);
  return h('div', { class: 'host', 'data-id': x.id },
    h('a', { class: 'host-main', href: '#/term/' + encodeURIComponent(x.id) },
      h('span', { class: 'dot' }),
      h('div', { class: 'host-info' },
        h('div', { class: 'host-name' }, x.name),
        h('div', { class: 'host-sub' }, `${x.username}@${x.host}${x.port !== 22 ? ':' + x.port : ''}`),
        jump ? h('span', { class: 'badge' }, '경유: ' + jump.name) : null,
        x.command ? h('span', { class: 'badge', title: x.command }, '▶ ' + (x.command.length > 28 ? x.command.slice(0, 28) + '…' : x.command)) : null)),
    h('div', { class: 'host-actions' },
      x.mac ? h('button', { title: 'Wake-on-LAN', onclick: () => wakeHost(x) }, '켜기') : null,
      h('button', { onclick: () => openEditor(x) }, '편집')));
}

async function wakeHost(x) {
  try {
    await api('POST', `api/hosts/${x.id}/wake`);
  } catch (e) { return toast(e.message); }
  toast(`${x.name}: 켜기 신호 전송 — 부팅을 기다리는 중...`, 8000);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if ($('#view-list').hidden) return;
    const { online } = await api('GET', `api/hosts/${x.id}/status`).catch(() => ({}));
    if (online) { toast(`${x.name}: 온라인 ✓  눌러서 접속하세요`, 6000); refreshStatus(); return; }
  }
  toast(`${x.name}: 3분 동안 응답이 없습니다. BIOS/NIC 의 WOL 설정을 확인하세요.`, 8000);
}

// ── 호스트 편집 ──
let editing = null;
const dlgHost = $('#dlg-host');
const form = $('#host-form');

function updateAuthFields() {
  const t = form.authType.value;
  for (const el of form.querySelectorAll('.auth-password')) el.hidden = t !== 'password' && t !== 'key';
  for (const el of form.querySelectorAll('.auth-key')) el.hidden = t !== 'key';
  const saved = editing && editing.hasSecret;
  form.password.placeholder = t === 'key' ? '(선택) 키 인증 실패 시 사용' : saved && editing.authType === 'password' ? '저장됨 — 바꿀 때만 입력' : '';
  form.privateKey.placeholder = saved && editing.authType === 'key' ? '저장됨 — 바꿀 때만 붙여넣기' : '-----BEGIN OPENSSH PRIVATE KEY-----';
}
form.authType.addEventListener('change', updateAuthFields);

function openEditor(x) {
  editing = x || null;
  form.reset();
  $('#host-err').textContent = '';
  $('#host-form-title').textContent = x ? '호스트 편집' : '호스트 추가';
  $('#btn-del').hidden = !x;
  const jumpSel = form.jumpId;
  jumpSel.textContent = '';
  jumpSel.append(h('option', { value: '' }, '없음 (NAS 에서 직접 접속)'));
  for (const j of hosts) if (!x || j.id !== x.id) jumpSel.append(h('option', { value: j.id }, `${j.name} (${j.host})`));
  $('#group-list').replaceChildren(...[...new Set(hosts.map((y) => y.group).filter(Boolean))].map((g) => h('option', { value: g })));
  if (x) {
    for (const k of ['name', 'group', 'host', 'port', 'username', 'authType', 'jumpId', 'command', 'mac', 'wolBroadcast']) form[k].value = x[k] ?? '';
  }
  $('#hostkey-info').hidden = !(x && x.hostKey);
  $('#hostkey-fp').textContent = (x && x.hostKey) || '';
  updateAuthFields();
  dlgHost.showModal();
}

$('#btn-add').addEventListener('click', () => openEditor(null));
$('#btn-host-cancel').addEventListener('click', () => dlgHost.close());
$('#key-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) form.privateKey.value = (await f.text()).trim();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.port = Number(data.port) || 22;
  try {
    if (editing) await api('PUT', `api/hosts/${editing.id}`, data);
    else await api('POST', 'api/hosts', data);
    dlgHost.close();
    loadHosts();
  } catch (err) { $('#host-err').textContent = err.message; }
});

$('#btn-del').addEventListener('click', async () => {
  if (!editing || !confirm(`"${editing.name}" 을(를) 삭제할까요?`)) return;
  try {
    await api('DELETE', `api/hosts/${editing.id}`);
    dlgHost.close();
    loadHosts();
  } catch (err) { $('#host-err').textContent = err.message; }
});

$('#btn-reset-hk').addEventListener('click', async () => {
  if (!editing || !confirm('저장된 호스트 키를 지울까요? 다음 접속 때 새 키를 다시 확인합니다.')) return;
  await api('POST', `api/hosts/${editing.id}/reset-hostkey`);
  editing.hostKey = '';
  $('#hostkey-info').hidden = true;
  toast('호스트 키를 초기화했습니다');
  loadHosts();
});

// ── 보안 설정 ──
const dlgSec = $('#dlg-sec');

async function openSecurity() {
  $('#sec-err').textContent = '';
  $('#sec-totp-setup').hidden = true;
  let s;
  try { s = await api('GET', 'api/security'); } catch (e) { return toast(e.message); }
  $('#sec-net').textContent = `접속 IP ${s.ip} · ${s.privateNet ? '내부망/VPN' : '외부'} · 외부 접속 ${s.publicAccess ? '허용' + (s.allowList ? ' (허용 IP 제한)' : '') : '차단'}`;
  const st = $('#sec-totp-state');
  st.textContent = s.totp ? '사용 중' : '꺼짐';
  st.classList.toggle('on', s.totp);
  $('#sec-totp-on').hidden = !s.totp || !s.privateNet;
  $('#sec-totp-off').hidden = s.totp || !s.privateNet;
  $('#sec-private-only').hidden = s.privateNet;
  if (!dlgSec.open) dlgSec.showModal();
}

const secCall = async (url, body) => {
  $('#sec-err').textContent = '';
  try { return await api('POST', url, body); } catch (e) { $('#sec-err').textContent = e.message; return null; }
};

$('#sec-form').addEventListener('submit', (e) => e.preventDefault());
$('#btn-sec').addEventListener('click', openSecurity);
$('#btn-sec-close').addEventListener('click', () => dlgSec.close());
$('#btn-totp-start').addEventListener('click', async () => {
  const r = await secCall('api/security/totp/start');
  if (!r) return;
  $('#sec-qr').src = r.qr;
  $('#sec-secret').textContent = r.secret.match(/.{1,4}/g).join(' ');
  $('#sec-totp-setup').hidden = false;
  $('#sec-code-enable').value = '';
  $('#sec-code-enable').focus();
});
$('#btn-totp-enable').addEventListener('click', async () => {
  if (!(await secCall('api/security/totp/enable', { code: $('#sec-code-enable').value.trim() }))) return;
  toast('2단계 인증이 설정되었습니다. 다른 기기는 다시 로그인해야 합니다.', 5000);
  setNeedCode(true);
  openSecurity();
});
$('#btn-totp-disable').addEventListener('click', async () => {
  if (!confirm('2단계 인증을 해제할까요? 외부 접속이 차단됩니다.')) return;
  if (!(await secCall('api/security/totp/disable', { code: $('#sec-code-disable').value.trim() }))) return;
  $('#sec-code-disable').value = '';
  toast('2단계 인증을 해제했습니다.');
  setNeedCode(false);
  openSecurity();
});
$('#btn-logout-all').addEventListener('click', async () => {
  if (!confirm('모든 기기에서 로그아웃할까요?')) return;
  if (!(await secCall('api/security/logout-all'))) return;
  dlgSec.close();
  showView('login');
});
for (const id of ['#sec-code-enable', '#sec-code-disable']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $(id === '#sec-code-enable' ? '#btn-totp-enable' : '#btn-totp-disable').click(); }
  });
}

// ── 서버가 묻는 질문 (비밀번호 / 호스트 키 / 추가 인증) ──
const dlgAsk = $('#dlg-ask');
let askResolve = null;

function askDialog(m) {
  return new Promise((resolve) => {
    const body = $('#ask-body');
    body.textContent = '';
    let collect;
    if (m.kind === 'password') {
      $('#ask-title').textContent = m.label;
      const inp = h('input', { type: 'password', placeholder: '비밀번호', autocomplete: 'off' });
      body.append(inp);
      collect = () => inp.value;
    } else if (m.kind === 'hostkey') {
      $('#ask-title').textContent = '처음 접속하는 서버';
      body.append(
        h('p', {}, `${m.name} (${m.addr})\n이 서버의 지문이 맞는지 확인하세요. 확인하면 저장되고, 나중에 바뀌면 경고합니다.`),
        h('div', { class: 'fp' }, h('div', {}, m.keyType), h('code', {}, m.fingerprint)));
      collect = () => true;
    } else {
      $('#ask-title').textContent = m.title || '추가 인증';
      if (m.instructions) body.append(h('p', {}, m.instructions));
      const inputs = (m.prompts || []).map((p) => h('input', { type: p.echo ? 'text' : 'password', autocomplete: 'off' }));
      (m.prompts || []).forEach((p, i) => body.append(h('label', {}, p.prompt, inputs[i])));
      collect = () => inputs.map((i) => i.value);
    }
    askResolve = (ok) => { askResolve = null; dlgAsk.close(); resolve(ok ? collect() : (m.kind === 'hostkey' ? false : null)); };
    dlgAsk.showModal();
    const first = $('input', body);
    (first || $('#ask-ok')).focus();
  });
}
$('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); if (askResolve) askResolve(true); });
$('#ask-cancel').addEventListener('click', () => askResolve && askResolve(false));
dlgAsk.addEventListener('cancel', (e) => { e.preventDefault(); if (askResolve) askResolve(false); });

// ── 터미널 ──
let term = null;
let fit = null;
let ws = null;
let curHostId = null;
const mods = { ctrl: 0, alt: 0 }; // 0=off 1=한 번 2=고정

function fontSize() { return store.get('fontSize', isTouch ? 13 : 15); }

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontSize: fontSize(),
    fontFamily: '"Cascadia Mono", "D2Coding", "SF Mono", Menlo, Consolas, "Malgun Gothic", monospace',
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#3b5070' },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  term.onData((d) => sendInput(applyMods(d)));
  term.onResize(({ cols, rows }) => wsSend({ t: 'resize', cols, rows }));
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true;
    if (ev.code === 'KeyC') { copyText(term.getSelection()); return false; }
    if (ev.code === 'KeyV') return false; // 브라우저 기본 붙여넣기
    return true;
  });
  new ResizeObserver(scheduleFit).observe($('#term-wrap'));
}

let fitTimer;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { if (term && !$('#view-term').hidden) { try { fit.fit(); } catch { /* ignore */ } } }, 40);
}

// 모바일 키보드가 열리면 보이는 영역에 맞춰 터미널 크기 조정
function layoutViewport() {
  const vv = window.visualViewport;
  const v = $('#view-term');
  if (vv) { v.style.height = vv.height + 'px'; v.style.top = vv.offsetTop + 'px'; }
  scheduleFit();
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', layoutViewport);
  visualViewport.addEventListener('scroll', layoutViewport);
}

function copyText(text) {
  if (!text) return;
  const done = () => toast('복사됨', 1200);
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, () => {}); return; }
  const ta = h('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  ta.remove();
  term.focus();
}

function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendInput(d) { if (d) wsSend({ t: 'i', d }); }

function applyMods(d) {
  if (mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64);
    else if (d === ' ') d = '\x00';
    else if (d === '?') d = '\x7f';
  }
  if (mods.alt) d = '\x1b' + d;
  if (mods.ctrl === 1) mods.ctrl = 0;
  if (mods.alt === 1) mods.alt = 0;
  renderMods();
  return d;
}

function setStatus(s) { $('#term-status').textContent = s; }
function showOverlay(msg) { $('#overlay-msg').textContent = msg; $('#term-overlay').hidden = false; }

async function openTerm(id) {
  showView('term');
  ensureTerm();
  layoutViewport();
  if (curHostId === id && ws && ws.readyState <= 1) { term.focus(); return; }
  if (!hosts.length) { try { hosts = await api('GET', 'api/hosts'); } catch { return; } }
  const host = hosts.find((x) => x.id === id);
  disconnect();
  curHostId = id;
  $('#term-name').textContent = host ? host.name : '알 수 없는 호스트';
  document.title = (host ? host.name : 'SSH') + ' — Web SSH';
  connect();
}

function connect() {
  $('#term-overlay').hidden = true;
  term.reset();
  setStatus('연결 중...');
  const sock = new WebSocket(new URL('ws', location.href).href.replace(/^http/, 'ws'));
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let gotEnd = false;
  sock.onopen = () => {
    try { fit.fit(); } catch { /* ignore */ }
    sock.send(JSON.stringify({ t: 'connect', hostId: curHostId, cols: term.cols, rows: term.rows }));
  };
  sock.onmessage = async (ev) => {
    if (sock !== ws) return;
    if (typeof ev.data !== 'string') { term.write(new Uint8Array(ev.data)); return; }
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'status': setStatus(m.msg); term.write(`\x1b[90m${m.msg}\x1b[0m\r\n`); break;
      case 'ask': {
        const value = await askDialog(m);
        if (sock === ws) sock.send(JSON.stringify({ t: 'answer', id: m.id, value }));
        break;
      }
      case 'ready': setStatus('연결됨'); scheduleFit(); term.focus(); break;
      case 'error': gotEnd = true; setStatus('오류'); showOverlay(m.msg); break;
      case 'closed': gotEnd = true; setStatus('종료됨'); showOverlay('연결이 종료되었습니다.'); break;
    }
  };
  sock.onclose = () => {
    if (sock !== ws) return;
    if (!gotEnd) { setStatus('끊김'); showOverlay('서버와의 연결이 끊어졌습니다.'); }
  };
}

function disconnect() {
  if (ws) { const s = ws; ws = null; s.onclose = null; s.close(); }
  curHostId = null;
}

$('#btn-reconnect').addEventListener('click', () => { const id = curHostId; disconnect(); curHostId = id; connect(); });

// 상단 버튼
for (const b of document.querySelectorAll('.term-bar [data-act]')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'font+' || act === 'font-') {
      const s = Math.min(28, Math.max(8, fontSize() + (act === 'font+' ? 1 : -1)));
      store.set('fontSize', s);
      term.options.fontSize = s;
      scheduleFit();
    } else if (act === 'input') {
      const li = $('#line-input');
      li.hidden = !li.hidden;
      b.classList.toggle('on', !li.hidden);
      if (!li.hidden) $('#line-text').focus(); else term.focus();
      scheduleFit();
    } else if (act === 'keys') {
      const kb = $('#keybar');
      kb.hidden = !kb.hidden;
      store.set('keybar', !kb.hidden);
      b.classList.toggle('on', !kb.hidden);
      scheduleFit();
    }
  });
}

// 입력창: 한글 IME / 붙여넣기용
$('#line-input').addEventListener('submit', (e) => {
  e.preventDefault();
  sendInput($('#line-text').value + '\r');
  $('#line-text').value = '';
});
$('#line-noenter').addEventListener('click', () => {
  sendInput($('#line-text').value);
  $('#line-text').value = '';
  $('#line-text').focus();
});

// ── 특수키 바 ──
const arrow = (c) => () => (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
const KEYS = [
  { l: 'Esc', s: '\x1b' }, { l: 'Tab', s: '\t' }, { l: 'Ctrl', mod: 'ctrl' }, { l: 'Alt', mod: 'alt' },
  { sep: 1 },
  { l: '←', f: arrow('D'), rep: 1 }, { l: '↓', f: arrow('B'), rep: 1 }, { l: '↑', f: arrow('A'), rep: 1 }, { l: '→', f: arrow('C'), rep: 1 },
  { sep: 1 },
  { l: '^C', s: '\x03' }, { l: '^D', s: '\x04' }, { l: '^Z', s: '\x1a' }, { l: '^R', s: '\x12' }, { l: '^L', s: '\x0c' },
  { sep: 1 },
  { l: '|' }, { l: '/' }, { l: '-' }, { l: '~' }, { l: ':' }, { l: '$' }, { l: '&' }, { l: '*' }, { l: '>' },
  { sep: 1 },
  { l: 'Home', f: arrow('H') }, { l: 'End', f: arrow('F') }, { l: 'PgUp', s: '\x1b[5~' }, { l: 'PgDn', s: '\x1b[6~' }, { l: 'Del', s: '\x1b[3~', rep: 1 },
  { sep: 1 },
  { l: 'F1', s: '\x1bOP' }, { l: 'F2', s: '\x1bOQ' }, { l: 'F3', s: '\x1bOR' }, { l: 'F4', s: '\x1bOS' },
  { l: 'F5', s: '\x1b[15~' }, { l: 'F10', s: '\x1b[21~' },
];
const modBtns = {};

function renderMods() {
  for (const k of ['ctrl', 'alt']) {
    modBtns[k].classList.toggle('on', mods[k] === 1);
    modBtns[k].classList.toggle('lock', mods[k] === 2);
  }
}

function buildKeybar() {
  const bar = $('#keybar');
  for (const k of KEYS) {
    if (k.sep) { bar.append(h('span', { class: 'sep' })); continue; }
    const b = h('button', { type: 'button', tabindex: '-1' }, k.l);
    if (k.mod) modBtns[k.mod] = b;
    let timer = null;
    let moved = false;
    let repeated = false;
    let startX = 0;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    const fire = () => {
      if (k.mod) { mods[k.mod] = (mods[k.mod] + 1) % 3; renderMods(); return; }
      const seq = k.f ? k.f() : k.s != null ? k.s : k.l;
      // 일반 문자는 Ctrl/Alt 수식을 적용, 제어 시퀀스는 그대로
      sendInput(k.s == null && !k.f ? applyMods(seq) : seq);
    };
    // pointerdown + preventDefault: 터미널 포커스(모바일 키보드)를 유지
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      moved = false;
      repeated = false;
      startX = e.clientX;
      if (k.rep) timer = setTimeout(() => { repeated = true; fire(); timer = setInterval(fire, 60); }, 400);
    });
    b.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - startX) > 10) { moved = true; stop(); } });
    b.addEventListener('pointerup', () => {
      if (!moved && !repeated) fire();
      stop();
    });
    b.addEventListener('pointercancel', stop);
    b.addEventListener('pointerleave', stop);
    bar.append(b);
  }
  bar.hidden = !store.get('keybar', isTouch);
  $('.term-bar [data-act=keys]').classList.toggle('on', !bar.hidden);
}
buildKeybar();

// ── 라우팅 ──
function route() {
  const m = location.hash.match(/^#\/term\/(.+)$/);
  if (m) { clearInterval(statusTimer); openTerm(decodeURIComponent(m[1])); return; }
  disconnect();
  document.title = 'Web SSH';
  showView('list');
  loadHosts().catch(() => {});
  clearInterval(statusTimer);
  statusTimer = setInterval(() => { if (!$('#view-list').hidden) refreshStatus(); }, 15000);
}
function checkAuth() {
  return api('GET', 'api/me').then((r) => {
    setNeedCode(r.needCode);
    if (r.authed) route(); else showView('login');
  }, () => showView('login'));
}
window.addEventListener('hashchange', checkAuth);
checkAuth();
