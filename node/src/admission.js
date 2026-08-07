import { isIP } from 'node:net';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function admissionPolicy(input = {}) {
  return {
    allowedHosts: values(input.allowedHosts ?? input.hosts ?? process.env.CODEX_POOLER_ALLOWED_HOSTS, LOCAL_HOSTS).map(hostname),
    allowedOrigins: values(input.allowedOrigins ?? process.env.CODEX_POOLER_ALLOWED_ORIGINS, []),
    firewallAllowlist: values(input.firewallAllowlist ?? input.firewall_allowlist ?? process.env.CODEX_POOLER_FIREWALL_ALLOWLIST, []),
    trustedProxies: values(input.trustedProxies ?? input.trusted_proxies ?? process.env.CODEX_POOLER_TRUSTED_PROXIES, [])
  };
}

export function hostAllowed(host, policy) {
  const value = hostname(host);
  return Boolean(value) && policy.allowedHosts.includes(value);
}

export function localHost(host) {
  return LOCAL_HOSTS.includes(hostname(host));
}

export function originAllowed(origin, host, policy) {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && (policy.allowedOrigins.includes(parsed.origin) || parsed.host === host && hostAllowed(host, policy));
  } catch {
    return false;
  }
}

export function firewallAllowed(req, policy) {
  if (!policy.firewallAllowlist.length) return true;
  return matches(clientIp(req, policy), policy.firewallAllowlist);
}

export function clientIp(req, policy) {
  const peer = address(req.socket?.remoteAddress);
  if (!peer || !matches(peer, policy.trustedProxies)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(address).filter(Boolean).reverse().find((ip) => !matches(ip, policy.trustedProxies));
  return forwarded || address(req.headers['x-real-ip']) || peer;
}

function values(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value)) throw new Error('admission values must be an array or comma-separated string');
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function hostname(value) {
  if (typeof value !== 'string' || !value) return '';
  try { return new URL(`http://${value}`).hostname.toLowerCase(); } catch { return ''; }
}

function matches(ip, rules) {
  return Boolean(ip) && rules.some((rule) => matchesRule(ip, rule));
}

function matchesRule(ip, rule) {
  const [network, prefixText, extra] = String(rule).trim().split('/');
  if (extra !== undefined) return false;
  const target = ipValue(ip);
  const base = ipValue(network);
  if (!target || !base || target.bits !== base.bits) return false;
  if (prefixText === undefined) return target.value === base.value;
  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix > target.bits) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(target.bits - prefix);
  return (target.value & mask) === (base.value & mask);
}

function address(value) {
  const candidate = String(value || '').trim();
  return isIP(candidate) ? candidate : null;
}

function ipValue(ip) {
  const family = isIP(ip);
  if (family === 4) return { bits: 32, value: ip.split('.').reduce((value, part) => value * 256n + BigInt(part), 0n) };
  if (family !== 6) return null;
  const [left, right = ''] = ip.toLowerCase().split('::');
  let parts = left ? left.split(':') : [];
  const suffix = right ? right.split(':') : [];
  const expandV4 = (items) => items.flatMap((part) => part.includes('.') ? ipValue(part).value.toString(16).padStart(8, '0').match(/.{1,4}/g) : [part]);
  parts = expandV4(parts);
  const rightParts = expandV4(suffix);
  parts.push(...Array(8 - parts.length - rightParts.length).fill('0'), ...rightParts);
  if (parts.length !== 8) return null;
  const value = parts.reduce((value, part) => value * 65536n + BigInt(`0x${part || '0'}`), 0n);
  return (value >> 32n) === 0xffffn
    ? { bits: 32, value: value & 0xffffffffn }
    : { bits: 128, value };
}
