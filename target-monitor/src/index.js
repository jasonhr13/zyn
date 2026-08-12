import { config } from './config.js';
import { log } from './log.js';
import { makeEmitter } from './emitter.js';
import { createScheduler } from './fulfillment.js';
import { startDiscovery, bindScheduler } from './discovery.js';
import { startHeartbeat } from './heartbeat.js';
import { startServer } from './server.js';

const startedAt = Date.now();

log.info(
  {
    keywords: config.discovery.keywords,
    proxies: config.proxies.length,
    sinks: Object.entries(config.sinks).filter(([, v]) => v).map(([k]) => k),
    hot_s: config.fulfillment.hotIntervalMs / 1000,
    warm_s: config.fulfillment.warmIntervalMs / 1000,
  },
  'target-monitor starting',
);

const emit = makeEmitter();
const scheduler = createScheduler(emit);
bindScheduler(scheduler);

const discoveryTimer = startDiscovery(emit);
const heartbeatTimer = startHeartbeat({ scheduler, startedAt });
const server = startServer({ scheduler, startedAt });

function shutdown(signal) {
  log.info({ signal }, 'shutting down');
  clearInterval(discoveryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  scheduler.stop();
  server.close();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err: String(err) }, 'unhandledRejection'));
