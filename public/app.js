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
  for (const v of ['login', 'list', 'term', 'wake']) $('#view-' + v).hidden = v !== name;
  if (name === 'login') { disconnect(); setTimeout(() => $('#login-pw').focus(), 0); }
}

// ── 패스키 (WebAuthn) ──
const pkSupported = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
let pkInfo = { count: 0, origins: [] };
const pkOriginOk = () => location.hostname === 'localhost' || pkInfo.origins.includes(location.origin);
const toBuf = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0)).buffer;
};
const fromBuf = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkErr = (e) => (e && e.name === 'NotAllowedError' ? '취소되었거나 시간이 지났습니다.' : e && e.name === 'InvalidStateError' ? '이 기기는 이미 등록되어 있습니다.' : (e && e.message) || String(e));

async function passkeyLogin() {
  $('#login-err').textContent = '';
  try {
    const o = await api('POST', 'api/passkey/login/options', {});
    const cred = await navigator.credentials.get({ publicKey: {
      ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: toBuf(x.id) })),
    } });
    const r = cred.response;
    await api('POST', 'api/passkey/login/verify', { response: {
      id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: { clientDataJSON: fromBuf(r.clientDataJSON), authenticatorData: fromBuf(r.authenticatorData), signature: fromBuf(r.signature), userHandle: r.userHandle ? fromBuf(r.userHandle) : undefined },
    } });
    $('#login-pw').value = '';
    route();
  } catch (e) { $('#login-err').textContent = pkErr(e); }
}
$('#login-passkey').addEventListener('click', passkeyLogin);

async function passkeyRegister() {
  const btn = $('#btn-pk-add');
  if (btn.disabled) return;
  btn.disabled = true;
  $('#sec-err').textContent = '';
  try {
    const o = await api('POST', 'api/passkey/register/options', {});
    const cred = await navigator.credentials.create({ publicKey: {
      ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: toBuf(x.id) })),
    } });
    const r = cred.response;
    await api('POST', 'api/passkey/register/verify', { label: deviceLabel(), response: {
      id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: { clientDataJSON: fromBuf(r.clientDataJSON), attestationObject: fromBuf(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
    } });
    toast('패스키를 등록했습니다. 다음부터 지문으로 로그인할 수 있습니다.', 4000);
  } catch (e) { $('#sec-err').textContent = pkErr(e); }
  btn.disabled = false;
  renderPasskeys();
}
$('#btn-pk-add').addEventListener('click', passkeyRegister);

async function renderPasskeys(privateNet) {
  let info;
  try { info = await api('GET', 'api/passkey'); } catch (e) { $('#pk-help').textContent = e.message; return; }
  pkInfo.origins = info.origins;
  const help = $('#pk-help');
  const where = info.origins[0] || 'HTTPS 도메인(PUBLIC_ORIGIN 설정)';
  let can = false;
  if (!pkSupported) help.textContent = window.isSecureContext ? '이 브라우저는 패스키를 지원하지 않습니다.' : `패스키는 HTTPS 주소(${where})로 접속해야 쓸 수 있습니다.`;
  else if (!pkOriginOk()) help.textContent = `패스키는 ${where} 주소로 접속했을 때만 등록·사용할 수 있습니다.`;
  else if (privateNet === false) help.textContent = '패스키 등록은 내부망/VPN 에서만 할 수 있습니다.';
  else { help.textContent = '등록하면 비밀번호·OTP 대신 지문이나 얼굴 인식으로 로그인합니다.'; can = true; }
  $('#btn-pk-add').hidden = !can;
  const st = $('#pk-state');
  st.textContent = info.creds.length ? `${info.creds.length}개 등록` : '없음';
  st.classList.toggle('on', info.creds.length > 0);
  const ul = $('#pk-list');
  ul.textContent = '';
  for (const c of info.creds) {
    const used = c.lastUsed ? `최근 ${new Date(c.lastUsed).toLocaleDateString()}` : '사용 전';
    ul.append(h('li', {},
      h('span', {}, c.label, ' ', h('small', {}, `· ${new Date(c.created).toLocaleDateString()} 등록 · ${used}`)),
      privateNet === false ? null : h('button', { type: 'button', class: 'ghost small danger', onclick: async () => {
        if (!confirm(`"${c.label}" 패스키를 삭제할까요?\n(기기에 저장된 패스키는 기기 설정에서 따로 지워야 합니다)`)) return;
        await secCall(`api/passkey/${encodeURIComponent(c.id)}`, undefined, 'DELETE');
        renderPasskeys(privateNet);
      } }, '삭제')));
  }
}

// ── 로그인 ──
// OTP 가 켜져 있으면 화면은 2단계(비밀번호 → 다음 → OTP)지만, 서버에는 마지막에 둘을 함께 보낸다.
// 1단계에서 비밀번호만 따로 검증하면 "비밀번호가 맞다"는 정보가 새므로 의도적으로 하지 않는다.
let needCode = false;
let loginStep = 1;

function setLoginStep(step) {
  loginStep = needCode ? step : 1;
  $('#login-step1').hidden = loginStep !== 1;
  $('#login-step2').hidden = loginStep !== 2;
  $('#login-submit').textContent = needCode && loginStep === 1 ? '다음' : '로그인';
  $('#login-dots').hidden = !needCode;
  const dots = $('#login-dots').children;
  dots[0].className = loginStep === 1 ? 'on' : 'done';
  dots[1].className = loginStep === 2 ? 'on' : '';
  setTimeout(() => (loginStep === 1 ? $('#login-pw') : $('#login-code')).focus(), 0);
}
function setNeedCode(on) {
  needCode = !!on;
  setLoginStep(1);
}

let loggingIn = false;
async function submitLogin() {
  const pw = $('#login-pw').value;
  if (!pw) { $('#login-err').textContent = '비밀번호를 입력하세요.'; return $('#login-pw').focus(); }
  if (needCode && loginStep === 1) { $('#login-err').textContent = ''; return setLoginStep(2); }
  const code = $('#login-code').value.trim();
  if (needCode && !/^\d{6}$/.test(code)) { $('#login-err').textContent = '6자리 숫자를 입력하세요.'; return $('#login-code').focus(); }
  if (loggingIn) return;
  loggingIn = true;
  $('#login-err').textContent = '';
  try {
    await api('POST', 'api/login', { password: pw, code });
    $('#login-pw').value = '';
    $('#login-code').value = '';
    route();
  } catch (err) {
    $('#login-err').textContent = err.message;
    $('#login-code').value = '';
    // 어느 쪽이 틀렸는지 서버가 알려주지 않으므로 처음부터 다시 입력
    if (err.data && err.data.needCode) { needCode = true; $('#login-pw').value = ''; }
    setLoginStep(1);
  } finally { loggingIn = false; }
}
$('#login-form').addEventListener('submit', (e) => { e.preventDefault(); submitLogin(); });
$('#login-back').addEventListener('click', () => { $('#login-err').textContent = ''; setLoginStep(1); });
// 6자리를 다 입력하면 자동 로그인 (붙여넣기 포함)
$('#login-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) submitLogin();
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
        h('div', { class: 'host-sub', title: `${x.username}@${x.host}:${x.port}` }, `${x.username}@${x.host}${x.port !== 22 ? ':' + x.port : ''}`),
        jump ? h('span', { class: 'badge' }, '경유: ' + jump.name) : null,
        x.command ? h('span', { class: 'badge cmd', title: x.command }, '▶ ' + x.command) : null)),
    h('div', { class: 'host-actions' },
      x.mac ? h('button', { title: 'Wake-on-LAN: 켜고 접속', onclick: () => { location.hash = '#/wake/' + encodeURIComponent(x.id); } }, '켜기') : null,
      h('button', { onclick: () => openEditor(x) }, '편집')));
}

// ── PC 켜기 (WOL → 부팅 대기 → 자동 접속). #/wake 또는 #/wake/<호스트 id> ──
let wakeRun = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setWake(msg, state) {
  $('#wake-msg').textContent = msg;
  $('#wake-icon').className = 'wake-icon' + (state ? ' ' + state : '');
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

async function openWake(id) {
  const run = ++wakeRun;
  showView('wake');
  document.title = 'PC 켜기 — Web SSH';
  $('#wake-choose').hidden = true;
  $('#wake-connect').hidden = true;
  $('#wake-other').hidden = true;
  $('#wake-title').textContent = 'PC 켜기';
  setWake('', '');
  try { hosts = await api('GET', 'api/hosts'); } catch { return; }
  if (run !== wakeRun) return;
  const cands = hosts.filter((x) => x.mac);
  let host = id ? hosts.find((x) => x.id === id) : null;
  if (!host && !id) host = cands.find((x) => x.id === store.get('wakeHost', '')) || (cands.length === 1 ? cands[0] : null);

  if (!host) {
    if (!cands.length) return setWake('WOL MAC 이 설정된 호스트가 없습니다.\n호스트 편집에서 "WOL MAC" 을 입력하세요.', 'err');
    $('#wake-title').textContent = '켤 PC 선택';
    setWake('선택한 PC 는 다음부터 바로 켜집니다.', '');
    $('#wake-choose').replaceChildren(...cands.map((x) => h('button', { type: 'button', class: 'ghost', onclick: () => {
      store.set('wakeHost', x.id);
      location.hash = '#/wake/' + encodeURIComponent(x.id);
    } }, h('b', {}, x.name), h('small', { class: 'muted' }, x.host))));
    $('#wake-choose').hidden = false;
    return;
  }
  $('#wake-title').textContent = host.name;
  $('#wake-other').hidden = cands.length < 2;
  const go = () => { if (run === wakeRun) location.hash = '#/term/' + encodeURIComponent(host.id); };
  $('#wake-connect').onclick = go;

  setWake('상태 확인 중…', 'busy');
  let st = await api('GET', `api/hosts/${host.id}/status`).catch(() => ({}));
  if (run !== wakeRun) return;
  if (st.online) { setWake('이미 켜져 있습니다. 접속합니다…', 'ok'); await sleep(600); return go(); }
  if (!host.mac) return setWake('이 호스트에는 WOL MAC 이 없습니다.', 'err');
  try { await api('POST', `api/hosts/${host.id}/wake`); } catch (e) { return setWake(e.message, 'err'); }
  $('#wake-connect').hidden = false;
  const t0 = Date.now();
  let resent = false;
  // 경과 시간은 1초마다 갱신 (상태 확인과 별개)
  const showWait = () => { if (run === wakeRun) setWake(`켜기 신호를 보냈습니다.\n부팅을 기다리는 중… ${mmss(Date.now() - t0)}`, 'busy'); };
  showWait();
  const ticker = setInterval(() => { if (run !== wakeRun) clearInterval(ticker); else showWait(); }, 1000);
  try {
    while (Date.now() - t0 < 180e3) {
      await sleep(2500);
      if (run !== wakeRun) return;
      st = await api('GET', `api/hosts/${host.id}/status`).catch(() => ({}));
      if (run !== wakeRun) return;
      if (st.online) {
        clearInterval(ticker);
        setWake('켜졌습니다! 접속합니다…', 'ok');
        await sleep(2000); // SSH 서버가 완전히 뜰 시간
        return go();
      }
      // 첫 신호를 놓쳤을 수 있으니 20초 후 한 번 더
      if (!resent && Date.now() - t0 > 20e3) { resent = true; api('POST', `api/hosts/${host.id}/wake`).catch(() => {}); }
    }
  } finally { clearInterval(ticker); }
  if (run !== wakeRun) return;
  setWake('3분 동안 응답이 없습니다.\nBIOS·랜카드의 Wake on LAN 설정과\nWindows "빠른 시작" 끄기를 확인하세요.', 'err');
}
$('#wake-other').addEventListener('click', () => {
  store.set('wakeHost', '');
  if (location.hash === '#/wake') openWake(null); else location.hash = '#/wake';
});

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
  try {
    await api('POST', `api/hosts/${editing.id}/reset-hostkey`);
  } catch (err) { $('#host-err').textContent = err.message; return; }
  editing.hostKey = '';
  $('#hostkey-info').hidden = true;
  toast('호스트 키를 초기화했습니다');
  loadHosts();
});

// ── 보안 설정 ──
const dlgSec = $('#dlg-sec');

// ── 푸시 알림 ──
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let swReg = null;
if (pushSupported) {
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }, (e) => console.warn('SW 등록 실패', e));
}
if ('serviceWorker' in navigator) {
  // 알림 클릭 → 이미 열린 창에서 해당 터미널로 이동
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'navigate' && typeof e.data.url === 'string' && e.data.url.startsWith(location.origin)) location.href = e.data.url;
  });
}
const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
};
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : isIOS ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : 'Linux';
  const br = /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : 'Safari';
  return `${os} · ${br}${isStandalone ? ' (앱)' : ''}`;
}
const myPushId = () => { try { return localStorage.getItem('pushSubId'); } catch { return null; } };
const setMyPushId = (id) => { try { if (id) localStorage.setItem('pushSubId', id); else localStorage.removeItem('pushSubId'); } catch { /* ignore */ } };
async function currentSub() {
  if (!pushSupported) return null;
  const reg = swReg || await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPush() {
  const help = $('#push-help');
  const state = $('#push-state');
  const on = $('#btn-push-on'), off = $('#btn-push-off');
  let info;
  try { info = await api('GET', 'api/push'); } catch (e) { help.textContent = e.message; return; }
  const mine = await currentSub().catch(() => null);
  const mineOnServer = !!mine && info.subs.some((s) => s.id === myPushId());
  if (!window.isSecureContext) help.textContent = '알림은 HTTPS 주소(https://…)로 접속해야 켤 수 있습니다. 지금은 http 접속입니다.';
  else if (isIOS && !isStandalone) help.textContent = 'iPhone/iPad 는 Safari 공유 → "홈 화면에 추가" 후, 그 앱에서 켜야 합니다.';
  else if (!pushSupported) help.textContent = '이 브라우저는 푸시 알림을 지원하지 않습니다.';
  else if (Notification.permission === 'denied') help.textContent = '알림 권한이 차단되어 있습니다. 브라우저 사이트 설정에서 알림을 허용하세요.';
  else help.textContent = 'Claude 작업 완료·입력 대기 등을 이 기기로 알려줍니다.';
  const canOn = pushSupported && Notification.permission !== 'denied' && !(isIOS && !isStandalone);
  state.textContent = mineOnServer ? '이 기기 켜짐' : `${info.subs.length}대 등록`;
  state.classList.toggle('on', !!mineOnServer);
  on.hidden = !canOn || !!mineOnServer;
  off.hidden = !mineOnServer;
  $('#btn-push-test').hidden = !info.subs.length;

  const ul = $('#push-subs');
  ul.textContent = '';
  for (const s of info.subs) {
    ul.append(h('li', {},
      h('span', {}, s.label, ' ', h('small', {}, `· ${new Date(s.created).toLocaleDateString()}`), s.id === myPushId() ? h('small', {}, ' (이 기기)') : null),
      h('button', { type: 'button', class: 'ghost small danger', onclick: async () => {
        await secCall(`api/push/subs/${s.id}`, undefined, 'DELETE');
        if (s.id === myPushId()) { const m = await currentSub().catch(() => null); if (m) await m.unsubscribe(); setMyPushId(null); }
        renderPush();
      } }, '삭제')));
  }

  const sel = $('#push-host');
  const prev = sel.value;
  sel.replaceChildren(h('option', { value: '' }, '알림 클릭 시 열 호스트 (선택)'), ...hosts.map((x) => h('option', { value: x.id }, x.name)));
  sel.value = prev || (hosts.find((x) => /wsl|claude/i.test(x.command || '')) || {}).id || '';
}

let pushBusy = false;
$('#btn-push-on').addEventListener('click', async () => {
  if (pushBusy) return;
  pushBusy = true;
  const btn = $('#btn-push-on');
  btn.disabled = true;
  btn.textContent = '등록 중…';
  $('#sec-err').textContent = '';
  try {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다.');
    const { publicKey } = await api('GET', 'api/push');
    const reg = swReg || await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const r = await api('POST', 'api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel(), replaceId: myPushId() });
    setMyPushId(r.id);
    toast('이 기기에서 알림을 받습니다.');
  } catch (e) { $('#sec-err').textContent = e.message; }
  pushBusy = false;
  btn.disabled = false;
  btn.textContent = '이 기기에서 받기';
  renderPush();
});
$('#btn-push-off').addEventListener('click', async () => {
  const id = myPushId();
  if (id) await secCall(`api/push/subs/${id}`, undefined, 'DELETE');
  const m = await currentSub().catch(() => null);
  if (m) await m.unsubscribe();
  setMyPushId(null);
  renderPush();
});
$('#btn-push-test').addEventListener('click', async () => {
  const r = await secCall('api/push/test');
  if (r) toast(`테스트 알림 전송: ${r.sent}대 성공${r.failed ? `, ${r.failed}대 실패` : ''}${r.removed ? `, 만료 ${r.removed}대 정리` : ''}`, 4000);
});
let setupTimer = null;
$('#btn-push-setup').addEventListener('click', async () => {
  const r = await secCall('api/push/setup', { hostId: $('#push-host').value });
  if (!r) return;
  const url = new URL(`api/notify/setup/${r.code}`, location.href).href;
  $('#push-setup-cmd').textContent = `curl -fsS '${url}' | sh`;
  $('#push-setup-box').hidden = false;
  const until = Date.now() + r.expiresMin * 60e3;
  clearInterval(setupTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    $('#push-setup-exp').textContent = left ? `1회용 · ${Math.floor(left / 60)}분 ${left % 60}초 후 만료 · 실행하면 이전 토큰은 무효` : '만료됨 — 다시 만드세요';
    if (!left) clearInterval(setupTimer);
  };
  tick();
  setupTimer = setInterval(tick, 1000);
});
$('#btn-push-copy').addEventListener('click', () => copyText($('#push-setup-cmd').textContent));

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
  renderPasskeys(s.privateNet);
  renderPush();
  if (!dlgSec.open) dlgSec.showModal();
}

const secCall = async (url, body, method = 'POST') => {
  $('#sec-err').textContent = '';
  try { return await api(method, url, body); } catch (e) { $('#sec-err').textContent = e.message; return null; }
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
// 접속이 실패/종료되면 남아 있는 질문 창을 닫는다 (서버로는 보내지 않음)
function dismissAsk() {
  if (askResolve) askResolve(false);
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
  term.onData((d) => { markActive(); sendInput(applyMods(d)); });
  term.onResize(({ cols, rows }) => wsSend({ t: 'resize', cols, rows }));
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true;
    if (ev.code === 'KeyC') { copyText(term.getSelection()); return false; }
    if (ev.code === 'KeyV') return false; // 브라우저 기본 붙여넣기
    return true;
  });
  new ResizeObserver(scheduleFit).observe($('#term-wrap'));
  setupTouchScroll($('#term'));
}

// ── 모바일 터치 스크롤 ──
// 일반 셸: 터미널 스크롤 기록을 움직인다.
// 전체 화면 프로그램(tmux·vim·less 등): 마우스 모드면 휠 신호(SGR), 아니면 ↑↓ 키를 보낸다.
//   tmux 는 `set -g mouse on` 이어야 휠로 기록을 스크롤한다.
function setupTouchScroll(el) {
  let lastY = null;
  let acc = 0;
  let scrolling = false;
  const lineHeight = () => {
    const cell = term._core && term._core._renderService && term._core._renderService.dimensions;
    return (cell && cell.css && cell.css.cell && cell.css.cell.height) || term.options.fontSize * 1.2;
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
    acc = 0;
    scrolling = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (lastY == null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    acc += lastY - y; // 손가락을 위로 → 양수 → 아래 내용(최신 쪽)으로
    lastY = y;
    const lh = lineHeight();
    if (!scrolling && Math.abs(acc) < lh * 0.6) return; // 탭(키보드 열기)과 구분
    scrolling = true;
    e.preventDefault();
    const n = Math.trunc(acc / lh);
    if (!n) return;
    acc -= n * lh;
    scrollTerm(n);
  }, { passive: false });
  el.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  el.addEventListener('touchcancel', () => { lastY = null; }, { passive: true });
}

function scrollTerm(n) {
  if (term.buffer.active.type === 'normal') { term.scrollLines(n); return; }
  const count = Math.min(Math.abs(n), 15);
  let seq;
  if (term.modes.mouseTrackingMode !== 'none') {
    const col = Math.max(1, Math.floor(term.cols / 2));
    const row = Math.max(1, Math.floor(term.rows / 2));
    seq = `\x1b[<${n < 0 ? 64 : 65};${col};${row}M`; // SGR 휠 위(64)/아래(65)
  } else {
    const app = term.modes.applicationCursorKeysMode;
    seq = n < 0 ? (app ? '\x1bOA' : '\x1b[A') : (app ? '\x1bOB' : '\x1b[B');
  }
  sendInput(seq.repeat(count));
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
  if (term && !$('#view-term').hidden) term.focus();
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

function setStatus(s, kind = '') {
  const el = $('#term-status');
  el.textContent = s;
  el.className = kind; // ok | err | busy
}
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
  setStatus('연결 중...', 'busy');
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
      case 'status': setStatus(m.msg, 'busy'); term.write(`\x1b[38;5;245m${m.msg}\x1b[0m\r\n`); break;
      case 'ask': {
        const value = await askDialog(m);
        // 기다리는 동안 접속이 끝났으면(오류/종료/화면 이탈) 보내지 않는다
        if (sock === ws && !gotEnd && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'answer', id: m.id, value }));
        break;
      }
      case 'ready': setStatus('연결됨', 'ok'); scheduleFit(); term.focus(); break;
      case 'error': gotEnd = true; dismissAsk(); setStatus('오류', 'err'); showOverlay(m.msg); break;
      case 'closed': gotEnd = true; dismissAsk(); setStatus('종료됨', 'err'); showOverlay('연결이 종료되었습니다.'); break;
    }
  };
  sock.onclose = () => {
    if (sock !== ws) return;
    dismissAsk();
    if (!gotEnd) { setStatus('끊김', 'err'); showOverlay('서버와의 연결이 끊어졌습니다.'); }
  };
}

function disconnect() {
  dismissAsk();
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
  { l: '^B', s: '\x02', title: 'tmux 접두키 (Ctrl+B)' }, { l: '^C', s: '\x03' }, { l: '^D', s: '\x04' }, { l: '^Z', s: '\x1a' }, { l: '^R', s: '\x12' }, { l: '^L', s: '\x0c' },
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
    const b = h('button', { type: 'button', tabindex: '-1', title: k.title }, k.l);
    if (k.mod) modBtns[k.mod] = b;
    let timer = null;
    let repeated = false;
    let startX = 0;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    const fire = () => {
      if (k.mod) { mods[k.mod] = (mods[k.mod] + 1) % 3; renderMods(); return; }
      const seq = k.f ? k.f() : k.s != null ? k.s : k.l;
      // 일반 문자는 Ctrl/Alt 수식을 적용, 제어 시퀀스는 그대로
      sendInput(k.s == null && !k.f ? applyMods(seq) : seq);
    };
    // pointerdown + preventDefault: 터미널 포커스(모바일 키보드)를 유지 (click 이벤트는 그대로 발생)
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      repeated = false;
      startX = e.clientX;
      if (k.rep) timer = setTimeout(() => { repeated = true; fire(); timer = setInterval(fire, 60); }, 400);
    });
    // 입력은 click 에서: 브라우저가 "탭"으로 판정한 경우에만 발생한다.
    // (pointerup 으로 보내면 손가락이 살짝만 움직여도 키 바 가로 스크롤이 pointercancel 을 일으켜 입력이 씹힘)
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (repeated) { repeated = false; return; } // 길게 눌러 반복 입력한 경우는 이미 보냄
      fire();
    });
    b.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - startX) > 10) stop(); });
    b.addEventListener('pointerup', stop);
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
  wakeRun++; // 켜기 화면을 벗어나면 대기 중단
  const w = location.hash.match(/^#\/wake(?:\/(.+))?$/);
  if (w) { clearInterval(statusTimer); disconnect(); openWake(w[1] ? decodeURIComponent(w[1]) : null); return; }
  disconnect();
  document.title = 'Web SSH';
  showView('list');
  loadHosts().catch(() => {});
  clearInterval(statusTimer);
  statusTimer = setInterval(() => { if (!$('#view-list').hidden) refreshStatus(); }, 15000);
}
// ── 활동 중이면 로그인 연장 ──
// 서버는 API 요청이 올 때 만료를 뒤로 민다. 터미널만 쓰는 동안은 API 요청이 없으므로,
// 최근에 사용자가 실제로 조작했을 때만 가볍게 핑을 보낸다 (방치된 탭은 연장하지 않음).
let lastActivity = Date.now();
let lastPing = Date.now();
const markActive = () => { lastActivity = Date.now(); };
for (const evName of ['keydown', 'pointerdown', 'touchstart', 'wheel']) window.addEventListener(evName, markActive, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markActive(); keepAlive(); } });
async function keepAlive() {
  if (!$('#view-login').hidden || lastActivity <= lastPing) return;
  lastPing = Date.now();
  try {
    const r = await api('GET', 'api/me');
    if (!r.authed) { disconnect(); showView('login'); toast('오래 사용하지 않아 로그아웃되었습니다.', 4000); }
  } catch { /* 네트워크 오류는 무시 */ }
}
setInterval(keepAlive, 60 * 1000);

function checkAuth() {
  return api('GET', 'api/me').then((r) => {
    setNeedCode(r.needCode);
    if (r.passkey) pkInfo = r.passkey;
    $('#login-pk-box').hidden = !(pkSupported && pkInfo.count > 0 && pkOriginOk());
    if (r.authed) route(); else showView('login');
  }, () => showView('login'));
}
window.addEventListener('hashchange', checkAuth);
checkAuth();
