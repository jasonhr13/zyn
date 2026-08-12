import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { counts, recentEvents } from './db.js';
import { proxyPool } from './proxy.js';
import { log } from './log.js';

// Bundled Zyn icon, served publicly so Discord can fetch it for the bot avatar.
let icon = null;
try {
  icon = readFileSync(new URL('../assets/icon.png', import.meta.url));
} catch {
  log.warn('icon.png not found — brand avatar unavailable');
}

// Minimal admin/health surface (no framework). /health is open for Fly checks;
// everything else requires the admin token when one is configured.
export function startServer({ scheduler, startedAt }) {
  const authed = (req) =>
    !config.adminToken || req.headers['authorization'] === `Bearer ${config.adminToken}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/icon.png') {
      if (!icon) return send(404, { error: 'no icon' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(icon);
    }

    if (url.pathname === '/health') {
      const s = scheduler.stats;
      return send(200, {
        ok: true,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        watching: scheduler.size(),
        ...counts(),
        polls: s.polls,
        last_poll_age_s: s.lastPollAt ? Math.floor((Date.now() - s.lastPollAt) / 1000) : null,
        soft_blocks: s.softBlocks,
        errors: s.errors,
        proxies: proxyPool.status(),
      });
    }

    if (!authed(req)) return send(401, { error: 'unauthorized' });

    if (url.pathname === '/events') {
      return send(200, recentEvents(Number(url.searchParams.get('limit') ?? 50)));
    }

    return send(404, { error: 'not found' });
  });

  server.listen(config.port, () => log.info({ port: config.port }, 'admin server listening'));
  return server;
}
