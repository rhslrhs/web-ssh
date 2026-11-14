'use strict';
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('./config');
const totp = require('./totp');
const { seal, open, isLegacy } = require('./seal');
const { readJson, writeJsonAtomic } = require('./jsonfile');
const passkey = require('./passkey');
const { normalize, isPrivate, isLoopback } = require('./netpolicy');

const COOKIE = 'wssh';
// 'invalidate': 세션 버전이 바뀜(전체 로그아웃·OTP 변경) → 열린 터미널(WebSocket)을 끊어야 함
const events = new EventEmitter();
const MAX_FAIL = 5;               // IP 당 연속 실패 허용
const LOCK_MS = 5 * 60 * 1000;    // IP 잠금 시간
const PUB_WINDOW_MS = 15 * 60 * 1000;
const PUB_MAX_FAIL = 30;          // 외부 전체 실패 한도 (분산 공격 대비)

// ── 인증 상태 (OTP 비밀키, 세션 버전) : data/auth.json ──
const FILE = path.join(config.DATA_DIR, 'auth.json');
let state = { ver: 1, totp: null, totpLast: 0 };
state = { ...state, ...readJson(FILE, {}) };
const saveState = () => writeJsonAtomic(FILE, state);
function bumpVersion() {
  state.ver++;
  saveState();
  events.emit('invalidate');
}

// OTP 비밀키는 "auth:totp" 라벨로 봉인 (lib/seal.js). 기존(v1) 데이터는 로드 시 변환.
const TOTP_LABEL = 'auth:totp';
if (isLegacy(state.totp)) {
  try { state.totp = seal(open(state.totp), TOTP_LABEL); saveState(); console.log('[web-ssh] OTP 비밀키를 v2 형식으로 변환했습니다'); } catch (e) {
    console.warn('[web-ssh] OTP 비밀키 변환 실패: ' + e.message);
  }
}
const totpSecret = () => (state.totp ? open(state.totp, TOTP_LABEL) : null);
const totpEnabled = () => !!state.totp;

// ── 세션 토큰: exp.HMAC  (세션 버전이 바뀌면 전부 무효) ──
const sessionKey = () => crypto.createHmac('sha256', config.macKey).update('v' + state.ver).digest();
const sign = (p) => crypto.createHmac('sha256', sessionKey()).update(p).digest('base64url');

// 토큰 = "exp.iat.서명". exp = 마지막 활동 + 유휴 시간(연장됨), iat = 최초 로그인 시각(최대 기간 기준)
const IDLE_MS = config.SESSION_IDLE_MIN * 60e3;
const MAX_MS = config.SESSION_MAX_HOURS * 3600e3;
// 일정 시간 지난 토큰만 다시 발급 (요청마다 쿠키를 새로 쓰지 않도록). 유휴 시간이 짧으면 그 1/3
const RENEW_AFTER_MS = Math.min(60e3, IDLE_MS / 3);

function issueToken(iat = Date.now()) {
  const exp = Math.min(Date.now() + IDLE_MS, iat + MAX_MS);
  const p = `${exp}.${iat}`;
  return { token: p + '.' + sign(p), exp };
}
// 유효하면 { exp, iat }, 아니면 null
function verifyToken(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const p = parts[0] + '.' + parts[1];
  const s = Buffer.from(parts[2]);
  const e = Buffer.from(sign(p));
  if (s.length !== e.length || !crypto.timingSafeEqual(s, e)) return null;
  const exp = Number(parts[0]);
  const iat = Number(parts[1]);
  const now = Date.now();
  if (!(exp > now) || !(iat + MAX_MS > now)) return null;
  return { exp, iat };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  }
  return out;
}
const session = (req) => verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
const isAuthed = (req) => !!session(req);
// WebSocket(터미널)은 연결할 때 한 번만 쿠키를 보므로, 연결마다 이 값을 들고 있다가 주기적으로 확인한다
function wsSession(req) {
  const s = session(req);
  return s ? { iat: s.iat, ver: state.ver } : null;
}
// 전체 로그아웃(버전 변경) / 최대 기간 초과 / 사용자 조작 없이 유휴 시간 초과 → 끊어야 함
function wsSessionProblem(ws, now = Date.now()) {
  if (!ws.sess || ws.sess.ver !== state.ver) return '다른 곳에서 전체 로그아웃(또는 보안 설정 변경)되어 연결을 닫았습니다.';
  if (ws.sess.iat + MAX_MS <= now) return '로그인 유지 기간이 지나 연결을 닫았습니다. 다시 로그인하세요.';
  if (now - ws.lastActive >= IDLE_MS) return '오래 사용하지 않아 연결을 닫았습니다. 다시 로그인하세요.';
  return null;
}

// 실제 접속자 IP.
// DSM(nginx) 리버스 프록시는 X-Real-IP 를 $remote_addr 로 "덮어쓰므로" 신뢰 가능하지만,
// X-Forwarded-For 는 설정하지 않아 클라이언트가 보낸 값이 그대로 통과한다 → 절대 쓰지 않는다.
// 또한 프록시(루프백)에서 온 요청일 때만 헤더를 믿는다.
//
// 루프백에서 온 요청은 "같은 장비의 프록시를 거친 외부 요청"일 수 있으므로, 출처를 확신할 수 없으면
// 내부망으로 보지 않는다 (fail-closed). 이때는 UNKNOWN_IP 를 돌려주며, 이는 사설 IP 가 아니므로
// 외부 접속 규칙(PUBLIC_ACCESS · 허용 목록 · OTP 필수)이 적용된다.
//   - TRUST_PROXY=1 인데 X-Real-IP 가 없거나 IP 형식이 아님 (cloudflared·Caddy 등 헤더를 안 넣는 프록시)
//   - TRUST_PROXY=0 인데 프록시 헤더가 붙어 있거나 PUBLIC_ORIGIN 주소로 들어옴 (프록시 뒤인데 설정 누락)
const UNKNOWN_IP = 'unknown';
const PROXY_HEADERS = ['x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'via'];
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn('[web-ssh] ' + msg); } };
const hasProxyHeaders = (req) => PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
const isTrustedProxy = (ip) => isLoopback(ip) || !!(config.trustedProxy && config.trustedProxy(ip));
function clientIp(req) {
  const peer = normalize(req.socket.remoteAddress);
  if (!isTrustedProxy(peer)) {
    // 신뢰하지 않는 사설 IP 가 프록시 헤더를 달고 왔거나 공개 주소로 들어옴 → 다른 장비의 프록시 뒤인데
    // TRUSTED_PROXIES 설정이 빠진 경우. 프록시 주소(사설 IP)를 그대로 쓰면 외부 요청이 전부 내부망으로 보이므로 fail-closed.
    if (isPrivate(peer) && (hasProxyHeaders(req) || viaPublicOrigin(req))) {
      warnOnce('proxy-remote:' + peer, `${peer} 에서 프록시 헤더가 붙은 요청이 들어왔습니다. 외부 접속으로 취급합니다. 이 장비가 리버스 프록시라면 TRUSTED_PROXIES=${peer} 로 설정하세요.`);
      return UNKNOWN_IP;
    }
    return peer;
  }
  if (config.TRUST_PROXY) {
    const real = normalize(String(req.headers['x-real-ip'] || '').trim());
    if (net.isIP(real)) return real;
    warnOnce('no-real-ip', '프록시 요청에 X-Real-IP 가 없어 외부 접속으로 취급합니다. 리버스 프록시가 X-Real-IP 를 실제 접속 IP 로 넣도록 설정하세요.');
    return UNKNOWN_IP;
  }
  if (hasProxyHeaders(req) || viaPublicOrigin(req)) {
    warnOnce('proxy-untrusted', '루프백으로 프록시 헤더가 붙은 요청이 들어왔지만 TRUST_PROXY=0 입니다. 외부 접속으로 취급합니다. 같은 장비의 리버스 프록시 뒤라면 TRUST_PROXY=1 로 설정하세요.');
    return UNKNOWN_IP;
  }
  return peer;
}
const isPrivateReq = (req) => isPrivate(clientIp(req));

// 외부 접속 허용 여부 (모든 요청 / WebSocket 에 적용)
function networkAllowed(req) {
  const ip = clientIp(req);
  if (isPrivate(ip)) return true;
  if (!config.PUBLIC_ACCESS) return false;
  return config.allowPublic ? config.allowPublic(ip) : true;
}

// 브라우저가 보낸 Origin 이 이 서버(또는 PUBLIC_ORIGIN)와 같은지 (CSRF / 크로스사이트 WebSocket 방지)
function sameOrigin(req, required) {
  const o = req.headers.origin;
  if (!o) return !required;
  if (config.PUBLIC_ORIGIN && o === config.PUBLIC_ORIGIN) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// DNS 리바인딩 방지: 공격자 도메인이 이 서버의 내부 IP 로 바뀌어 들어오면 Origin 과 Host 가
// 둘 다 공격자 도메인이라 sameOrigin 을 통과한다 → Host 를 알려진 이름으로만 허용한다.
// 허용: IP 주소, localhost, 점 없는 장비 이름(예: mynas), .local/.lan/.home.arpa/.internal,
//       PUBLIC_ORIGIN · PASSKEY_ORIGINS 의 도메인, ALLOWED_HOSTS (쉼표 구분, ".example.com" 은 하위 도메인 포함, "*" 는 검사 끔)
const LOCAL_SUFFIX = /\.(local|lan|home\.arpa|internal|localdomain)$/;
const allowedHostNames = (() => {
  const out = new Set();
  for (const o of [config.PUBLIC_ORIGIN, ...String(process.env.PASSKEY_ORIGINS || '').split(',')]) {
    try { if (o.trim()) out.add(new URL(o.trim()).hostname.toLowerCase()); } catch { /* 무시 */ }
  }
  return out;
})();
const extraHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase().replace(/^\*\./, '.')).filter(Boolean);
function hostAllowed(req) {
  if (extraHosts.includes('*')) return true;
  let hn;
  try { hn = new URL('http://' + String(req.headers.host || '')).hostname.toLowerCase(); } catch { return false; }
  if (!hn) return false;
  hn = hn.replace(/\.$/, '');
  if (hn.startsWith('[') || net.isIPv4(hn)) return true;
  if (hn === 'localhost' || !hn.includes('.') || LOCAL_SUFFIX.test(hn)) return true;
  if (allowedHostNames.has(hn)) return true;
  if (extraHosts.some((h) => (h.startsWith('.') ? hn.endsWith(h) || hn === h.slice(1) : hn === h))) return true;
  warnOnce('host:' + hn, `알 수 없는 Host "${hn}" 요청을 거부했습니다 (DNS 리바인딩 방지). 이 주소로 접속하는 것이 맞다면 ALLOWED_HOSTS 에 추가하세요.`);
  return false;
}

function checkPassword(pw) {
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(config.APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// 요청이 PUBLIC_ORIGIN(예: https://ws.example.com) 으로 들어온 것인가 — 프록시가 X-Forwarded-Proto 를 안 줘도 판단
function viaPublicOrigin(req) {
  if (!config.PUBLIC_ORIGIN) return false;
  try { return new URL(config.PUBLIC_ORIGIN).host === req.headers.host; } catch { return false; }
}
function setCookie(req, res, token, maxAge) {
  const secure = req.secure || (viaPublicOrigin(req) && config.PUBLIC_ORIGIN.startsWith('https:')) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}
function issueCookie(req, res, iat) {
  const { token, exp } = issueToken(iat);
  setCookie(req, res, token, Math.max(1, Math.ceil((exp - Date.now()) / 1000)));
}
// 활동이 있으면 만료 시각을 뒤로 민다 (최대 기간은 넘지 않음)
function renew(req, res, sess) {
  if (Date.now() + IDLE_MS - sess.exp >= RENEW_AFTER_MS && sess.exp < sess.iat + MAX_MS) issueCookie(req, res, sess.iat);
}

// ── 로그인 시도 제한 ──
const FAIL_RESET_MS = 15 * 60 * 1000; // 마지막 실패 후 이 시간이 지나면 횟수 초기화
const failures = new Map(); // ip -> { count, until, last }
let pubFails = [];          // 외부 실패 시각들

// 만료된 기록 제거: 잠금이 풀렸거나, 잠기지 않은 채 오래된 기록
function expired(f, now) {
  return f.until ? f.until <= now : now - f.last >= FAIL_RESET_MS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of failures) if (expired(f, now)) failures.delete(ip);
  pubFails = pubFails.filter((t) => now - t < PUB_WINDOW_MS);
}, 60 * 1000).unref();

function lockedMessage(ip, pub) {
  const now = Date.now();
  const f = failures.get(ip);
  if (f && expired(f, now)) failures.delete(ip);
  const g = failures.get(ip);
  if (g && g.until) return `로그인 시도가 너무 많습니다. ${Math.ceil((g.until - now) / 60000)}분 후 다시 시도하세요.`;
  if (pub) {
    pubFails = pubFails.filter((t) => now - t < PUB_WINDOW_MS);
    if (pubFails.length >= PUB_MAX_FAIL) return '외부 로그인 실패가 너무 많아 잠시 차단되었습니다. 내부망/VPN 에서는 계속 사용할 수 있습니다.';
  }
  return null;
}
function recordFailure(ip, pub, why) {
  const now = Date.now();
  const f = failures.get(ip);
  const count = (f && !expired(f, now) ? f.count : 0) + 1;
  failures.set(ip, { count, until: count >= MAX_FAIL ? now + LOCK_MS : 0, last: now });
  if (pub) pubFails.push(Date.now());
  console.warn(`[web-ssh] 로그인 실패 ${ip} (${why}, ${count}회)`);
}

function login(req, res) {
  const ip = clientIp(req);
  const pub = !isPrivate(ip);
  const locked = lockedMessage(ip, pub);
  if (locked) return res.status(429).json({ error: locked });

  const body = req.body || {};
  if (pub && !totpEnabled()) {
    return res.status(403).json({ error: '외부 접속은 2단계 인증(OTP)을 설정한 뒤에 가능합니다. 내부망/VPN 에서 로그인해 상단 ⚙ 설정에서 켜세요.' });
  }
  // 비밀번호와 OTP 를 함께 검사하고, 어느 쪽이 틀렸는지 알려주지 않는다 (비밀번호만 따로 추측 못 하게)
  const pwOk = checkPassword(body.password || '');
  if (totpEnabled()) {
    const counter = totp.verify(totpSecret(), body.code, state.totpLast);
    if (!pwOk || counter == null) {
      recordFailure(ip, pub, pwOk ? 'OTP' : '비밀번호');
      return res.status(401).json({ error: '비밀번호 또는 OTP 코드가 틀렸습니다.', needCode: true });
    }
    state.totpLast = counter;
    saveState();
  } else if (!pwOk) {
    recordFailure(ip, pub, '비밀번호');
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  failures.delete(ip);
  console.log(`[web-ssh] 로그인 ${ip}${pub ? ' (외부)' : ''}`);
  issueCookie(req, res);
  res.json({ ok: true });
}

// 패스키 로그인: 사용자 확인(지문·Face ID·PIN)까지 포함된 서명이므로 비밀번호·OTP 없이 로그인
async function loginPasskey(req, res) {
  const ip = clientIp(req);
  const pub = !isPrivate(ip);
  const locked = lockedMessage(ip, pub);
  if (locked) return res.status(429).json({ error: locked });
  try {
    const c = await passkey.verifyLogin(req, (req.body || {}).response);
    failures.delete(ip);
    console.log(`[web-ssh] 패스키 로그인 ${ip}${pub ? ' (외부)' : ''} — ${c.label}`);
    issueCookie(req, res);
    res.json({ ok: true });
  } catch (e) {
    if (!(e instanceof passkey.PasskeyError)) return res.status(500).json({ error: e.message });
    recordFailure(ip, pub, '패스키');
    res.status(401).json({ error: e.message });
  }
}

function logout(req, res) {
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

function me(req, res) {
  const sess = session(req);
  if (sess) renew(req, res, sess);
  res.json({ authed: !!sess, needCode: totpEnabled(), idleMin: config.SESSION_IDLE_MIN, passkey: { count: passkey.count(), origins: passkey.origins() } });
}

function requireAuth(req, res, next) {
  const sess = session(req);
  if (!sess) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (req.method !== 'GET' && !sameOrigin(req, false)) return res.status(403).json({ error: '잘못된 요청 출처' });
  // 화면이 주기적으로 부르는 백그라운드 요청(상태 조회 등)은 활동이 아니므로 연장하지 않는다
  if (!req.skipRenew) renew(req, res, sess);
  next();
}

// ── 보안 설정 (OTP 등록/해제, 전체 로그아웃) — 내부망/VPN 에서만 ──
let pending = null; // { secret, until }

function requirePrivate(req, res, next) {
  if (!isPrivateReq(req)) return res.status(403).json({ error: '보안 설정은 내부망/VPN 에서만 변경할 수 있습니다.' });
  next();
}

function securityInfo(req, res) {
  res.json({
    totp: totpEnabled(),
    privateNet: isPrivateReq(req),
    publicAccess: config.PUBLIC_ACCESS,
    allowList: !!config.allowPublic,
    ip: clientIp(req),
  });
}

async function totpStart(req, res) {
  if (totpEnabled()) return res.status(400).json({ error: '이미 설정되어 있습니다. 먼저 해제하세요.' });
  const secret = totp.generateSecret();
  pending = { secret, until: Date.now() + 10 * 60 * 1000 };
  const uri = totp.otpauthUri(secret, 'web-ssh', 'Web SSH');
  const svg = await require('qrcode').toString(uri, { type: 'svg', margin: 1 });
  res.json({ secret, uri, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') });
}

function totpEnable(req, res) {
  if (!pending || pending.until < Date.now()) return res.status(400).json({ error: '설정 시간이 지났습니다. 다시 시작하세요.' });
  const counter = totp.verify(pending.secret, (req.body || {}).code, 0);
  if (counter == null) return res.status(400).json({ error: '코드가 맞지 않습니다. 휴대폰 시간이 정확한지 확인하세요.' });
  state.totp = seal(pending.secret, TOTP_LABEL);
  state.totpLast = counter;
  pending = null;
  bumpVersion(); // 다른 기기 세션 무효화 (저장 포함)
  console.log('[web-ssh] 2단계 인증 설정됨');
  issueCookie(req, res);
  res.json({ ok: true });
}

function totpDisable(req, res) {
  if (!totpEnabled()) return res.json({ ok: true });
  const counter = totp.verify(totpSecret(), (req.body || {}).code, state.totpLast);
  if (counter == null) return res.status(400).json({ error: 'OTP 코드가 맞지 않습니다.' });
  state.totp = null;
  state.totpLast = 0;
  bumpVersion();
  console.log('[web-ssh] 2단계 인증 해제됨');
  issueCookie(req, res);
  res.json({ ok: true });
}

function logoutAll(req, res) {
  bumpVersion();
  console.log('[web-ssh] 모든 세션 로그아웃');
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

module.exports = {
  login, loginPasskey, logout, me, requireAuth, requirePrivate, isAuthed, sameOrigin, hostAllowed, clientIp, networkAllowed,
  securityInfo, totpStart, totpEnable, totpDisable, logoutAll,
  events, wsSession, wsSessionProblem, viaPublicOrigin, IDLE_MS,
};
