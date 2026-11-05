'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const totp = require('./totp');
const { normalize, isPrivate, isLoopback } = require('./netpolicy');

const COOKIE = 'wssh';
const MAX_FAIL = 5;               // IP 당 연속 실패 허용
const LOCK_MS = 5 * 60 * 1000;    // IP 잠금 시간
const PUB_WINDOW_MS = 15 * 60 * 1000;
const PUB_MAX_FAIL = 30;          // 외부 전체 실패 한도 (분산 공격 대비)

// ── 인증 상태 (OTP 비밀키, 세션 버전) : data/auth.json ──
const FILE = path.join(config.DATA_DIR, 'auth.json');
let state = { ver: 1, totp: null, totpLast: 0 };
if (fs.existsSync(FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
function saveState() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(e) {
  const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}
const totpSecret = () => (state.totp ? decrypt(state.totp) : null);
const totpEnabled = () => !!state.totp;

// ── 세션 토큰: exp.HMAC  (세션 버전이 바뀌면 전부 무효) ──
const sessionKey = () => crypto.createHmac('sha256', config.macKey).update('v' + state.ver).digest();
const sign = (p) => crypto.createHmac('sha256', sessionKey()).update(p).digest('base64url');

function issueToken() {
  const p = String(Date.now() + config.SESSION_HOURS * 3600e3);
  return p + '.' + sign(p);
}
function verifyToken(tok) {
  if (typeof tok !== 'string') return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const p = tok.slice(0, i);
  const s = Buffer.from(tok.slice(i + 1));
  const e = Buffer.from(sign(p));
  return s.length === e.length && crypto.timingSafeEqual(s, e) && Number(p) > Date.now();
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
const isAuthed = (req) => verifyToken(parseCookies(req.headers.cookie)[COOKIE]);

// 실제 접속자 IP.
// DSM(nginx) 리버스 프록시는 X-Real-IP 를 $remote_addr 로 "덮어쓰므로" 신뢰 가능하지만,
// X-Forwarded-For 는 설정하지 않아 클라이언트가 보낸 값이 그대로 통과한다 → 절대 쓰지 않는다.
// 또한 프록시(루프백)에서 온 요청일 때만 헤더를 믿는다.
function clientIp(req) {
  const peer = normalize(req.socket.remoteAddress);
  if (config.TRUST_PROXY && isLoopback(peer)) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return normalize(real);
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

function checkPassword(pw) {
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(config.APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function setCookie(req, res, token, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}
const issueCookie = (req, res) => setCookie(req, res, issueToken(), config.SESSION_HOURS * 3600);

// ── 로그인 시도 제한 ──
const failures = new Map(); // ip -> { count, until }
let pubFails = [];          // 외부 실패 시각들

function lockedMessage(ip, pub) {
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.until && f.until <= now) failures.delete(ip);
  const g = failures.get(ip);
  if (g && g.until) return `로그인 시도가 너무 많습니다. ${Math.ceil((g.until - now) / 60000)}분 후 다시 시도하세요.`;
  if (pub) {
    pubFails = pubFails.filter((t) => now - t < PUB_WINDOW_MS);
    if (pubFails.length >= PUB_MAX_FAIL) return '외부 로그인 실패가 너무 많아 잠시 차단되었습니다. 내부망/VPN 에서는 계속 사용할 수 있습니다.';
  }
  return null;
}
function recordFailure(ip, pub, why) {
  const f = failures.get(ip);
  const count = ((f && f.count) || 0) + 1;
  failures.set(ip, { count, until: count >= MAX_FAIL ? Date.now() + LOCK_MS : 0 });
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
    return res.status(403).json({ error: '외부 접속은 2단계 인증(OTP)을 설정한 뒤에 가능합니다. 내부망/VPN 에서 로그인해 "보안"에서 설정하세요.' });
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

function logout(req, res) {
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ authed: isAuthed(req), needCode: totpEnabled() });
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (req.method !== 'GET' && !sameOrigin(req, false)) return res.status(403).json({ error: '잘못된 요청 출처' });
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
  state.totp = encrypt(pending.secret);
  state.totpLast = counter;
  state.ver++; // 다른 기기 세션 무효화
  pending = null;
  saveState();
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
  state.ver++;
  saveState();
  console.log('[web-ssh] 2단계 인증 해제됨');
  issueCookie(req, res);
  res.json({ ok: true });
}

function logoutAll(req, res) {
  state.ver++;
  saveState();
  console.log('[web-ssh] 모든 세션 로그아웃');
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

module.exports = {
  login, logout, me, requireAuth, requirePrivate, isAuthed, sameOrigin, clientIp, networkAllowed,
  securityInfo, totpStart, totpEnable, totpDisable, logoutAll,
};
