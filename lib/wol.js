'use strict';
const dgram = require('dgram');

// Wake-on-LAN 매직 패킷: FF x6 + MAC x16. 포트 9, 7 로 3회 전송.
function wake(mac, broadcast) {
  const m = Buffer.from(mac.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  if (m.length !== 6) return Promise.reject(new Error('MAC 주소가 올바르지 않습니다'));
  const pkt = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(pkt, 6 + i * 6);

  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => { s.close(); reject(e); });
    s.bind(() => {
      s.setBroadcast(true);
      const sends = [];
      for (let i = 0; i < 3; i++) {
        for (const port of [9, 7]) {
          sends.push(new Promise((res, rej) => s.send(pkt, port, broadcast, (e) => (e ? rej(e) : res()))));
        }
      }
      Promise.all(sends).then(() => { s.close(); resolve(); }, (e) => { s.close(); reject(e); });
    });
  });
}

module.exports = { wake };
