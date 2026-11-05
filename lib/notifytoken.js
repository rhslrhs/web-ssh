'use strict';
// 알림 전용 토큰 — Claude Code 훅 등 외부 스크립트가 /api/notify 로 푸시를 보낼 때 사용.
// 이 토큰으로는 로그인·SSH 접속을 할 수 없다. 파일에는 해시만 저장한다.
// 여러 PC 에 설치할 수 있도록 토큰을 여러 개(id·해시·이름) 두고, 설정 화면에서 하나씩 삭제한다.
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./jsonfile');

const FILE = path.join(config.DATA_DIR, 'notify-token.json');
const MAX_TOKENS = 20;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// 이전 형식 { hash, created } → { tokens: [...] }
function load() {
  const f = readJson(FILE, null);
  if (!f) return { tokens: [] };
  if (Array.isArray(f.tokens)) return f;
  if (f.hash) return { tokens: [{ id: crypto.randomBytes(6).toString('hex'), hash: f.hash, label: '이전에 발급한 토큰', created: f.created || Date.now(), lastUsed: null }] };
  return { tokens: [] };
}
// 서버 실행 중 CLI 로 발급해도 바로 반영되도록 매번 파일을 읽는다 (호출 빈도가 낮음)
const save = (db) => writeJsonAtomic(FILE, db);

function issue(label = '') {
  const db = load();
  const token = 'wsn_' + crypto.randomBytes(24).toString('base64url');
  db.tokens.push({ id: crypto.randomBytes(6).toString('hex'), hash: sha(token), label: String(label || '알림 토큰').slice(0, 80), created: Date.now(), lastUsed: null });
  while (db.tokens.length > MAX_TOKENS) db.tokens.shift(); // 가장 오래된 것부터
  save(db);
  return token;
}

function find(db, token) {
  if (typeof token !== 'string' || !token.startsWith('wsn_')) return null;
  const got = Buffer.from(sha(token), 'hex');
  return db.tokens.find((t) => {
    const want = Buffer.from(t.hash, 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }) || null;
}

function check(token) {
  const db = load();
  const t = find(db, token);
  if (!t) return false;
  // 마지막 사용 시각은 10분에 한 번만 기록 (알림마다 파일을 쓰지 않도록)
  if (!t.lastUsed || Date.now() - t.lastUsed > 10 * 60e3) { t.lastUsed = Date.now(); save(db); }
  return true;
}

// 토큰 자신으로 폐기 (같은 PC 에 다시 설치할 때 이전 토큰 정리용)
function revoke(token) {
  const db = load();
  const t = find(db, token);
  if (!t) return false;
  db.tokens = db.tokens.filter((x) => x !== t);
  save(db);
  return true;
}

function remove(id) {
  const db = load();
  const n = db.tokens.length;
  db.tokens = db.tokens.filter((t) => t.id !== id);
  if (db.tokens.length !== n) save(db);
  return db.tokens.length !== n;
}

const list = () => load().tokens.map(({ id, label, created, lastUsed }) => ({ id, label, created, lastUsed }));
const info = () => { const n = load().tokens.length; return { exists: n > 0, count: n }; };

module.exports = { issue, check, revoke, remove, list, info };
