'use strict';
const crypto = require('crypto');
const net = require('net');
const { Client } = require('ssh2');
const store = require('./store');

const NET_TIMEOUT_MS = Number(process.env.SSH_TIMEOUT_MS) || 20000;   // 네트워크/서버 응답 대기
const ASK_TIMEOUT_MS = Number(process.env.SSH_ASK_TIMEOUT_MS) || 300000; // 사용자 입력 대기 (5분)

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
    if (typeof password !== 'string' || !password) throw new Error('비밀번호 입력을 취소했습니다.');
  }

  return new Promise((resolve, reject) => {
    const c = new Client();
    let hostKeyError = null;
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; disarm(); c.end(); reject(err); };

    // 접속/인증 타이머. ssh2 의 readyTimeout 은 인증 성공 때만 멈춰서, 사용자가 지문 확인이나
    // OTP 입력에 20초 넘게 머물면 끊긴다 → 직접 관리하고, 사용자에게 묻는 동안에는 멈춘다.
    let timer = null;
    const disarm = () => { clearTimeout(timer); timer = null; };
    const arm = () => {
      disarm();
      timer = setTimeout(() => fail(new Error(`${host.host}:${host.port} 응답 없음 (시간 초과) — 전원/방화벽을 확인하세요`)), NET_TIMEOUT_MS);
    };
    const askUser = (kind, payload) => {
      disarm();
      let wait;
      const limit = new Promise((_, rej) => { wait = setTimeout(() => rej(new Error('입력 대기 시간이 지났습니다. 다시 연결하세요.')), ASK_TIMEOUT_MS); });
      return Promise.race([ctx.ask(kind, payload), limit]).finally(() => { clearTimeout(wait); if (!settled) arm(); });
    };
    let pwSent = false; // 저장된 비밀번호는 한 번만 자동 입력 (틀렸을 때 반복 시도 방지)

    c.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      // 비밀번호를 묻는 단일 프롬프트에만 자동 응답 (시놀로지 등).
      // "Verification code:" 같은 OTP 프롬프트에 비밀번호를 넣어 실패 횟수를 낭비하지 않도록 문구를 확인하고,
      // OTP → 비밀번호 순서로 묻는 서버도 있으므로 "첫 라운드"가 아니라 "첫 비밀번호 프롬프트"에 넣는다.
      const p0 = prompts[0];
      const asksPassword = /pass(word|phrase)?|암호|비밀번호/i.test(p0.prompt) && !/code|otp|token|verif|인증 ?코드/i.test(p0.prompt);
      if (password && !pwSent && prompts.length === 1 && !p0.echo && asksPassword) { pwSent = true; return finish([password]); }
      askUser('prompt', {
        title: name || `${host.name} 인증`,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
      }).then((ans) => finish(Array.isArray(ans) ? ans.map(String) : []), (e) => fail(e));
    });

    c.once('ready', () => { if (settled) return c.end(); settled = true; disarm(); resolve(c); });
    c.once('error', (e) => fail(hostKeyError || friendly(e, host)));
    arm();

    c.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      sock,
      password,
      privateKey: secrets.privateKey,
      passphrase: secrets.passphrase || undefined,
      tryKeyboard: true,
      readyTimeout: 0, // 위의 arm()/disarm() 이 대신 관리
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
        askUser('hostkey', { name: host.name, addr: `${host.host}:${host.port}`, fingerprint: fp, keyType: keyType(key) })
          .then((ok) => {
            if (ok === true) { store.setHostKey(host.id, fp); verify(true); }
            else { hostKeyError = new Error('호스트 키를 거부했습니다'); verify(false); }
          }, (e) => fail(e));
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
