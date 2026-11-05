'use strict';
// AES-256-GCM 봉인. v2 는 용도/소유자 라벨(예: "host:<id>")을 AAD 로 묶어서,
// 암호문을 다른 호스트/필드로 옮겨 붙이면 복호화가 실패하게 한다.
// v 필드가 없는 기존(v1, AAD 없음) 데이터도 읽을 수 있다 → 로드 시 v2 로 변환.
const crypto = require('crypto');
const config = require('./config');

const aad = (label) => Buffer.from('web-ssh:' + label, 'utf8');

function seal(text, label) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encKey, iv);
  c.setAAD(aad(label));
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { v: 2, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// 실패하면 예외 (키 불일치, 변조, 다른 라벨로 옮겨진 암호문)
function open(e, label) {
  const d = crypto.createDecipheriv('aes-256-gcm', config.encKey, Buffer.from(e.iv, 'base64'));
  if (e.v === 2) d.setAAD(aad(label));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

const isLegacy = (e) => !!e && e.v !== 2;

module.exports = { seal, open, isLegacy };
