import { config } from './config.js';
import { discover } from './redsky.js';
import { upsertProduct, applyDiscoveryMisses, getState } from './db.js';
import { log } from './log.js';

let scheduler; // set by fulfillment to enroll/drop TCINs from polling

export function bindScheduler(s) {
  scheduler = s;
}

export async function runDiscovery(emit) {
  const started = Date.now();
  let products;
  try {
    products = await discover();
  } catch (err) {
    log.error({ err: err.message }, 'discovery cycle failed');
    return;
  }

  let discovered = 0;
  for (const p of products.values()) {
    const { isNew } = upsertProduct(p);
    scheduler?.enroll(p.tcin);
    if (isNew) {
      discovered++;
      emit('product.discovered', p, { current: { status: 'DISCOVERED', price: p.price } });
    }
  }

  // Age out products missing for N consecutive cycles.
  const delisted = applyDiscoveryMisses([...products.keys()], config.discovery.delistAfterMisses);
  for (const tcin of delisted) {
    scheduler?.drop(tcin);
    const st = getState(tcin) ?? {};
    emit('product.delisted', { tcin }, { current: { status: 'DELISTED', price: st.price ?? null } });
  }

  log.info(
    { found: products.size, discovered, delisted: delisted.length, ms: Date.now() - started },
    'discovery cycle',
  );
}

export function startDiscovery(emit) {
  runDiscovery(emit); // immediate first pass to populate the catalog
  return setInterval(() => runDiscovery(emit), config.discovery.intervalMs);
}
