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
  // WSL 에서 /mnt/c(NTFS)의 node_modules 를 처음 읽을 때 수 초 걸릴 수 있어 넉넉히 기다린다
  for (let i = 0; i < 300; i++) {
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

function session(cookie, hostId, answers, delayMs = 0) {
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
      if (m.t === 'ask') {
        asks.push(m.kind);
        setTimeout(() => w.readyState === 1 && w.send(JSON.stringify({ t: 'answer', id: m.id, value: answers[m.kind] })), delayMs);
      }
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
  const LAN = { 'X-Real-IP': '192.168.0.10' };    // 프록시를 거친 내부망 접속

  assert.strictEqual((await fetch(base + '/', { headers: DENY })).status, 403); ok('허용 목록 밖 외부 IP 차단');
  const spoof = await fetch(base + '/', { headers: { ...DENY, 'X-Forwarded-For': '192.168.1.5' } });
  assert.strictEqual(spoof.status, 403); ok('X-Forwarded-For 위조로 내부망 사칭 불가');

  let l = await login({ password: 'testpassword' }, PUB);
  assert.strictEqual(l.status, 403); ok('OTP 미설정 시 외부 로그인 거부');

  // 내부망에서 로그인 후 OTP 설정
  l = await login({ password: 'testpassword' }, LAN);
  assert.strictEqual(l.status, 200);
  const A = { Cookie: l.cookie, ...LAN };
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
  assert.strictEqual((await fetch(base + '/api/hosts', { headers: { Cookie: newCookie, ...LAN } })).status, 200); ok('설정한 기기는 로그인 유지');

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
  assert.strictEqual((await fetch(base + '/', { headers: LAN })).status, 200); ok('내부망은 정상');
  // 프록시가 X-Real-IP 를 안 넣으면(cloudflared 등) 루프백이라도 내부망으로 보지 않는다
  assert.strictEqual((await fetch(base + '/')).status, 403); ok('TRUST_PROXY=1 + X-Real-IP 없음 → 외부 취급 (fail-closed)');
  assert.strictEqual((await fetch(base + '/', { headers: { 'X-Real-IP': 'garbage' } })).status, 403); ok('형식이 이상한 X-Real-IP → 외부 취급');
  await stopWeb(web2);

  // TRUST_PROXY=0 인데 같은 장비 프록시 뒤에 둔 경우 (설정 누락)
  const web3 = await startWeb({ PUBLIC_ACCESS: '1', PUBLIC_ORIGIN: 'https://ws.example.com' });
  assert.strictEqual((await fetch(base + '/')).status, 200); ok('TRUST_PROXY=0: 프록시 헤더 없는 루프백은 내부망');
  l = await login({ password: 'testpassword' }, { 'X-Forwarded-For': '203.0.113.7' });
  assert.strictEqual(l.status, 403); ok('TRUST_PROXY=0 + 프록시 헤더 → 외부 취급 (OTP 없이 로그인 불가)');
  l = await login({ password: 'testpassword' }, { 'X-Real-IP': '192.168.0.10' });
  assert.strictEqual(l.status, 403); ok('TRUST_PROXY=0 이면 X-Real-IP 로 내부망 사칭 불가');
  const viaHost = await rawRequest('POST', '/api/login', { Host: 'ws.example.com', 'Content-Type': 'application/json', Origin: 'https://ws.example.com' }, JSON.stringify({ password: 'testpassword' }));
  assert.strictEqual(viaHost.status, 403); ok('TRUST_PROXY=0 + PUBLIC_ORIGIN 주소로 들어온 요청 → 외부 취급');
  await stopWeb(web3);
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
    const t = setTimeout(() => { p.kill(); resolve({ code: 'running', err }); }, 20000);
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

async function testReview2() {
  console.log('[타임아웃 / 허용 목록 / CGNAT]');
  // 접속 타이머(1.5초)보다 오래 지문 확인 창에 머물러도 끊기지 않아야 함
  let web = await startWeb({ SSH_TIMEOUT_MS: '1500' });
  const { cookie } = await login({ password: 'testpassword' });
  const h = await (await post('/api/hosts', { name: 'slow', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'ask' }, { Cookie: cookie })).json();
  const s = await session(cookie, h.id, { password: 'secret', hostkey: true }, 2500);
  assert(s.out.includes('echo:hello'), JSON.stringify(s)); ok('사용자 입력 대기 중에는 접속 타이머 정지 (2.5초 대기 > 1.5초 제한)');
  // 응답 없는 서버는 여전히 시간 초과
  const black = net.createServer(() => {}).listen(23001, '127.0.0.1');
  const h2 = await (await post('/api/hosts', { name: 'black', host: '127.0.0.1', port: 23001, username: 'test', authType: 'password', password: 'x' }, { Cookie: cookie })).json();
  const t0 = Date.now();
  const s2 = await session(cookie, h2.id, {});
  black.close();
  assert(/시간 초과/.test(s2.error) && Date.now() - t0 < 5000, JSON.stringify(s2)); ok('응답 없는 서버는 시간 초과');
  await stopWeb(web);

  for (const bad of ['1.2.3.4/40', '1.2.3.4/', '::1/64']) {
    const r = await startExpectFail({ PUBLIC_ACCESS: '1', ALLOW_PUBLIC_IPS: bad }, newDataDir());
    assert.strictEqual(r.code, 1, bad); assert(/형식 오류/.test(r.err));
  }
  ok('잘못된 ALLOW_PUBLIC_IPS (접두사 40, 빈 접두사, IPv6 대역) → 시작 거부');

  web = await startWeb({ TRUST_PROXY: '1' });
  assert.strictEqual((await fetch(base + '/', { headers: { 'X-Real-IP': '100.64.1.1' } })).status, 403); ok('CGNAT(100.64/10) 기본값: 외부로 취급');
  await stopWeb(web);
  web = await startWeb({ TRUST_PROXY: '1', TRUST_CGNAT: '1' });
  assert.strictEqual((await fetch(base + '/', { headers: { 'X-Real-IP': '100.64.1.1' } })).status, 200); ok('TRUST_CGNAT=1: 내부망으로 취급 (Tailscale)');
  await stopWeb(web);

  // DNS 리바인딩: 알 수 없는 Host 거부
  web = await startWeb({ PUBLIC_ORIGIN: 'https://ws.example.com', ALLOWED_HOSTS: 'nas.example.org,.home.example' });
  const hostStatus = async (h) => (await rawRequest('GET', '/', { Host: h })).status;
  assert.strictEqual(await hostStatus('evil.example'), 403);
  assert.strictEqual(await hostStatus('evil.example:18822'), 403); ok('알 수 없는 Host 거부 (DNS 리바인딩 방지)');
  for (const h of ['127.0.0.1:18822', '192.168.0.5', '[::1]:18822', 'localhost', 'mynas:18822', 'mynas.local', 'nas.example.org', 'a.home.example', 'home.example']) {
    assert.strictEqual(await hostStatus(h), 200, h);
  }
  ok('IP · localhost · 장비 이름 · .local · ALLOWED_HOSTS 는 허용');
  await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, { headers: { Host: 'evil.example', Origin: 'http://evil.example' } });
    w.on('open', () => rej(new Error('rebinding ws accepted')));
    w.on('error', () => res());
  });
  ok('알 수 없는 Host 의 WebSocket 거부');
  await stopWeb(web);
  web = await startWeb({ ALLOWED_HOSTS: '*' });
  assert.strictEqual(await hostStatus('anything.example'), 200); ok('ALLOWED_HOSTS=* 이면 Host 검사 끔');
  await stopWeb(web);
}

async function testSessionAndPush() {
  console.log('[로그인 유지 / 푸시]');
  // 유휴 15초(갱신은 5초 지난 토큰부터), 최대 30초. 서버가 쿠키에 기록한 로그인 시각(t0) 기준으로 기다린다.
  // 지연은 "만료여야 함" 판정에는 안전하고 "유효해야 함" 판정에만 위험 → 유효 판정마다 4초 이상 여유.
  let web = await startWeb({ SESSION_IDLE_MIN: '0.25', SESSION_MAX_HOURS: String(30 / 3600) });
  const first = await login({ password: 'testpassword' });
  const t0 = Number(first.cookie.split('=')[1].split('.')[1]);
  const at = (sec) => new Promise((res) => setTimeout(res, Math.max(0, t0 + sec * 1000 - Date.now())));
  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
  const getHosts = (ck) => fetch(base + '/api/hosts', { headers: { Cookie: ck } });
  await at(7);                                   // 첫 쿠키 만료 t0+15 (여유 8초)
  const st = await fetch(base + '/api/status', { headers: { Cookie: first.cookie } });
  assert(st.status === 200 && !st.headers.get('set-cookie')); ok('주기적 상태 조회는 로그인을 연장하지 않음');
  let r = await getHosts(first.cookie);
  const renewed = cookieOf(r);
  assert(r.status === 200 && renewed.startsWith('wssh=') && renewed !== first.cookie); ok('활동하면 새 만료 시각으로 쿠키 갱신');
  await at(17);                                  // 첫 쿠키는 만료, 갱신 쿠키는 t0+22 까지 (여유 5초)
  assert.strictEqual((await getHosts(first.cookie)).status, 401); ok('갱신 안 된 쿠키는 유휴 시간 후 만료');
  r = await getHosts(renewed);
  assert.strictEqual(r.status, 200); ok('갱신된 쿠키는 유효 (쓰는 동안 연장)');
  let c = cookieOf(r) || renewed;
  for (const sec of [21, 26]) { await at(sec); r = await getHosts(c); assert.strictEqual(r.status, 200, `t0+${sec}`); c = cookieOf(r) || c; }
  await at(32);                                  // 최대 기간 t0+30
  r = await getHosts(c);
  assert.strictEqual(r.status, 401, '최대 기간 초과'); ok('계속 써도 최대 기간이 지나면 만료');
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: c } })).json();
  assert.strictEqual(me.authed, false);
  await stopWeb(web);

  // 푸시
  web = await startWeb({});
  const { cookie } = await login({ password: 'testpassword' });
  const A = { Cookie: cookie };
  const info = await (await fetch(base + '/api/push', { headers: A })).json();
  assert(info.publicKey && info.publicKey.length > 60 && Array.isArray(info.subs) && info.token.exists === false); ok('VAPID 공개키 생성');
  const fakeKeys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  r = await post('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example/push', keys: fakeKeys } }, A);
  assert.strictEqual(r.status, 400); ok('알 수 없는 푸시 서버 주소 거부 (SSRF 방지)');
  r = await post('/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: fakeKeys }, label: 'Android · Chrome' }, A);
  const sub = await r.json();
  assert(r.status === 200 && sub.id && sub.service === 'fcm.googleapis.com'); ok('FCM 구독 등록');
  r = await fetch(base + '/api/push/subs/' + sub.id, { method: 'DELETE', headers: { ...H, ...A } });
  assert((await r.json()).ok); ok('구독 삭제');

  r = await post('/api/notify', { hook_event_name: 'Stop' });
  assert.strictEqual(r.status, 401); ok('토큰 없는 알림 요청 거부');
  assert.strictEqual((await post('/api/push/token', {}, A)).status, 404); ok('토큰을 브라우저로 돌려주는 API 없음 (한 줄 설치 / CLI 로만 발급)');
  const issueCli = () => require('child_process').execFileSync(process.execPath, [path.join(APP, 'bin/notify-token.js')], {
    env: { ...process.env, APP_PASSWORD: 'testpassword', DATA_DIR: web.dataDir, SECRET_KEY: '' },
  }).toString().trim();
  const token = issueCli();
  assert(/^wsn_/.test(token));
  r = await post('/api/notify', { hook_event_name: 'Stop', cwd: '/home/u/proj' }, { Authorization: 'Bearer ' + token });
  assert.deepStrictEqual(await r.json(), { sent: 0, removed: 0, failed: 0 }); ok('토큰으로 알림 요청 (구독 0대)');
  r = await post('/api/notify', {}, { Authorization: 'Bearer ' + token, Cookie: '' });
  assert.strictEqual(r.status, 200);
  r = await post('/api/notify', {}, { Authorization: 'Bearer wsn_wrong' });
  assert.strictEqual(r.status, 401); ok('틀린 토큰 거부');
  assert.strictEqual((await fetch(base + '/api/hosts', { headers: { Authorization: 'Bearer ' + token } })).status, 401); ok('알림 토큰으로는 다른 API 사용 불가');

  // CLI 발급 → 실행 중 서버에 바로 반영, 기존 토큰도 유지 (여러 PC)
  const out = require('child_process').execFileSync(process.execPath, [path.join(APP, 'bin/notify-token.js'), 'PC-B'], {
    env: { ...process.env, APP_PASSWORD: 'testpassword', DATA_DIR: web.dataDir, SECRET_KEY: '' },
  }).toString().trim();
  assert(/^wsn_/.test(out) && out !== token);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + token })).status, 200);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + out })).status, 200); ok('토큰 여러 개 공존 (PC A 를 설치해도 PC B 알림이 끊기지 않음)');
  let pinfo = await (await fetch(base + '/api/push', { headers: A })).json();
  assert(pinfo.tokens.some((x) => x.label === 'PC-B') && pinfo.tokens.every((x) => !('hash' in x))); ok('설정 화면 토큰 목록 (해시는 내보내지 않음)');
  const pcB = pinfo.tokens.find((x) => x.label === 'PC-B');
  r = await fetch(base + '/api/push/tokens/' + pcB.id, { method: 'DELETE', headers: { ...H, ...A } });
  assert((await r.json()).ok);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + out })).status, 401); ok('토큰 개별 삭제');
  // 한 줄 설치: 1회용 코드 → curl | sh → 스크립트 + 훅 등록 + 새 토큰
  const fakeHome = newDataDir();
  fs.mkdirSync(path.join(fakeHome, '.claude'));
  fs.writeFileSync(path.join(fakeHome, '.claude/settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } }));
  const { code } = await (await post('/api/push/setup', { hostId: '' }, A)).json();
  const runSetup = (c) => new Promise((resolve) => {
    const p = spawn('sh', ['-c', `curl -fsS -X POST '${base}/api/notify/setup/${c}' | sh`], { env: { ...process.env, HOME: fakeHome } });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('exit', (exitCode) => resolve({ exitCode, o }));
  });
  // GET(링크 미리보기 봇 등)은 코드를 쓰지 않는다
  const peekRes = await (await fetch(`${base}/api/notify/setup/${code}`)).text();
  assert(/POST/.test(peekRes) && /exit 1/.test(peekRes)); ok('설치 주소를 GET 으로 열면 안내만 하고 코드는 그대로');
  let rs = await runSetup(code);
  assert.strictEqual(rs.exitCode, 0, rs.o); assert(/연동 완료/.test(rs.o));
  const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
  assert.strictEqual(settings.theme, 'dark');
  assert.deepStrictEqual(settings.hooks.Stop.map((g) => g.hooks[0].command), ['echo keep', 'sh ~/.claude/web-ssh-notify.sh']);
  assert.strictEqual(settings.hooks.Notification[0].hooks[0].command, 'sh ~/.claude/web-ssh-notify.sh');
  assert(fs.existsSync(path.join(fakeHome, '.claude/settings.json.bak.web-ssh')));
  const script = fs.readFileSync(path.join(fakeHome, '.claude/web-ssh-notify.sh'), 'utf8');
  const newTok = script.match(/Bearer (wsn_[A-Za-z0-9_-]+)/)[1];
  assert.notStrictEqual(newTok, out);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + newTok })).status, 200);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + token })).status, 200); // 다른 PC 토큰은 그대로
  ok('한 줄 설치: 스크립트 생성 · 기존 설정 보존하며 훅 추가 · 새 토큰 발급 (다른 PC 토큰 유지)');
  rs = await runSetup(code);
  assert.notStrictEqual(rs.exitCode, 0); assert(/만료|이미 사용/.test(rs.o)); ok('설치 코드는 1회용');
  // 다시 설치해도 훅이 중복되지 않음
  const { code: code2 } = await (await post('/api/push/setup', {}, A)).json();
  rs = await runSetup(code2);
  const s2 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude/settings.json'), 'utf8'));
  assert.strictEqual(s2.hooks.Stop.length, 2); assert.strictEqual(s2.hooks.Notification.length, 1); ok('재설치 시 훅 중복 없음 (토큰만 교체)');
  const tok2 = fs.readFileSync(path.join(fakeHome, '.claude/web-ssh-notify.sh'), 'utf8').match(/Bearer (wsn_[A-Za-z0-9_-]+)/)[1];
  assert(/이전 알림 토큰을 폐기/.test(rs.o), rs.o);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + newTok })).status, 401);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + tok2 })).status, 200); ok('같은 PC 재설치 → 그 PC 의 이전 토큰만 폐기');

  assert.strictEqual((await fetch(base + '/sw.js')).status, 200);
  assert.strictEqual((await fetch(base + '/icon-192.png')).status, 200); ok('서비스 워커 / 아이콘 제공');
  await stopWeb(web);

  // 훅 JSON → 알림 내용 (대화 내용 미포함)
  process.env.APP_PASSWORD = 'testpassword';
  process.env.DATA_DIR = newDataDir();
  const push = require('../lib/push');
  let p = push.fromHook({ hook_event_name: 'Stop', cwd: '/mnt/c/dev/git/web-ssh/', session_id: 's1', transcript_path: '/secret/t.jsonl' }, { id: 'h1', name: 'PC-WSL' });
  assert.deepStrictEqual(p, { title: 'PC-WSL · web-ssh', body: '✅ 작업을 마쳤습니다', url: './#/term/h1', tag: 'claude-h1-s1' });
  p = push.fromHook({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', cwd: 'C:\\dev\\app' }, null);
  assert(p.title === 'Claude · app' && p.body.includes('permission') && !JSON.stringify(p).includes('secret')); ok('훅 → 알림 내용 변환 (대화 내용 제외)');
}

// ── 소프트웨어 인증기 (WebAuthn 테스트용: P-256, fmt none) ──
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
function softAuthenticator(origin, rpID) {
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const b64u = (b) => Buffer.from(b).toString('base64url');
  let counter = 0;
  const flagsAndCount = (flags) => { const b = Buffer.alloc(5); b[0] = flags; b.writeUInt32BE(counter, 1); return b; };
  return {
    id: b64u(credId),
    create(opts, { uv = true } = {}) {
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(rpID), flagsAndCount(0x41 | (uv ? 0x04 : 0)), Buffer.alloc(16), len, credId, cose]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin, crossOrigin: false }));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] } };
    },
    get(opts, { uv = true } = {}) {
      counter++;
      const authData = Buffer.concat([sha(rpID), flagsAndCount(0x01 | (uv ? 0x04 : 0))]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin, crossOrigin: false }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: undefined } };
    },
  };
}

async function testPasskey() {
  console.log('[패스키]');
  const web = await startWeb({ PASSKEY_ORIGINS: base });
  const { cookie } = await login({ password: 'testpassword' });
  const A = { Cookie: cookie };
  let me = await (await fetch(base + '/api/me')).json();
  assert.strictEqual(me.passkey.count, 0);
  assert.strictEqual((await post('/api/passkey/register/options', {})).status, 401); ok('로그인 없이 등록 불가');

  const dev = softAuthenticator(base, '127.0.0.1');
  let o = await (await post('/api/passkey/register/options', {}, A)).json();
  assert(o.challenge && o.authenticatorSelection.userVerification === 'required');
  let r = await post('/api/passkey/register/verify', { response: dev.create(o), label: 'Android · Chrome' }, A);
  const reg = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(reg)); assert.strictEqual(reg.label, 'Android · Chrome'); ok('패스키 등록 (사용자 확인 포함)');

  const noUv = softAuthenticator(base, '127.0.0.1');
  o = await (await post('/api/passkey/register/options', {}, A)).json();
  r = await post('/api/passkey/register/verify', { response: noUv.create(o, { uv: false }) }, A);
  assert.strictEqual(r.status, 400); ok('지문/PIN 확인 없는 등록 거부');

  me = await (await fetch(base + '/api/me')).json();
  assert.strictEqual(me.passkey.count, 1);
  o = await (await post('/api/passkey/login/options', {})).json();
  const assertion = dev.get(o);
  r = await post('/api/passkey/login/verify', { response: assertion });
  assert.strictEqual(r.status, 200, await r.clone().text());
  const pkCookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.strictEqual((await fetch(base + '/api/hosts', { headers: { Cookie: pkCookie } })).status, 200); ok('패스키로 로그인 (비밀번호·OTP 없이)');
  assert.strictEqual((await post('/api/passkey/login/verify', { response: assertion })).status, 401); ok('같은 서명 재사용(재전송) 거부');
  o = await (await post('/api/passkey/login/options', {})).json();
  assert.strictEqual((await post('/api/passkey/login/verify', { response: dev.get(o, { uv: false }) })).status, 401); ok('사용자 확인 없는 서명 거부');
  o = await (await post('/api/passkey/login/options', {})).json();
  const other = softAuthenticator(base, '127.0.0.1');
  assert.strictEqual((await post('/api/passkey/login/verify', { response: other.get(o) })).status, 401); ok('등록 안 된 패스키 거부');
  r = await fetch(base + '/api/passkey/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.strictEqual(r.status, 400); ok('허용 안 된 주소(origin)에서는 패스키 사용 불가');

  r = await fetch(base + '/api/passkey/' + encodeURIComponent(reg.id), { method: 'DELETE', headers: { ...H, ...A } });
  assert((await r.json()).ok);
  o = await (await post('/api/passkey/login/options', {})).json();
  assert.strictEqual((await post('/api/passkey/login/verify', { response: dev.get(o) })).status, 401); ok('삭제한 패스키로는 로그인 불가');
  await stopWeb(web);
}

// Host 헤더를 직접 지정하는 요청 (fetch 는 Host 를 바꿀 수 없음)
function rawRequest(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port: WEB_PORT, method, path: pathname, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testReview3() {
  console.log('[터미널 세션 만료 / 공개 주소 / 횟수 제한]');
  // 유휴 3초: 조작 없는 터미널은 서버가 닫음, 전체 로그아웃은 즉시 닫음
  let web = await startWeb({ SESSION_IDLE_MIN: '0.1' });
  let { cookie } = await login({ password: 'testpassword' });
  const hst = await (await post('/api/hosts', { name: 'h', host: '127.0.0.1', port: SSH_PORT, username: 'test', authType: 'password', password: 'secret' }, { Cookie: cookie })).json();
  const openWs = (ck) => new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`, { headers: { Cookie: ck, Origin: base } });
    const msgs = [];
    w.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d)); });
    w.on('open', () => resolve({ w, msgs, closed: new Promise((r) => w.on('close', (code) => r(code))) }));
  });
  let c1 = await openWs(cookie);
  const t0 = Date.now();
  // 활동 신호를 계속 보내면 유지
  const keep = setInterval(() => c1.w.readyState === 1 && c1.w.send(JSON.stringify({ t: 'active' })), 1000);
  // 터미널 자동 응답(입력 'i')은 활동이 아니다 — 보내도 유휴 판정에 영향 없음
  const noise = setInterval(() => c1.w.readyState === 1 && c1.w.send(JSON.stringify({ t: 'i', d: '\x1b[1;1R' })), 500);
  await new Promise((r) => setTimeout(r, 8000));
  assert.strictEqual(c1.w.readyState, 1); ok('조작(활동 신호)이 있으면 유휴 시간이 지나도 터미널 유지');
  clearInterval(keep);
  const tStop = Date.now();
  const code1 = await c1.closed;
  clearInterval(noise);
  assert.strictEqual(code1, 4001); assert(c1.msgs.some((m) => m.t === 'error' && /오래 사용하지 않아/.test(m.msg)));
  assert(Date.now() - tStop >= 4000, '자동 응답이 활동으로 계산되면 안 됨'); ok('조작 없이 유휴 시간이 지나면 서버가 터미널을 닫음 (자동 응답은 활동 아님)');
  await stopWeb(web);

  web = await startWeb({});
  ({ cookie } = await login({ password: 'testpassword' }));
  const c2 = await openWs(cookie);
  const c3 = await openWs(cookie);
  const t1 = Date.now();
  await post('/api/security/logout-all', {}, { Cookie: cookie });
  assert.strictEqual(await c2.closed, 4001); assert.strictEqual(await c3.closed, 4001);
  assert(Date.now() - t1 < 1500 && c2.msgs.some((m) => m.t === 'error' && /전체 로그아웃/.test(m.msg))); ok('전체 로그아웃 → 열린 터미널 모두 즉시 끊김');
  await stopWeb(web);

  // PUBLIC_ORIGIN 으로 들어온 요청: 설치 스크립트는 https 공개 주소, 쿠키는 Secure
  web = await startWeb({ TRUST_PROXY: '1', PUBLIC_ORIGIN: 'https://ws.example.com' });
  const PX = { Host: 'ws.example.com', 'X-Real-IP': '192.168.0.10' }; // 같은 장비 프록시를 거친 내부망 접속
  const lg = await rawRequest('POST', '/api/login', { ...PX, 'Content-Type': 'application/json' }, JSON.stringify({ password: 'testpassword' }));
  const setCookie = String(lg.headers['set-cookie']);
  assert(/Secure/.test(setCookie), setCookie); ok('PUBLIC_ORIGIN(https) 으로 들어온 로그인 → Secure 쿠키 (X-Forwarded-Proto 없어도)');
  const ck = setCookie.split(';')[0];
  const sc = await rawRequest('POST', '/api/push/setup', { ...PX, 'Content-Type': 'application/json', Origin: 'https://ws.example.com', Cookie: ck }, '{}');
  const { code } = JSON.parse(sc.body);
  const scr = await rawRequest('POST', `/api/notify/setup/${code}`, PX);
  assert(scr.body.includes("'https://ws.example.com/api/notify'") && !scr.body.includes('http://ws.example.com'), scr.body.slice(0, 400)); ok('설치 스크립트 주소에 https 공개 주소 사용');
  const lgLan = await login({ password: 'testpassword' }, { 'X-Real-IP': '192.168.0.10' });
  assert(lgLan.status === 200);
  await stopWeb(web);

  // 패스키 로그인 옵션: IP 당 분당 20회
  web = await startWeb({ PASSKEY_ORIGINS: base });
  const codes = [];
  for (let i = 0; i < 23; i++) codes.push((await post('/api/passkey/login/options', {})).status);
  assert(codes.slice(0, 20).every((c) => c === 200) && codes.slice(20).every((c) => c === 429), codes.join(',')); ok('패스키 로그인 옵션 요청 IP 당 분당 20회 제한');
  await stopWeb(web);

  // 이전 형식 토큰 파일 자동 변환
  const dir = newDataDir();
  const crypto = require('crypto');
  const oldTok = 'wsn_' + 'x'.repeat(32);
  fs.writeFileSync(path.join(dir, 'notify-token.json'), JSON.stringify({ hash: crypto.createHash('sha256').update(oldTok).digest('hex'), created: 1 }));
  web = await startWeb({}, dir);
  assert.strictEqual((await post('/api/notify', {}, { Authorization: 'Bearer ' + oldTok })).status, 200); ok('이전 형식(토큰 1개) 파일도 그대로 동작');
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
    await testReview2();
    await testSessionAndPush();
    await testPasskey();
    await testReview3();
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
