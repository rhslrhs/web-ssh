'use strict';
// 엔드투엔드 스모크 테스트: 테스트용 SSH 서버 + web-ssh 를 띄우고 HTTP/WebSocket 으로 검증한다.
// 실행: npm test
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');
const WebSocket = require('ws');
const totp = require('../lib/totp');

const APP = path.join(__dirname, '..');
const SSH_PORT = 22999;
const WEB_PORT = 18822;
const base = `http://127.0.0.1:${WEB_PORT}`;
const procs = [];
let sshd;

// ── 테스트 SSH 서버: test/secret, 입력을 "echo:" 로 돌려줌, exec·tcpip 포워딩 지원 ──
function startSshd() {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  sshd = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username === 'kbd') {
        if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
        return ctx.prompt([{ prompt: 'Verification code: ', echo: false }], (a1) => {
          if (a1[0] !== '123456') return ctx.reject();
          ctx.prompt([{ prompt: 'Password: ', echo: false }], (a2) => (a2[0] === 'secret' ? ctx.accept() : ctx.reject()));
        });
      }
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'secret') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const up = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(up).pipe(ch); });
        up.on('error', () => reject());
      });
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (a) => a && a());
        s.on('window-change', (a) => a && a());
        const run = (st, banner) => {
          st.write(banner + 'welcome 안녕\r\n');
          st.on('data', (d) => { if (String(d).includes('exit')) { st.exit(0); st.end(); } else st.write('echo:' + d); });
        };
        s.on('exec', (a, r, info) => run(a(), 'ran:' + info.command + '\r\n'));
        s.on('shell', (a) => run(a(), ''));
      });
    });
  });
  return new Promise((r) => sshd.listen(SSH_PORT, '127.0.0.1', r));
}

const newDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wssh-'));
async function startWeb(env, dataDir = newDataDir()) {
  const p = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: { ...process.env, APP_PASSWORD: 'testpassword', PORT: WEB_PORT, BIND: '127.0.0.1', DATA_DIR: dataDir, SECRET_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  if (process.env.VERBOSE) { p.stdout.pipe(process.stdout); p.stderr.pipe(process.stderr); }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { await fetch(base + '/api/me'); return { p, dataDir }; } catch { /* 아직 */ }
  }
  throw new Error('web-ssh 시작 실패');
}
const stopWeb = (w) => new Promise((r) => { w.p.once('exit', r); w.p.kill(); });

const H = { 'Content-Type': 'application/json', Origin: base };
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body || {}) });

async function login(body, headers) {
  const r = await post('/api/login', body, headers);
  const data = await r.json();
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, data, cookie };
}

function session(cookie, hostId, answers) {
  return new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, { headers: { Cookie: cookie, Origin: base } });
    let out = '';
    const asks = [];
    let error = null;
    w.on('open', () => w.send(JSON.stringify({ t: 'connect', hostId, cols: 100, rows: 30 })));
    w.on('message', (d, bin) => {
      if (bin) {
        out += d.toString();
        if (out.includes('echo:hello')) w.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
        return;
      }
      const m = JSON.parse(d);
      if (m.t === 'ask') { asks.push(m.kind); w.send(JSON.stringify({ t: 'answer', id: m.id, value: answers[m.kind] })); }
      if (m.t === 'ready') { w.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 })); w.send(JSON.stringify({ t: 'i', d: 'hello' })); }
      if (m.t === 'error') error = m.msg;
    });
    w.on('error', () => {});
    w.on('close', () => resolve({ out, asks, error }));
  });
}

const ok = (msg) => console.log('  ✓ ' + msg);

async function testCore() {
  console.log('[기본 기능]');
  const web = await startWeb({});
  let r = await fetch(base + '/api/hosts');
  assert.strictEqual(r.status, 401); ok('미인증 API 차단');
  assert.strictEqual((await login({ password: 'wrong' })).status, 401); ok('틀린 비밀번호 거부');
  const { cookie } = await login({ password: 'testpassword' });
  assert(cookie.startsWith('wssh=')); ok('로그인');
  const A = { Cookie: cookie };

  r = await post('/api/hosts', { name: 'direct', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'password', password: 'secret' }, A);
  const direct = await r.json();
  assert(direct.id && !direct.secret && direct.hasSecret);
  const via = await (await post('/api/hosts', { name: 'via', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'ask', jumpId: direct.id }, A)).json();
  const cmd = await (await post('/api/hosts', { name: 'cmd', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'password', password: 'secret', command: 'tmux new -As claude' }, A)).json();
  const stored = JSON.parse(fs.readFileSync(path.join(web.dataDir, 'hosts.json'), 'utf8'));
  assert(stored.hosts[0].secret.data && !JSON.stringify(stored.hosts[0].secret).includes('secret'));
  assert(!('password' in stored.hosts[0])); ok('인증정보 암호화 저장');

  const st = await (await fetch(base + '/api/status', { headers: A })).json();
  assert.strictEqual(st[direct.id], true); assert.strictEqual(st[via.id], null); ok('온라인 상태 확인');

  await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, { headers: { Cookie: cookie, Origin: 'http://evil.example' } });
    w.on('open', () => rej(new Error('cross-origin ws accepted')));
    w.on('error', () => res());
  });
  ok('다른 출처 WebSocket 차단');

  let s = await session(cookie, direct.id, { hostkey: true });
  assert.deepStrictEqual(s.asks, ['hostkey']); assert(s.out.includes('welcome 안녕') && s.out.includes('echo:hello')); ok('첫 접속: 호스트 키 확인 → 셸 입출력');
  s = await session(cookie, direct.id, {});
  assert.deepStrictEqual(s.asks, []); assert(s.out.includes('echo:hello')); ok('저장된 호스트 키 → 질문 없음');
  s = await session(cookie, via.id, { hostkey: true, password: 'secret' });
  assert(s.asks.includes('password') && s.out.includes('echo:hello')); ok('점프 호스트 경유 + 비밀번호 입력');
  s = await session(cookie, via.id, { password: 'nope' });
  assert(!s.out.includes('echo:hello') && /인증 실패/.test(s.error)); ok('틀린 SSH 비밀번호 → 오류 후 종료');
  s = await session(cookie, cmd.id, { hostkey: true });
  assert(s.out.includes('ran:tmux new -As claude') && s.out.includes('echo:hello')); ok('접속 후 실행 명령');

  r = await fetch(base + '/api/hosts/' + direct.id, { method: 'DELETE', headers: { ...H, ...A } });
  assert.strictEqual(r.status, 400); ok('사용 중인 점프 호스트 삭제 거부');
  for (const p of ['/', '/app.js', '/vendor/xterm/lib/xterm.js', '/vendor/addon-fit/lib/addon-fit.js', '/vendor/xterm/css/xterm.css']) {
    assert.strictEqual((await fetch(base + p)).status, 200, p);
  }
  ok('정적 파일');
  await stopWeb(web);
}

async function testExternal() {
  console.log('[외부 접속 / 2단계 인증]');
  const web = await startWeb({ TRUST_PROXY: '1', PUBLIC_ACCESS: '1', ALLOW_PUBLIC_IPS: '203.0.113.0/24' });
  const PUB = { 'X-Real-IP': '203.0.113.7' };     // 허용 대역의 외부 IP (프록시가 넘겨준 것처럼)
  const DENY = { 'X-Real-IP': '198.51.100.9' };   // 허용 목록 밖

  assert.strictEqual((await fetch(base + '/', { headers: DENY })).status, 403); ok('허용 목록 밖 외부 IP 차단');
  const spoof = await fetch(base + '/', { headers: { ...DENY, 'X-Forwarded-For': '192.168.1.5' } });
  assert.strictEqual(spoof.status, 403); ok('X-Forwarded-For 위조로 내부망 사칭 불가');

  let l = await login({ password: 'testpassword' }, PUB);
  assert.strictEqual(l.status, 403); ok('OTP 미설정 시 외부 로그인 거부');

  // 내부망에서 로그인 후 OTP 설정
  l = await login({ password: 'testpassword' });
  assert.strictEqual(l.status, 200);
  const A = { Cookie: l.cookie };
  let r = await post('/api/security/totp/start', {}, { ...A, ...PUB });
  assert.strictEqual(r.status, 403); ok('외부에서 OTP 설정 변경 불가');
  r = await post('/api/security/totp/start', {}, A);
  const { secret, qr } = await r.json();
  assert(secret && qr.startsWith('data:image/svg+xml;base64,'));
  const now = Date.now();
  const cur = Math.floor(now / 30000);
  r = await post('/api/security/totp/enable', { code: totp.hotp(secret, cur + 10) }, A); // 틀린 코드
  assert.strictEqual(r.status, 400);
  r = await post('/api/security/totp/enable', { code: totp.hotp(secret, cur) }, A);
  assert.strictEqual(r.status, 200);
  const newCookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.strictEqual((await fetch(base + '/api/hosts', { headers: A })).status, 401); ok('OTP 설정 → 기존 세션 무효화');
  assert.strictEqual((await fetch(base + '/api/hosts', { headers: { Cookie: newCookie } })).status, 200); ok('설정한 기기는 로그인 유지');

  l = await login({ password: 'testpassword' }, PUB);
  assert.strictEqual(l.status, 401); assert(l.data.needCode); ok('OTP 없이 로그인 거부');
  l = await login({ password: 'wrong', code: totp.hotp(secret, cur + 1) }, PUB);
  assert.strictEqual(l.status, 401);
  assert.strictEqual(l.data.error, '비밀번호 또는 OTP 코드가 틀렸습니다.'); ok('틀린 비밀번호 + 맞는 OTP → 어느 쪽이 틀렸는지 숨김');
  l = await login({ password: 'testpassword', code: totp.hotp(secret, cur + 1) }, PUB);
  assert.strictEqual(l.status, 200); ok('외부에서 비밀번호 + OTP 로그인');
  const replay = await login({ password: 'testpassword', code: totp.hotp(secret, cur + 1) }, PUB);
  assert.strictEqual(replay.status, 401); ok('같은 OTP 코드 재사용 거부');

  // 외부 IP 연속 실패 → 잠금
  const BAD = { 'X-Real-IP': '203.0.113.50' };
  for (let i = 0; i < 5; i++) await login({ password: 'x', code: '123456' }, BAD);
  assert.strictEqual((await login({ password: 'testpassword', code: totp.hotp(secret, cur + 1) }, BAD)).status, 429); ok('5회 실패 → IP 잠금');

  // 외부 세션으로 WebSocket
  await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, { headers: { Cookie: l.cookie, Origin: base, ...DENY } });
    w.on('open', () => rej(new Error('denied IP ws accepted')));
    w.on('error', () => res());
  });
  ok('허용 목록 밖 IP 는 세션이 있어도 WebSocket 차단');
  await stopWeb(web);

  // PUBLIC_ACCESS 꺼짐(기본값) → 외부 IP 전부 차단
  const web2 = await startWeb({ TRUST_PROXY: '1' });
  assert.strictEqual((await fetch(base + '/', { headers: PUB })).status, 403); ok('PUBLIC_ACCESS 기본값: 외부 차단');
  assert.strictEqual((await fetch(base + '/')).status, 200); ok('내부망은 정상');
  await stopWeb(web2);
}

// 프로세스가 바로 종료되는지 (시작 거부)
function startExpectFail(env, dataDir) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(APP, 'server.js')], {
      env: { ...process.env, APP_PASSWORD: 'testpassword', PORT: WEB_PORT, BIND: '127.0.0.1', DATA_DIR: dataDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: 'running', err }); }, 3000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

// v1(AAD 없음) 형식으로 직접 암호화 — 기존 데이터 재현용
function legacySeal(secretKey, text) {
  const crypto = require('crypto');
  const master = crypto.createHash('sha256').update(secretKey).digest();
  const key = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'web-ssh:enc', 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

async function testHardening() {
  console.log('[키 관리 / 암호화 / 인증 강화]');
  let r = await startExpectFail({ SECRET_KEY: 'short-key' }, newDataDir());
  assert.strictEqual(r.code, 1); assert(/32자 이상/.test(r.err)); ok('짧은 SECRET_KEY → 시작 거부');
  const bad = newDataDir();
  fs.writeFileSync(path.join(bad, 'secret.key'), 'abc');
  r = await startExpectFail({ SECRET_KEY: '' }, bad);
  assert.strictEqual(r.code, 1); assert(/손상/.test(r.err)); ok('손상된 secret.key → 시작 거부');
  fs.writeFileSync(path.join(bad, 'secret.key'), '');
  r = await startExpectFail({ SECRET_KEY: '' }, bad);
  assert.strictEqual(r.code, 1); ok('빈 secret.key → 시작 거부');

  // 기존(v1) 데이터 자동 변환
  const KEY = 'a'.repeat(64);
  const dir = newDataDir();
  const otp = totp.generateSecret();
  fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify({ hosts: [
    { id: 'legacy1', name: 'legacy', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'password',
      jumpId: '', command: '', mac: '', wolBroadcast: '', group: '', hostKey: '', secret: legacySeal(KEY, JSON.stringify({ password: 'secret' })) },
    { id: 'legacy2', name: 'other', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'password',
      jumpId: '', command: '', mac: '', wolBroadcast: '', group: '', hostKey: '', secret: legacySeal(KEY, JSON.stringify({ password: 'zzz' })) },
  ] }));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ ver: 1, totp: legacySeal(KEY, otp), totpLast: 0 }));
  let web = await startWeb({ SECRET_KEY: KEY }, dir);
  const hosts = JSON.parse(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'));
  const authState = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert(hosts.hosts.every((h) => h.secret.v === 2) && authState.totp.v === 2); ok('기존 hosts.json / auth.json → v2 자동 변환');
  const cur = Math.floor(Date.now() / 30000);
  const l = await login({ password: 'testpassword', code: totp.hotp(otp, cur) });
  assert.strictEqual(l.status, 200); ok('변환된 OTP 비밀키로 로그인');
  let s = await session(l.cookie, 'legacy1', { hostkey: true });
  assert(s.out.includes('echo:hello')); ok('변환된 비밀번호로 SSH 접속');

  // 키보드 인터랙티브: OTP 를 먼저 묻는 서버 → 비밀번호를 OTP 칸에 넣지 않음
  const kbd = await (await post('/api/hosts', { name: 'kbd', host: '127.0.0.1', port: SSH_PORT, username: 'kbd', authType: 'password', password: 'secret' }, { Cookie: l.cookie })).json();
  s = await session(l.cookie, kbd.id, { hostkey: true, prompt: ['123456'] });
  assert.deepStrictEqual(s.asks, ['hostkey', 'prompt']); assert(s.out.includes('echo:hello'));
  ok('OTP 프롬프트는 사용자에게 묻고, 이어지는 Password 프롬프트만 자동 입력');
  await stopWeb(web);

  // 암호문을 다른 호스트로 옮겨 붙이면 복호화 실패 (AAD)
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'));
  db.hosts.find((h) => h.id === 'legacy2').secret = db.hosts.find((h) => h.id === 'legacy1').secret;
  fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify(db));
  web = await startWeb({ SECRET_KEY: KEY }, dir);
  const l2 = await login({ password: 'testpassword', code: totp.hotp(otp, cur + 1) });
  s = await session(l2.cookie, 'legacy2', { hostkey: true });
  assert(!s.out.includes('echo:hello') && /복호화할 수 없습니다/.test(s.error)); ok('다른 호스트로 옮긴 암호문 → 복호화 거부');
  s = await session(l2.cookie, 'legacy1', {});
  assert(s.out.includes('echo:hello')); ok('원래 호스트는 정상');
  await stopWeb(web);
}

function testTotpUnit() {
  console.log('[TOTP]');
  // RFC 6238 테스트 벡터 (SHA1, 비밀키 "12345678901234567890")
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(totp.hotp(secret, Math.floor(59 / 30)), '287082');
  assert.strictEqual(totp.hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.strictEqual(totp.hotp(secret, Math.floor(20000000000 / 30)), '353130');
  ok('RFC 6238 테스트 벡터');
}

(async () => {
  try {
    testTotpUnit();
    await startSshd();
    await testCore();
    await testExternal();
    await testHardening();
    console.log('ALL PASSED');
    process.exitCode = 0;
  } catch (e) {
    console.error('FAIL:', e);
    process.exitCode = 1;
  } finally {
    for (const p of procs) p.kill();
    if (sshd) sshd.close();
    setTimeout(() => process.exit(), 300);
  }
})();
