import { connect as connectTls } from 'node:tls';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { SocksClient } from 'socks';

const CLAUDE_PROXY_AGENTS = new Map();
const MAX_CLAUDE_PROXY_AGENTS = 32;

// CPA applies a Claude credential's proxy to both inference and OAuth control
// plane calls. Keep one bounded dispatcher cache so profile/refresh requests
// use the same egress without creating a new socket pool per request.
export function claudeProxyDispatcher(proxyUrl) {
  const raw = typeof proxyUrl === 'string' ? proxyUrl.trim() : '';
  if (!raw || raw.length > 2_048) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname) return null;
  const key = parsed.toString();
  let dispatcher = CLAUDE_PROXY_AGENTS.get(key);
  if (!dispatcher) {
    dispatcher = ['socks5:', 'socks5h:'].includes(parsed.protocol)
      ? new UndiciAgent({ connect: claudeSocksConnector(parsed) })
      : new ProxyAgent(key);
    CLAUDE_PROXY_AGENTS.set(key, dispatcher);
    if (CLAUDE_PROXY_AGENTS.size > MAX_CLAUDE_PROXY_AGENTS) {
      const oldest = CLAUDE_PROXY_AGENTS.keys().next().value;
      const evicted = CLAUDE_PROXY_AGENTS.get(oldest);
      CLAUDE_PROXY_AGENTS.delete(oldest);
      try {
        const closing = evicted?.close?.();
        if (closing?.catch) void closing.catch(() => {});
      } catch {}
    }
  }
  return dispatcher;
}

function claudeSocksConnector(proxy) {
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
  const userId = decodeProxyComponent(proxy.username);
  const password = decodeProxyComponent(proxy.password);
  const proxyPort = Number(proxy.port || 1080);
  return (options, callback) => {
    const destinationHost = options.hostname || options.host;
    const destinationPort = Number(options.port || (options.protocol === 'https:' ? 443 : 80));
    if (!destinationHost || !Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
      callback(new Error('invalid Claude SOCKS destination'), null);
      return;
    }
    SocksClient.createConnection({
      proxy: {
        host: proxyHost,
        port: proxyPort,
        type: 5,
        ...(userId ? { userId } : {}),
        ...(password ? { password } : {})
      },
      command: 'connect',
      destination: { host: destinationHost, port: destinationPort },
      timeout: 30_000,
      set_tcp_nodelay: true
    }).then(({ socket }) => {
      if (options.protocol !== 'https:') {
        callback(null, socket);
        return;
      }
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(error, null);
      };
      const tlsSocket = connectTls({
        socket,
        servername: options.servername || destinationHost,
        ALPNProtocols: ['http/1.1']
      });
      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        tlsSocket.off('error', fail);
        callback(null, tlsSocket);
      });
    }).catch((error) => callback(error, null));
  };
}

function decodeProxyComponent(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch { return value; }
}
