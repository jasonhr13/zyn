import { ProxyAgent, Agent } from 'undici';
import { config } from './config.js';
import { log } from './log.js';

const COOLDOWN_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 3;

const redact = (u) => u.replace(/\/\/[^@/]*@/, '//***@');

// Rotating pool of ISP proxies. Each lease returns an undici dispatcher for the
// next healthy proxy plus a mark(ok) callback to record the outcome. With no
// proxies configured it falls back to a direct connection (the Fly machine IP).
class ProxyPool {
  constructor(urls) {
    this.entries = urls.map((url) => ({ url, agent: new ProxyAgent(url), fails: 0, benchedUntil: 0 }));
    this.direct = new Agent();
    this.i = 0;
    if (this.entries.length === 0) log.warn('no proxies configured — using direct connection');
    else log.info({ count: this.entries.length }, 'proxy pool ready');
  }

  lease() {
    if (this.entries.length === 0) return { dispatcher: this.direct, proxy: 'direct', mark: () => {} };
    const now = Date.now();
    let chosen = null;
    for (let n = 0; n < this.entries.length; n++) {
      const e = this.entries[this.i++ % this.entries.length];
      if (e.benchedUntil <= now) { chosen = e; break; }
    }
    if (!chosen) chosen = this.entries[this.i++ % this.entries.length]; // all benched: use anyway
    const e = chosen;
    return {
      dispatcher: e.agent,
      proxy: redact(e.url),
      mark: (ok) => {
        if (ok) { e.fails = 0; return; }
        if (++e.fails >= FAIL_THRESHOLD) {
          e.benchedUntil = Date.now() + COOLDOWN_MS;
          e.fails = 0;
          log.warn({ proxy: redact(e.url) }, 'proxy benched (cooldown)');
        }
      },
    };
  }

  status() {
    const now = Date.now();
    return {
      total: this.entries.length,
      benched: this.entries.filter((e) => e.benchedUntil > now).length,
    };
  }
}

export const proxyPool = new ProxyPool(config.proxies);
