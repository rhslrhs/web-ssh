'use strict';
// 패스키(WebAuthn): 지문·Face ID 등으로 로그인. 사용자 확인(UV)을 필수로 요구하므로
// 패스키 하나가 "기기 소유 + 생체/PIN" 2요소 역할을 한다 → 비밀번호·OTP 없이 로그인 허용.
const path = require('path');
const crypto = require('crypto');
// simplewebauthn 은 전역 WebCrypto(globalThis.crypto)를 쓴다. Node 18 에는 기본으로 없으므로 연결.
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
const sw = require('@simplewebauthn/server');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./jsonfile');

const FILE = path.join(config.DATA_DIR, 'passkeys.json');
let db = readJson(FILE, { userId: null, creds: [] });
if (!db.userId) { db.userId = crypto.randomBytes(16).toString('base64url'); writeJsonAtomic(FILE, db); }
const save = () => writeJsonAtomic(FILE, db);

class PasskeyError extends Error {}
const b64 = (u8) => Buffer.from(u8).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

// WebAuthn 은 브라우저 주소(origin)와 도메인(rpID)에 묶인다.
// 허용: PUBLIC_ORIGIN(예: https://ssh.example.synology.me), localhost(개발), PASSKEY_ORIGINS(추가)
function allowedOrigins() {
  const list = [config.PUBLIC_ORIGIN, ...String(process.env.PASSKEY_ORIGINS || '').split(',')];
  return list.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function rpFor(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  let u;
  try { u = new URL(origin); } catch { throw new PasskeyError('요청 출처를 확인할 수 없습니다'); }
  const ok = allowedOrigins().includes(origin) || u.hostname === 'localhost';
  if (!ok) throw new PasskeyError(`패스키는 ${config.PUBLIC_ORIGIN || 'HTTPS 도메인(PUBLIC_ORIGIN)'} 주소로 접속했을 때만 사용할 수 있습니다`);
  return { origin, rpID: u.hostname };
}

// 1회용 챌린지 (5분). 로그인 옵션은 인증 없이 요청되므로 개수 제한.
const challenges = new Map(); // challenge -> { kind, rpID, until }
function newChallenge(kind, rpID, challenge) {
  const now = Date.now();
  for (const [c, v] of challenges) if (v.until < now) challenges.delete(c);
  if (challenges.size > 200) challenges.delete(challenges.keys().next().value);
  challenges.set(challenge, { kind, rpID, until: now + 5 * 60e3 });
}
const consume = (kind, rpID) => (c) => {
  const v = challenges.get(c);
  challenges.delete(c);
  return !!v && v.kind === kind && v.rpID === rpID && v.until >= Date.now();
};

const view = (c) => ({ id: c.id, label: c.label, created: c.created, lastUsed: c.lastUsed || null, rpID: c.rpID });

async function registrationOptions(req) {
  const { rpID } = rpFor(req);
  const opts = await sw.generateRegistrationOptions({
    rpName: 'Web SSH',
    rpID,
    userName: 'web-ssh',
    userDisplayName: 'Web SSH',
    userID: unb64(db.userId),
    attestationType: 'none',
    excludeCredentials: db.creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  });
  newChallenge('reg', rpID, opts.challenge);
  return opts;
}

async function register(req, response, label) {
  const { origin, rpID } = rpFor(req);
  let v;
  try {
    v = await sw.verifyRegistrationResponse({ response, expectedChallenge: consume('reg', rpID), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (e) { throw new PasskeyError('패스키 등록 확인 실패: ' + e.message); }
  if (!v.verified) throw new PasskeyError('패스키 등록 확인 실패');
  const cred = v.registrationInfo.credential;
  if (db.creds.some((c) => c.id === cred.id)) throw new PasskeyError('이미 등록된 패스키입니다');
  if (db.creds.length >= 20) throw new PasskeyError('패스키는 최대 20개까지 등록할 수 있습니다');
  const c = {
    id: cred.id, publicKey: b64(cred.publicKey), counter: cred.counter, transports: cred.transports || [],
    rpID, label: String(label || '패스키').slice(0, 60), created: Date.now(), lastUsed: null,
  };
  db.creds.push(c);
  save();
  return view(c);
}

async function loginOptions(req) {
  const { rpID } = rpFor(req);
  // 빈 allowCredentials → 기기에 저장된(discoverable) 패스키 중에서 고르게 함
  const opts = await sw.generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  newChallenge('auth', rpID, opts.challenge);
  return opts;
}

// 성공 시 credential view, 실패 시 PasskeyError
async function verifyLogin(req, response) {
  const { origin, rpID } = rpFor(req);
  const c = response && db.creds.find((x) => x.id === response.id && x.rpID === rpID);
  if (!c) throw new PasskeyError('등록되지 않은 패스키입니다');
  let v;
  try {
    v = await sw.verifyAuthenticationResponse({
      response, expectedChallenge: consume('auth', rpID), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: c.id, publicKey: unb64(c.publicKey), counter: c.counter, transports: c.transports },
    });
  } catch (e) { throw new PasskeyError('패스키 확인 실패: ' + e.message); }
  if (!v.verified) throw new PasskeyError('패스키 확인 실패');
  c.counter = v.authenticationInfo.newCounter;
  c.lastUsed = Date.now();
  save();
  return view(c);
}

function remove(id) {
  const n = db.creds.length;
  db.creds = db.creds.filter((c) => c.id !== id);
  if (db.creds.length !== n) save();
  return db.creds.length !== n;
}

module.exports = {
  PasskeyError, registrationOptions, register, loginOptions, verifyLogin, remove,
  list: () => db.creds.map(view),
  count: () => db.creds.length,
  origins: allowedOrigins,
};
