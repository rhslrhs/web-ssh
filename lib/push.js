'use strict';
// Web Push (VAPID). 구독 정보와 VAPID 키는 data/push.json 에 저장 (개인키는 봉인).
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const config = require('./config');
const { seal, open } = require('./seal');
const { readJson, writeJsonAtomic } = require('./jsonfile');

const FILE = path.join(config.DATA_DIR, 'push.json');
const VAPID_LABEL = 'push:vapid';
let db = readJson(FILE, { vapid: null, subs: [] });
const save = () => writeJsonAtomic(FILE, db);

if (!db.vapid) {
  const k = webpush.generateVAPIDKeys();
  db.vapid = { publicKey: k.publicKey, privateKey: seal(k.privateKey, VAPID_LABEL) };
  save();
}
// VAPID subject 는 https URL 또는 mailto 여야 한다 (Apple 은 형식을 엄격히 검사)
const subject = process.env.PUSH_SUBJECT || config.PUBLIC_ORIGIN || 'mailto:web-ssh@example.com';
webpush.setVapidDetails(subject, db.vapid.publicKey, open(db.vapid.privateKey, VAPID_LABEL));

// 서버가 임의 주소로 요청을 보내지 않도록 알려진 푸시 서비스만 허용 (SSRF 방지)
const PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/,       // Chrome / Android / 삼성 인터넷 (FCM)
  /(^|\.)push\.apple\.com$/,      // Safari / iOS
  /(^|\.)mozilla\.com$/,          // Firefox
  /(^|\.)notify\.windows\.com$/,  // Edge (WNS)
];
class PushError extends Error {}

function validate(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw new PushError('구독 정보가 올바르지 않습니다');
  let u;
  try { u = new URL(sub.endpoint); } catch { throw new PushError('구독 주소가 올바르지 않습니다'); }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) throw new PushError('지원하지 않는 푸시 서비스입니다: ' + u.hostname);
  const { p256dh, auth } = sub.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) throw new PushError('구독 키가 올바르지 않습니다');
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

const view = (s) => ({ id: s.id, label: s.label, created: s.created, service: new URL(s.endpoint).hostname });

function subscribe(sub, label) {
  const v = validate(sub);
  const existing = db.subs.find((s) => s.endpoint === v.endpoint);
  if (existing) {
    existing.keys = v.keys;
    existing.label = String(label || existing.label).slice(0, 60);
    save();
    return view(existing);
  }
  if (db.subs.length >= 20) throw new PushError('등록 기기가 너무 많습니다 (최대 20). 안 쓰는 기기를 삭제하세요.');
  const s = { id: crypto.randomBytes(6).toString('hex'), ...v, label: String(label || '기기').slice(0, 60), created: Date.now() };
  db.subs.push(s);
  save();
  return view(s);
}

function remove(id) {
  const n = db.subs.length;
  db.subs = db.subs.filter((s) => s.id !== id);
  if (db.subs.length !== n) save();
  return db.subs.length !== n;
}

// 모든 기기에 발송. 만료된 구독(404/410)은 자동 삭제.
async function send(payload) {
  const body = JSON.stringify(payload);
  const results = await Promise.all(db.subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600, urgency: 'high' })
      .then(() => 'sent', (e) => (e.statusCode === 404 || e.statusCode === 410 ? (remove(s.id), 'removed') : (console.warn(`[web-ssh] 푸시 실패 (${s.label}): ${e.statusCode || e.message}`), 'failed')))));
  const count = (k) => results.filter((r) => r === k).length;
  return { sent: count('sent'), removed: count('removed'), failed: count('failed') };
}

// Claude Code 훅 입력(JSON) → 알림 내용. 대화 내용(transcript)은 보내지 않는다.
function fromHook(body, host) {
  const b = body && typeof body === 'object' ? body : {};
  const ev = String(b.hook_event_name || b.event || '');
  const cwd = String(b.cwd || '');
  // Windows 에서 실행된 Claude 는 C:\\dev\\app 형태 → / 와 \\ 모두 구분자로 처리
  const project = cwd.split(/[\\/]+/).filter(Boolean).pop() || '';
  const title = [host ? host.name : 'Claude', project].filter(Boolean).join(' · ');
  let text;
  if (ev === 'Stop' || ev === 'SubagentStop') text = '✅ 작업을 마쳤습니다';
  else if (ev === 'Notification') text = '🔔 ' + (String(b.message || '') || '입력을 기다리고 있습니다');
  else text = String(b.message || b.body || '알림');
  const sid = String(b.session_id || '').slice(0, 40);
  return {
    title: title.slice(0, 80),
    body: text.slice(0, 180),
    url: host ? `./#/term/${encodeURIComponent(host.id)}` : './',
    tag: `claude-${host ? host.id : 'x'}-${sid}`, // 같은 세션 알림은 하나로 갱신
  };
}

module.exports = {
  PushError,
  publicKey: () => db.vapid.publicKey,
  list: () => db.subs.map(view),
  subscribe, remove, send, fromHook,
};
