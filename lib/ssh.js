'use strict';
const crypto = require('crypto');
const net = require('net');
const { Client } = require('ssh2');
const store = require('./store');

const fingerprint = (key) =>
  'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

function keyType(key) {
  try { return key.subarray(4, 4 + key.readUInt32BE(0)).toString(); } catch { return ''; }
}

function friendly(e, host) {
  const where = `${host.host}:${host.port}`;
  const m = String(e && e.message);
  if (e.code === 'ECONNREFUSED') return new Error(`${where} 연결 거부 — SSH 서버가 꺼져 있거나 포트가 다릅니다`);
  if (e.code === 'ENOTFOUND') return new Error(`${host.host} 주소를 찾을 수 없습니다`);
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return new Error(`${where} 에 도달할 수 없습니다 — 전원/네트워크를 확인하세요`);
  if (e.code === 'ETIMEDOUT' || /Timed out/i.test(m)) return new Error(`${where} 응답 없음 (시간 초과) — 전원/방화벽을 확인하세요`);
  if (/authentication methods failed/i.test(m)) return new Error(`${host.username}@${host.name} 인증 실패 — 사용자명/비밀번호/키를 확인하세요`);
  return new Error(`${host.name}: ${m}`);
}

// ctx = { status(msg), ask(kind, payload) => Promise<answer> }
async function connectOne(host, ctx, sock) {
  const secrets = store.getSecrets(host.id);
  let password = secrets.password;
  if (host.authType === 'ask') {
    password = await ctx.ask('password', { label: `${host.username}@${host.name}` });
    if (typeof password !== 'string' || !password) throw new Error('취소되었습니다');
  }

  return new Promise((resolve, reject) => {
    const c = new Client();
    let hostKeyError = null;
    let kbdTries = 0;

    c.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      kbdTries++;
      if (!prompts.length) return finish([]);
      // 단일 비밀번호 프롬프트는 저장/입력된 비밀번호로 자동 응답 (시놀로지 등)
      if (password && kbdTries === 1 && prompts.length === 1 && !prompts[0].echo) return finish([password]);
      ctx.ask('prompt', {
        title: name || `${host.name} 인증`,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
      }).then((ans) => finish(Array.isArray(ans) ? ans.map(String) : []), () => finish([]));
    });

    c.once('ready', () => resolve(c));
    c.once('error', (e) => { c.end(); reject(hostKeyError || friendly(e, host)); });

    c.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      sock,
      password,
      privateKey: secrets.privateKey,
      passphrase: secrets.passphrase || undefined,
      tryKeyboard: true,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostVerifier: (key, verify) => {
        const fp = fingerprint(key);
        const known = (store.get(host.id) || {}).hostKey;
        if (known === fp) return true;
        if (known) {
          hostKeyError = new Error(
            `⚠ ${host.name} 의 호스트 키가 바뀌었습니다!\n저장됨: ${known}\n현재:   ${fp}\n` +
            '서버/OS를 재설치한 게 아니라면 중간자 공격일 수 있습니다. 확실하면 호스트 편집에서 "호스트 키 초기화" 후 다시 접속하세요.');
          return false;
        }
        ctx.ask('hostkey', { name: host.name, addr: `${host.host}:${host.port}`, fingerprint: fp, keyType: keyType(key) })
          .then((ok) => {
            if (ok === true) { store.setHostKey(host.id, fp); verify(true); }
            else { hostKeyError = new Error('호스트 키를 거부했습니다'); verify(false); }
          }, () => verify(false));
        return undefined; // 비동기 검증
      },
    });
  });
}

// 점프 호스트 체인을 따라 연결한다. 반환된 client 가 닫히면 경유 연결도 닫힌다.
async function connectChain(hostId, ctx, depth = 0) {
  if (depth > 4) throw new Error('점프 호스트 체인이 너무 깁니다');
  const host = store.get(hostId);
  if (!host) throw new Error('호스트를 찾을 수 없습니다');

  let jump = null;
  let sock;
  if (host.jumpId) {
    jump = await connectChain(host.jumpId, ctx, depth + 1);
    ctx.status(`${store.get(host.jumpId).name} 경유 → ${host.host}:${host.port} 연결 중...`);
    try {
      sock = await new Promise((res, rej) =>
        jump.forwardOut('127.0.0.1', 0, host.host, host.port, (e, s) =>
          e ? rej(new Error(`점프 호스트에서 ${host.host}:${host.port} 로 연결 실패: ${e.message}`)) : res(s)));
    } catch (e) { jump.end(); throw e; }
  } else {
    ctx.status(`${host.host}:${host.port} 연결 중...`);
  }

  try {
    const client = await connectOne(host, ctx, sock);
    if (jump) {
      client.once('close', () => jump.end());
      jump.once('close', () => client.end());
    }
    return client;
  } catch (e) {
    if (jump) jump.end();
    throw e;
  }
}

function tcpCheck(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

module.exports = { connectChain, tcpCheck };
