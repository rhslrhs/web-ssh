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
const fatal = (msg) => { console.error('[web-ssh] ' + msg); process.exit(1); };

function loadMasterKey() {
  if (process.env.SECRET_KEY) {
    // 사람이 정한 짧은 문장은 키 강도가 낮다 → 최소 길이 강제 (gen-env.sh 는 64자리 hex 생성)
    if (process.env.SECRET_KEY.length < 32) {
      fatal('SECRET_KEY 는 32자 이상이어야 합니다. 예: openssl rand -hex 32 (또는 gen-env.sh 사용)');
    }
    return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, 'utf8').trim();
    // 비었거나 손상된 키로 조용히 동작하지 않도록 정확히 32바이트(64자리 hex)만 허용
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      fatal(`${file} 가 손상되었습니다 (64자리 hex 가 아님). 백업에서 복구하거나, 저장된 비밀번호를 포기하고 파일을 지운 뒤 다시 시작하세요.`);
    }
    return Buffer.from(hex, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  console.warn('[web-ssh] SECRET_KEY 미설정 → data/secret.key 를 생성했습니다. 이 파일을 지우면 저장된 비밀번호를 복호화할 수 없습니다.');
  return key;
}

const master = loadMasterKey();
const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
const pwTag = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex');

const { parseAllowList } = require('./netpolicy');
let allowPublic = null;
try { allowPublic = parseAllowList(process.env.ALLOW_PUBLIC_IPS); } catch (e) { fatal(e.message); }
// 다른 장비의 리버스 프록시 (예: NAS 의 DSM 이 VM 의 web-ssh 로 전달) — 이 주소에서 온 요청은 X-Real-IP 를 믿는다
let trustedProxy = null;
try { trustedProxy = parseAllowList(process.env.TRUSTED_PROXIES, 'TRUSTED_PROXIES'); } catch (e) { fatal(e.message); }

module.exports = {
  DATA_DIR,
  // 외부(공인 IP) 접속 허용. 켜면 외부 로그인은 2단계 인증(OTP)이 설정된 경우에만 가능
  PUBLIC_ACCESS: process.env.PUBLIC_ACCESS === '1',
  // 외부 접속을 허용할 공인 IP/대역 (비우면 전체 허용). 예: 203.0.113.7,198.51.100.0/24
  allowPublic,
  // 리버스 프록시 뒤 외부 주소 (Origin 검사용). 예: https://ssh.example.synology.me
  PUBLIC_ORIGIN: (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
  PORT: Number(process.env.PORT) || 8822,
  BIND: process.env.BIND || '0.0.0.0',
  APP_PASSWORD,
  // 로그인 유지: 이 시간 동안 활동이 없으면 로그아웃 (활동하면 연장)
  SESSION_IDLE_MIN: Number(process.env.SESSION_IDLE_MIN) || 30,
  // 계속 활동해도 이 시간이 지나면 다시 로그인 (SESSION_HOURS 는 이전 이름)
  SESSION_MAX_HOURS: Number(process.env.SESSION_MAX_HOURS) || Number(process.env.SESSION_HOURS) || 168,
  WOL_BROADCAST: process.env.WOL_BROADCAST || '255.255.255.255',
  // TRUSTED_PROXIES 를 지정하면 TRUST_PROXY=1 로 본다
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || !!trustedProxy,
  trustedProxy,
  encKey: derive('web-ssh:enc'),
  // 앱 비밀번호를 바꾸면 기존 로그인 세션이 모두 무효화된다
  macKey: derive('web-ssh:session:' + pwTag),
};
