'use strict';
// 알림 전용 토큰 — Claude Code 훅 등 외부 스크립트가 /api/notify 로 푸시를 보낼 때 사용.
// 이 토큰으로는 로그인·SSH 접속을 할 수 없다. 파일에는 해시만 저장한다.
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./jsonfile');

const FILE = path.join(config.DATA_DIR, 'notify-token.json');
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest();

function issue() {
  const token = 'wsn_' + crypto.randomBytes(24).toString('base64url');
  writeJsonAtomic(FILE, { hash: sha(token).toString('hex'), created: Date.now() });
  return token;
}

// 서버 실행 중 CLI 로 재발급해도 바로 반영되도록 매번 파일을 읽는다 (호출 빈도가 낮음)
function check(token) {
  if (typeof token !== 'string' || !token.startsWith('wsn_')) return false;
  const f = readJson(FILE, null);
  if (!f || !f.hash) return false;
  const want = Buffer.from(f.hash, 'hex');
  const got = sha(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function info() {
  const f = readJson(FILE, null);
  return f ? { exists: true, created: f.created } : { exists: false };
}

module.exports = { issue, check, info };
