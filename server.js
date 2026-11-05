'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./lib/config');
const auth = require('./lib/auth');
const store = require('./lib/store');
const { connectChain, tcpCheck } = require('./lib/ssh');
const wol = require('./lib/wol');
const push = require('./lib/push');
const notifyToken = require('./lib/notifytoken');
const passkey = require('./lib/passkey');

const app = express();
app.disable('x-powered-by');
// 같은 장비의 리버스 프록시(DSM nginx → localhost)만 신뢰 (req.secure 판단용)
if (config.TRUST_PROXY) app.set('trust proxy', 'loopback');

// 외부(공인 IP) 접속 차단 / 허용 목록 — 정적 파일 포함 모든 요청
app.use((req, res, next) => {
  if (auth.networkAllowed(req)) return next();
  res.status(403).type('text').send('Forbidden');
});

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const nm = (p) => path.join(__dirname, 'node_modules', p);
app.use('/vendor/xterm', express.static(nm('@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(nm('@xterm/addon-fit')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '64kb' }));

// ── API ──
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/me', auth.me);

// ── 패스키 로그인 (인증 전) ──
app.post('/api/passkey/login/options', async (req, res) => {
  try { res.json(await passkey.loginOptions(req)); } catch (e) { res.status(e instanceof passkey.PasskeyError ? 400 : 500).json({ error: e.message }); }
});
app.post('/api/passkey/login/verify', auth.loginPasskey);

// ── Claude Code 연동 설치: 화면에서 만든 1회용 코드(10분)로 설치 스크립트를 받는다 ──
//   curl -fsS '<주소>/api/notify/setup/<코드>' | sh
// 실행하면 새 알림 토큰 발급 + ~/.claude/web-ssh-notify.sh 생성 + settings.json 훅 등록 + 테스트 알림
const setupCodes = new Map(); // code -> { until, hostId }
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`; // sh 작은따옴표 인용
app.get('/api/notify/setup/:code', (req, res) => {
  const now = Date.now();
  for (const [c, v] of setupCodes) if (v.until < now) setupCodes.delete(c);
  const entry = setupCodes.get(req.params.code);
  res.type('text/plain; charset=utf-8');
  // curl -f 는 4xx 본문을 버리고 sh 는 빈 입력에 성공(0)하므로, 200 + 실패 스크립트로 안내한다
  if (!entry) return res.send("echo '✗ 설치 코드가 만료되었거나 이미 사용되었습니다. web-ssh ⚙ 설정에서 새로 만드세요.' >&2; exit 1\n");
  setupCodes.delete(req.params.code); // 1회용
  const token = notifyToken.issue();
  const base = `${req.protocol}://${req.headers.host}`;
  const url = `${base}/api/notify${entry.hostId ? `?host=${encodeURIComponent(entry.hostId)}` : ''}`;
  console.log(`[web-ssh] Claude 연동 설치 ${auth.clientIp(req)} (토큰 재발급)`);
  res.send(`#!/bin/sh
# web-ssh: Claude Code 알림 연동 설치
set -e
command -v curl >/dev/null 2>&1 || { echo 'curl 이 필요합니다' >&2; exit 1; }
D="$HOME/.claude"; mkdir -p "$D"
umask 077
cat > "$D/web-ssh-notify.sh" <<'WSSH_EOF'
#!/bin/sh
# Claude Code 훅 → web-ssh 푸시 (재설치: web-ssh ⚙ 설정 → Claude Code 연동)
curl -fsS -m 5 -X POST ${shq(url)} -H ${shq('Authorization: Bearer ' + token)} -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true
WSSH_EOF
chmod 700 "$D/web-ssh-notify.sh"
S="$D/settings.json"
[ -s "$S" ] && cp "$S" "$S.bak.web-ssh"
if command -v python3 >/dev/null 2>&1; then
python3 - "$S" <<'PY_EOF'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
cmd = 'sh ~/.claude/web-ssh-notify.sh'
hooks = s.setdefault('hooks', {})
for ev in ('Stop', 'Notification'):
    arr = hooks.setdefault(ev, [])
    if not any(h.get('command') == cmd for g in arr for h in g.get('hooks', [])):
        arr.append({'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
json.dump(s, open(p, 'w'), indent=2, ensure_ascii=False)
PY_EOF
elif command -v node >/dev/null 2>&1; then
node -e '
const fs = require("fs"), p = process.argv[1];
const s = fs.existsSync(p) && fs.statSync(p).size ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
const cmd = "sh ~/.claude/web-ssh-notify.sh"; s.hooks = s.hooks || {};
for (const ev of ["Stop", "Notification"]) {
  const arr = (s.hooks[ev] = s.hooks[ev] || []);
  if (!arr.some((g) => (g.hooks || []).some((h) => h.command === cmd))) arr.push({ hooks: [{ type: "command", command: cmd, timeout: 10 }] });
}
fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$S"
else
  echo 'python3 또는 node 가 없어 훅을 자동 등록하지 못했습니다. ~/.claude/settings.json 의 hooks 에 Stop/Notification → "sh ~/.claude/web-ssh-notify.sh" 를 추가하세요.' >&2
fi
echo '{"hook_event_name":"Notification","message":"Claude Code 알림 연동 완료"}' | sh "$D/web-ssh-notify.sh"
echo '✓ web-ssh 알림 연동 완료 — 등록된 기기로 테스트 알림을 보냈습니다.'
echo '  새로 시작하는 Claude 세션부터 적용됩니다 (실행 중인 세션은 /hooks 를 한 번 열면 적용).'
`);
});

// ── 외부 스크립트(Claude Code 훅 등) → 푸시. 로그인 쿠키가 아닌 알림 전용 토큰으로 인증 ──
let notifyHits = [];
app.post('/api/notify', async (req, res) => {
  const h = String(req.headers.authorization || '');
  if (!notifyToken.check(h.startsWith('Bearer ') ? h.slice(7).trim() : '')) return res.status(401).json({ error: '알림 토큰이 올바르지 않습니다' });
  const now = Date.now();
  notifyHits = notifyHits.filter((t) => now - t < 60e3);
  if (notifyHits.length >= 30) return res.status(429).json({ error: '알림이 너무 많습니다 (분당 30회)' });
  notifyHits.push(now);
  const host = req.query.host ? store.get(String(req.query.host)) : null;
  try { res.json(await push.send(push.fromHook(req.body, host))); } catch (e) { res.status(500).json({ error: e.message }); }
});

const api = express.Router();
api.use(auth.requireAuth);
const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) {
    res.status(e instanceof store.InputError ? 400 : 500).json({ error: e.message });
  }
};

api.get('/security', auth.securityInfo);
api.post('/security/totp/start', auth.requirePrivate, (req, res) =>
  auth.totpStart(req, res).catch((e) => res.status(500).json({ error: e.message })));
api.post('/security/totp/enable', auth.requirePrivate, auth.totpEnable);
api.post('/security/totp/disable', auth.requirePrivate, auth.totpDisable);
api.post('/security/logout-all', auth.logoutAll);

// ── 패스키 관리 (등록/삭제는 내부망/VPN 에서만) ──
const pkWrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(e instanceof passkey.PasskeyError ? 400 : 500).json({ error: e.message }); }
};
api.get('/passkey', pkWrap(() => ({ creds: passkey.list(), origins: passkey.origins() })));
api.post('/passkey/register/options', auth.requirePrivate, pkWrap((req) => passkey.registrationOptions(req)));
api.post('/passkey/register/verify', auth.requirePrivate, pkWrap((req) => passkey.register(req, (req.body || {}).response, (req.body || {}).label)));
api.delete('/passkey/:id', auth.requirePrivate, pkWrap((req) => ({ ok: passkey.remove(req.params.id) })));

// ── 푸시 구독 관리 ──
const pushWrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(e instanceof push.PushError ? 400 : 500).json({ error: e.message }); }
};
api.get('/push', pushWrap(() => ({ publicKey: push.publicKey(), subs: push.list(), token: notifyToken.info() })));
api.post('/push/subscribe', pushWrap((req) => push.subscribe((req.body || {}).subscription, (req.body || {}).label, (req.body || {}).replaceId)));
api.delete('/push/subs/:id', pushWrap((req) => ({ ok: push.remove(req.params.id) })));
api.post('/push/test', pushWrap(() => push.send({ title: 'Web SSH', body: '테스트 알림입니다 🔔', url: './', tag: 'test' })));
// 설치 코드는 내부망/VPN 에서만. 토큰 자체는 브라우저로 보내지 않는다 (설치 스크립트 / CLI 로만 발급)
api.post('/push/setup', auth.requirePrivate, pushWrap((req) => {
  const code = require('crypto').randomBytes(12).toString('base64url');
  const hostId = String((req.body || {}).hostId || '');
  setupCodes.set(code, { until: Date.now() + 10 * 60e3, hostId: store.get(hostId) ? hostId : '' });
  return { code, expiresMin: 10 };
}));

api.get('/hosts', (req, res) => res.json(store.list()));
api.post('/hosts', wrap((req, res) => res.json(store.create(req.body || {}))));
api.put('/hosts/:id', wrap((req, res) => {
  const h = store.update(req.params.id, req.body || {});
  h ? res.json(h) : res.status(404).json({ error: '없음' });
}));
api.delete('/hosts/:id', wrap((req, res) => res.json({ ok: store.remove(req.params.id) })));
api.post('/hosts/:id/reset-hostkey', (req, res) => {
  if (!store.get(req.params.id)) return res.status(404).json({ error: '없음' });
  store.setHostKey(req.params.id, '');
  res.json({ ok: true });
});

api.post('/hosts/:id/wake', async (req, res) => {
  const h = store.get(req.params.id);
  if (!h || !h.mac) return res.status(400).json({ error: 'MAC 주소가 설정되지 않았습니다' });
  try {
    await wol.wake(h.mac, h.wolBroadcast || config.WOL_BROADCAST);
    console.log(`[web-ssh] WOL → ${h.name} (${h.mac})`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'WOL 전송 실패: ' + e.message }); }
});

// 점프 호스트 경유 대상은 NAS 에서 직접 확인할 수 없으므로 null(알 수 없음)
async function hostStatus(h) {
  return h.jumpId ? null : tcpCheck(h.host, h.port);
}
api.get('/status', async (req, res) => {
  const hosts = store.list();
  const results = await Promise.all(hosts.map(hostStatus));
  res.json(Object.fromEntries(hosts.map((h, i) => [h.id, results[i]])));
});
api.get('/hosts/:id/status', async (req, res) => {
  const h = store.get(req.params.id);
  if (!h) return res.status(404).json({ error: '없음' });
  res.json({ online: await hostStatus(h) });
});
app.use('/api', api);

// ── WebSocket 터미널 ──
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws') return socket.destroy();
  if (!auth.networkAllowed(req) || !auth.isAuthed(req) || !auth.sameOrigin(req, true)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);

wss.on('connection', (ws, req) => {
  const ip = auth.clientIp(req);
  let client = null;
  let stream = null;
  let starting = false;
  let closed = false;
  let seq = 0;
  let cols = 80;
  let rows = 24;
  const pending = new Map();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const ctx = {
    status: (msg) => send({ t: 'status', msg }),
    ask: (kind, payload) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      send({ t: 'ask', id, kind, ...payload });
    }),
  };

  async function start(hostId) {
    starting = true;
    const host = store.get(hostId);
    console.log(`[web-ssh] 접속 시도 ${ip} → ${host ? host.name : hostId}`);
    try {
      client = await connectChain(hostId, ctx);
    } catch (e) {
      console.log(`[web-ssh] 접속 실패 ${ip} → ${host ? host.name : hostId}: ${e.message.split('\n')[0]}`);
      send({ t: 'error', msg: e.message });
      return ws.close();
    }
    if (closed) return client.end();
    client.on('error', (e) => send({ t: 'error', msg: e.message }));
    client.on('close', () => { send({ t: 'closed' }); ws.close(); });
    const pty = { term: 'xterm-256color', cols, rows };
    const onChannel = (err, s) => {
      if (err) { send({ t: 'error', msg: '셸 열기 실패: ' + err.message }); client.end(); return ws.close(); }
      stream = s;
      send({ t: 'ready' });
      const out = (d) => {
        if (ws.readyState !== 1) return;
        ws.send(d, { binary: true });
        // 브라우저가 못 따라오면 잠시 멈춤 (cat 큰 파일 등)
        if (ws.bufferedAmount > 1 << 20 && !s.isPaused()) {
          s.pause();
          const t = setInterval(() => {
            if (ws.readyState !== 1 || ws.bufferedAmount < 1 << 18) { clearInterval(t); s.resume(); }
          }, 50);
        }
      };
      s.on('data', out);
      s.stderr.on('data', out);
      s.on('close', () => client.end());
    };
    // 호스트에 실행 명령이 있으면 셸 대신 PTY 로 그 명령을 실행
    if (host.command) {
      send({ t: 'status', msg: `실행: ${host.command}` });
      client.exec(host.command, { pty }, onChannel);
    } else {
      client.shell(pty, onChannel);
    }
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { if (stream) stream.write(raw); return; }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'i':
        if (stream && typeof m.d === 'string') stream.write(m.d);
        break;
      case 'resize':
        cols = clamp(m.cols, 10, 500, cols);
        rows = clamp(m.rows, 3, 200, rows);
        if (stream) stream.setWindow(rows, cols, 0, 0);
        break;
      case 'answer': {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.resolve(m.value); }
        break;
      }
      case 'connect':
        if (client || starting) return;
        cols = clamp(m.cols, 10, 500, 80);
        rows = clamp(m.rows, 3, 200, 24);
        start(String(m.hostId));
        break;
    }
  });

  ws.on('close', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('closed'));
    pending.clear();
    if (client) client.end();
  });
});

// 끊긴 브라우저 정리 + VPN/NAT 유휴 끊김 방지
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(config.PORT, config.BIND, () => {
  console.log(`[web-ssh] http://${config.BIND}:${config.PORT} 에서 실행 중 (data: ${config.DATA_DIR})`);
});
