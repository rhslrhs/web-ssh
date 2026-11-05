'use strict';
const net = require('net');

// ::ffff:192.168.1.10 → 192.168.1.10
const normalize = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!net.isIPv4(base) || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

const PRIVATE4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'];

// LAN / VPN / 루프백 / CGNAT(Tailscale 등) 주소인가
function isPrivate(ipRaw) {
  const ip = normalize(ipRaw);
  if (net.isIPv4(ip)) return PRIVATE4.some((c) => inCidr4(ip, c));
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return false;
}

const isLoopback = (ipRaw) => {
  const ip = normalize(ipRaw);
  return ip === '::1' || (net.isIPv4(ip) && inCidr4(ip, '127.0.0.0/8'));
};

// "1.2.3.4, 5.6.7.0/24" → 매칭 함수 (IPv4 / 정확한 IPv6)
function parseAllowList(spec) {
  const items = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  for (const it of items) {
    if (!(net.isIPv4(it.split('/')[0]) || net.isIPv6(it))) throw new Error(`ALLOW_PUBLIC_IPS 형식 오류: ${it}`);
  }
  return (ipRaw) => {
    const ip = normalize(ipRaw);
    return items.some((it) => (net.isIPv4(ip) ? inCidr4(ip, it) : it.toLowerCase() === ip.toLowerCase()));
  };
}

module.exports = { normalize, isPrivate, isLoopback, parseAllowList, inCidr4 };
