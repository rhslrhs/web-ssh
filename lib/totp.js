'use strict';
// RFC 6238 TOTP (SHA1, 30초, 6자리) — Google Authenticator / Microsoft Authenticator 호환
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1e6;
  return String(n).padStart(6, '0');
}

// 맞으면 사용된 counter, 틀리면 null. lastCounter 이하(이미 쓴 코드)는 재사용 거부.
function verify(secret, code, lastCounter = 0, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const counter = cur + d;
    if (counter <= lastCounter) continue;
    const expect = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return counter;
  }
  return null;
}

function otpauthUri(secret, label, issuer) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, otpauthUri, hotp, base32Decode, base32Encode };
