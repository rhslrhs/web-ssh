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
