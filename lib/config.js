'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (APP_PASSWORD.length < 8) {
  console.error('[web-ssh] APP_PASSWORD 환경변수(8자 이상)가 필요합니다.');
  process.exit(1);
}

// 저장된 비밀번호/키 암호화와 로그인 세션 서명에 쓰는 마스터 키.
// SECRET_KEY 를 지정하지 않으면 data/secret.key 를 자동 생성한다.
function loadMasterKey() {
  if (process.env.SECRET_KEY) {
    return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  console.warn('[web-ssh] SECRET_KEY 미설정 → data/secret.key 를 생성했습니다. 이 파일을 지우면 저장된 비밀번호를 복호화할 수 없습니다.');
  return key;
}

const master = loadMasterKey();
const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
const pwTag = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex');

const { parseAllowList } = require('./netpolicy');

module.exports = {
  DATA_DIR,
  // 외부(공인 IP) 접속 허용. 켜면 외부 로그인은 2단계 인증(OTP)이 설정된 경우에만 가능
  PUBLIC_ACCESS: process.env.PUBLIC_ACCESS === '1',
  // 외부 접속을 허용할 공인 IP/대역 (비우면 전체 허용). 예: 203.0.113.7,198.51.100.0/24
  allowPublic: parseAllowList(process.env.ALLOW_PUBLIC_IPS),
  // 리버스 프록시 뒤 외부 주소 (Origin 검사용). 예: https://ssh.example.synology.me
  PUBLIC_ORIGIN: (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
  PORT: Number(process.env.PORT) || 8822,
  BIND: process.env.BIND || '0.0.0.0',
  APP_PASSWORD,
  SESSION_HOURS: Number(process.env.SESSION_HOURS) || 12,
  WOL_BROADCAST: process.env.WOL_BROADCAST || '255.255.255.255',
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
  encKey: derive('web-ssh:enc'),
  // 앱 비밀번호를 바꾸면 기존 로그인 세션이 모두 무효화된다
  macKey: derive('web-ssh:session:' + pwTag),
};
