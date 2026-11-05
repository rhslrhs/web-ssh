'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'hosts.json');
let db = { hosts: [] };
if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ── 비밀번호/개인키 암호화 (AES-256-GCM) ──
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(e) {
  if (!e) return {};
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('저장된 인증정보를 복호화할 수 없습니다 (SECRET_KEY 가 바뀌었나요?). 호스트를 편집해 다시 입력하세요.');
  }
}

// ── 입력 검증 ──
class InputError extends Error {}
const bad = (msg) => { throw new InputError(msg); };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function normalizeMac(v) {
  const hex = str(v, 32).replace(/[^0-9a-fA-F]/g, '');
  if (!hex) return '';
  if (hex.length !== 12) bad('MAC 주소 형식이 올바르지 않습니다 (예: AA:BB:CC:DD:EE:FF)');
  return hex.toUpperCase().match(/../g).join(':');
}

function sanitize(input, existing) {
  const h = {};
  h.host = str(input.host, 255);
  if (!h.host || /\s/.test(h.host)) bad('호스트(IP/도메인)를 입력하세요');
  h.name = str(input.name, 60) || h.host;
  h.group = str(input.group, 40);
  h.port = Number(input.port || 22);
  if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) bad('포트는 1~65535 입니다');
  h.username = str(input.username, 64);
  if (!h.username) bad('사용자명을 입력하세요');
  h.authType = ['ask', 'password', 'key'].includes(input.authType) ? input.authType : 'ask';

  h.jumpId = str(input.jumpId, 64);
  if (h.jumpId) {
    // 존재 여부 + 순환 참조 검사
    const seen = new Set(existing ? [existing.id] : []);
    for (let cur = h.jumpId; cur; ) {
      if (seen.has(cur)) bad('점프 호스트가 순환 참조됩니다');
      seen.add(cur);
      const j = db.hosts.find((x) => x.id === cur);
      if (!j) bad('점프 호스트를 찾을 수 없습니다');
      cur = j.jumpId;
    }
  }

  // 접속 직후 셸 대신 실행할 명령 (예: wsl -d Ubuntu -- tmux new -As claude)
  h.command = str(input.command, 500).replace(/[\r\n]+/g, ' ');

  h.mac = normalizeMac(input.mac);
  h.wolBroadcast = str(input.wolBroadcast, 64);
  if (h.wolBroadcast && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h.wolBroadcast)) bad('WOL 브로드캐스트는 IPv4 주소입니다 (예: 192.168.1.255)');

  // 인증정보: 비워두면 기존 값 유지
  const old = existing ? decrypt(existing.secret) : {};
  const s = {};
  if (h.authType === 'password') {
    s.password = input.password ? String(input.password) : old.password;
    if (!s.password) bad('비밀번호를 입력하세요');
  } else if (h.authType === 'key') {
    const newKey = str(input.privateKey, 20000);
    s.privateKey = newKey || old.privateKey;
    if (!s.privateKey) bad('개인키를 입력하세요');
    s.passphrase = input.passphrase ? String(input.passphrase) : (newKey ? '' : old.passphrase || '');
    const parsed = sshUtils.parseKey(s.privateKey, s.passphrase || undefined);
    if (parsed instanceof Error) bad('개인키를 읽을 수 없습니다: ' + parsed.message);
    if (input.password) s.password = String(input.password); // 키 실패 시 대체용(선택)
    else if (old.password && !newKey) s.password = old.password;
  }
  h.secret = Object.keys(s).length ? encrypt(s) : null;

  // 주소가 바뀌면 저장된 호스트 키는 의미가 없으므로 초기화
  h.hostKey = existing && existing.host === h.host && existing.port === h.port ? existing.hostKey || '' : '';
  return h;
}

function publicView(h) {
  const { secret, ...rest } = h;
  return { ...rest, hasSecret: !!secret };
}

module.exports = {
  InputError,
  list: () => db.hosts.map(publicView),
  get: (id) => db.hosts.find((h) => h.id === id) || null,
  getSecrets: (id) => {
    const h = db.hosts.find((x) => x.id === id);
    return h ? decrypt(h.secret) : {};
  },
  create(input) {
    const h = { id: crypto.randomBytes(6).toString('hex'), ...sanitize(input, null) };
    db.hosts.push(h);
    save();
    return publicView(h);
  },
  update(id, input) {
    const i = db.hosts.findIndex((h) => h.id === id);
    if (i < 0) return null;
    db.hosts[i] = { id, ...sanitize(input, db.hosts[i]) };
    save();
    return publicView(db.hosts[i]);
  },
  remove(id) {
    const users = db.hosts.filter((h) => h.jumpId === id);
    if (users.length) bad(`점프 호스트로 사용 중입니다: ${users.map((u) => u.name).join(', ')}`);
    const n = db.hosts.length;
    db.hosts = db.hosts.filter((h) => h.id !== id);
    if (db.hosts.length !== n) save();
    return db.hosts.length !== n;
  },
  setHostKey(id, fp) {
    const h = db.hosts.find((x) => x.id === id);
    if (h) { h.hostKey = fp; save(); }
  },
};
