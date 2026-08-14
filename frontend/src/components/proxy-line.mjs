const VALID_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

const validPort = value => {
  const port = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535;
};

const decoded = value => {
  try { return decodeURIComponent(value); } catch { return value; }
};

// Accept host:port[:user:password], bracketed IPv6, or an explicit Playwright proxy URL. Passwords
// may contain colons; only the first three separators have structural meaning.
export function parseProxyLine(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!VALID_PROXY_PROTOCOLS.has(url.protocol) || !url.hostname || !validPort(url.port)) return null;
      const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
      return {
        server: `${url.protocol}//${host}:${url.port}`,
        username: decoded(url.username || ''),
        password: decoded(url.password || ''),
      };
    } catch { return null; }
  }

  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/);
  if (ipv6) {
    if (!validPort(ipv6[2])) return null;
    return { server: `[${ipv6[1]}]:${ipv6[2]}`, username: ipv6[3] || '', password: ipv6[4] || '' };
  }

  const parts = value.split(':');
  const host = parts.shift() || '';
  const port = parts.shift() || '';
  if (!host || !validPort(port)) return null;
  const username = parts.shift() || '';
  return { server: `${host}:${port}`, username, password: parts.join(':') };
}
