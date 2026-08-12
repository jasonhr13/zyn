import { fetch } from 'undici';
import { config } from './config.js';
import { counts } from './db.js';
import { proxyPool } from './proxy.js';
import { log } from './log.js';

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h ? `${h}h ` : ''}${m}m`;
}

// Periodic health beat to the ops webhook. Green when healthy, red when degraded
// (poll stalled, all proxies benched, or a burst of soft-blocks since last beat).
export function startHeartbeat({ scheduler, startedAt }) {
  if (!config.heartbeat.url) {
    log.info('no ops webhook configured — heartbeat disabled');
    return null;
  }
  let prev = { softBlocks: 0, errors: 0, polls: 0 };

  async function beat() {
    const s = scheduler.stats;
    const c = counts();
    const px = proxyPool.status();
    const lastPollAge = s.lastPollAt ? Math.round((Date.now() - s.lastPollAt) / 1000) : null;
    const d = { sb: s.softBlocks - prev.softBlocks, err: s.errors - prev.errors, polls: s.polls - prev.polls };
    prev = { softBlocks: s.softBlocks, errors: s.errors, polls: s.polls };

    const degraded =
      (lastPollAge != null && lastPollAge > 60) || (px.total > 0 && px.benched >= px.total) || d.sb > 20;

    const embed = {
      username: config.brand.name,
      avatar_url: config.brand.iconUrl || undefined,
      embeds: [
        {
          title: degraded ? '⚠️ Monitor Degraded' : '🟢 Monitor Healthy',
          color: degraded ? 0xed4245 : config.brand.color,
          fields: [
            { name: 'Uptime', value: fmtDuration(Date.now() - startedAt), inline: true },
            { name: 'Watching', value: `${c.enrolled} · ${c.hot}🔥 / ${c.warm}💤`, inline: true },
            { name: 'In Stock', value: String(c.in_stock), inline: true },
            { name: 'Polls', value: `${s.polls} (+${d.polls})`, inline: true },
            { name: 'Proxies', value: `${px.total - px.benched}/${px.total} healthy`, inline: true },
            { name: 'Last Poll', value: lastPollAge != null ? `${lastPollAge}s ago` : 'n/a', inline: true },
            { name: 'Soft Blocks', value: `${s.softBlocks} (+${d.sb})`, inline: true },
            { name: 'Errors', value: `${s.errors} (+${d.err})`, inline: true },
            { name: 'Events', value: String(c.events), inline: true },
          ],
          footer: { text: config.brand.footer, icon_url: config.brand.iconUrl || undefined },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      const res = await fetch(config.heartbeat.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(embed),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      log.warn({ err: String(err) }, 'heartbeat post failed');
    }
  }

  beat(); // immediate beat on boot confirms the deploy is healthy
  return setInterval(beat, config.heartbeat.intervalMs);
}
