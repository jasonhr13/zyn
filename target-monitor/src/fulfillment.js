import { config, isIgnoredTcin } from './config.js';
import { fetchStock, SoftBlock } from './redsky.js';
import { getEnrolled, getProduct, getState, setState, setTier, updateProductMeta } from './db.js';
import { log } from './log.js';

const { batchSize, hotIntervalMs, warmIntervalMs, warmAfterMs } = config.fulfillment;

// Due-based scheduler: every product carries its own nextDue based on tier, and
// each tick polls whatever is due (batched). One clock, no separate hot/warm loops.
export function createScheduler(emit) {
  const due = new Map(); // tcin -> nextDue epoch ms
  let ticking = false;
  const stats = { polls: 0, lastPollAt: 0, softBlocks: 0, errors: 0 };

  const enroll = (tcin) => {
    if (isIgnoredTcin(tcin)) return;
    if (!due.has(tcin)) due.set(tcin, 0); // 0 = poll asap
  };
  const drop = (tcin) => due.delete(tcin);

  // On boot, enroll everything already in the catalog except ignored TCINs.
  for (const p of getEnrolled()) enroll(p.tcin);

  function intervalFor(tcin) {
    // Base tier is the rule-derived pin (high-demand = hot). Any item polls hot
    // for warmAfterMs after a state change, then reverts to its base tier — so a
    // cheap warm item that restocks still gets fast follow-up polling.
    const base = getProduct(tcin)?.base_tier ?? 'hot';
    const st = getState(tcin);
    const recentlyChanged = st?.last_change_at && Date.now() - st.last_change_at < warmAfterMs;
    const effective = recentlyChanged || base === 'hot' ? 'hot' : 'warm';
    setTier(tcin, effective);
    return effective === 'hot' ? hotIntervalMs : warmIntervalMs;
  }

  function processSummary(s) {
    const now = Date.now();
    const prev = getState(s.tcin);
    const wasPurchasable = prev ? prev.purchasable === 1 : null;
    const prevPrice = prev?.price ?? null;
    let changed = false;
    let alertsSent = prev?.alerts_sent ?? 0;
    let lastAlertAt = prev?.last_alert_at ?? null;
    // Launch-watch: a seed TCIN's first resolution means it just went live in
    // Target's catalog (it 404'd before). Announce it, and fire the drop alert
    // immediately if it's already buyable — bypassing the first-sighting guard.
    const firstLive = !prev;
    const isSeed = firstLive && getProduct(s.tcin)?.seed === 1;

    if (firstLive && isSeed) {
      updateProductMeta(s.tcin, { title: s.title, url: s.url, image: s.image });
      changed = true;
      if (s.purchasable) {
        const type = s.status === 'PRE_ORDER_SELLABLE' ? 'preorder.live' : 'stock.online.in';
        emit(type, s, {
          previous: { status: 'PRE_LAUNCH', purchasable: false },
          current: { status: s.status, price: s.price, qty: s.qty, purchasable: true },
        });
        alertsSent = 1;
        lastAlertAt = now;
      } else {
        emit('product.launched', s, {
          current: { status: s.status, price: s.price, qty: s.qty, purchasable: false },
        });
      }
    } else if (wasPurchasable !== null && s.purchasable && !wasPurchasable) {
      // Restock (OOS -> purchasable): fire once, open the re-ping streak.
      changed = true;
      const type = s.status === 'PRE_ORDER_SELLABLE' ? 'preorder.live' : 'stock.online.in';
      emit(type, s, {
        previous: { status: prev.status, purchasable: false },
        current: { status: s.status, price: s.price, qty: s.qty, purchasable: true },
      });
      alertsSent = 1;
      lastAlertAt = now;
    } else if (s.purchasable && wasPurchasable && alertsSent >= 1) {
      // Still in stock after a restock we announced — re-ping on the interval
      // until the in-stock streak is older than repingMaxAgeMs. After that,
      // stay quiet until it goes OOS and restocks. First-sighting/baseline
      // stock has alertsSent 0, so it never re-pings.
      const { repingIntervalMs, repingMax, repingMaxAgeMs } = config.restock;
      const due = repingIntervalMs > 0 && now - (lastAlertAt ?? 0) >= repingIntervalMs;
      const underCap = repingMax === 0 || alertsSent - 1 < repingMax;
      const restockedAt = prev.last_change_at ?? 0;
      const underAge = repingMaxAgeMs === 0 || (restockedAt > 0 && now - restockedAt < repingMaxAgeMs);
      if (due && underCap && underAge) {
        alertsSent += 1;
        lastAlertAt = now;
        emit('stock.online.reping', s, {
          current: { status: s.status, price: s.price, qty: s.qty, purchasable: true, seq: alertsSent },
        });
      }
    } else if (wasPurchasable !== null && !s.purchasable && wasPurchasable) {
      // Went OOS: fire once, close the streak.
      changed = true;
      emit('stock.online.out', s, {
        previous: { status: prev.status, purchasable: true },
        current: { status: s.status, price: s.price, purchasable: false },
      });
      alertsSent = 0;
      lastAlertAt = null;
    } else if (!s.purchasable) {
      alertsSent = 0;
      lastAlertAt = null;
    }

    if (prev && prevPrice != null && s.price != null && s.price !== prevPrice) {
      emit('price.changed', s, { previous: { price: prevPrice }, current: { price: s.price, status: s.status } });
    }

    setState({
      tcin: s.tcin,
      purchasable: s.purchasable ? 1 : 0,
      status: s.status,
      price: s.price,
      qty: s.qty,
      now,
      // Only a real transition stamps last_change_at (drives change-promotion).
      last_change_at: changed ? now : (prev?.last_change_at ?? null),
      alerts_sent: alertsSent,
      last_alert_at: lastAlertAt,
    });
  }

  async function pollBatch(tcins) {
    try {
      const { summaries, missing } = await fetchStock(tcins);
      for (const s of summaries) processSummary(s);
      // Missing TCINs (Redsky returned an error for them): keep last-known state,
      // never treat a parse gap as an OOS transition. Just reschedule.
      if (missing.length) log.debug({ missing }, 'tcins unresolved this poll');
      stats.polls++;
      stats.lastPollAt = Date.now();
    } catch (err) {
      if (err instanceof SoftBlock) stats.softBlocks++;
      else stats.errors++;
      log.warn({ err: err.message, n: tcins.length }, 'stock batch failed');
    } finally {
      const now = Date.now();
      for (const tcin of tcins) if (due.has(tcin)) due.set(tcin, now + intervalFor(tcin));
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const ready = [];
      for (const [tcin, at] of due) if (at <= now) ready.push(tcin);
      for (let i = 0; i < ready.length; i += batchSize) {
        await pollBatch(ready.slice(i, i + batchSize));
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(tick, 1000);
  return { enroll, drop, stats, stop: () => clearInterval(timer), size: () => due.size };
}
