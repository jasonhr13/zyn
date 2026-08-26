import { spawn } from 'node:child_process';

// Physical grocery TCINs that stay in stock nationally and work with the standard
// cart_items payload (tcin + qty). Gift cards are a bad canary: they 400 without
// denomination/delivery fields. Charmin was the first probe and sells out.
export const CANARY_TCINS = Object.freeze([
  '15011547', // bananas
  '12953662', // grocery staple filler
  '54605734', // Charmin Ultra Soft — last resort
]);
export const DEFAULT_CANARY_TCIN = CANARY_TCINS[0];

export function createAtcReplayGate({
  warmupNeeded = 2,
  extraOnFail = 1,
  sampleEvery = 20,
  sampleMinIntervalMs = 60_000,
  windowSize = 10,
  now = Date.now,
} = {}) {
  const warmupFloor = Math.max(1, Number(warmupNeeded) || 2);
  const extra = Math.max(0, Number(extraOnFail) || 0);
  const sampleN = Math.max(1, Number(sampleEvery) || 20);
  const sampleGap = Math.max(0, Number(sampleMinIntervalMs) || 0);
  const recentLimit = Math.max(5, Number(windowSize) || 10);
  const clock = typeof now === 'function' ? now : () => Date.now();

  let warmupAttempts = 0;
  let warmupPasses = 0;
  let warmupBudget = warmupFloor;
  let gated = true;
  let skipped = false;
  let inFlight = false;
  let mintedSinceSample = 0;
  let lastSampleAt = 0;
  const window = [];

  function snapshot() {
    const recent = window.slice(-recentLimit);
    const ok = recent.filter(item => item.ok).length;
    let label = 'idle';
    if (skipped) label = 'skipped';
    else if (gated) label = warmupAttempts ? 'warmup' : 'pending';
    else if (recent.length) label = `${ok}/${recent.length}`;
    return {
      gated,
      skipped,
      inFlight,
      warmupAttempts,
      warmupPasses,
      warmupNeeded: warmupBudget,
      sampleEvery: sampleN,
      recentOk: ok,
      recentTotal: recent.length,
      last: recent[recent.length - 1] || null,
      label,
    };
  }

  function engineMayTake() {
    return skipped || !gated;
  }

  function wouldTake() {
    if (skipped || inFlight) return false;
    if (gated && warmupAttempts < warmupBudget) return true;
    const t = clock();
    if (t - lastSampleAt < sampleGap) return false;
    if (gated) return true;
    mintedSinceSample += 1;
    return mintedSinceSample >= sampleN;
  }

  // Atomically decide and mark in-flight so a worker wave cannot reserve eight canaries.
  function reserve() {
    if (!wouldTake()) return false;
    if (!gated) {
      mintedSinceSample = 0;
      lastSampleAt = clock();
    } else if (warmupAttempts >= warmupBudget) {
      lastSampleAt = clock();
    }
    inFlight = true;
    return true;
  }

  function record(result = {}) {
    inFlight = false;
    const category = String(result.category || (result.ok ? 'ok' : 'unknown'));
    if (
      result.skipped
      || category === 'no-engine'
      || category === 'spawn'
      || category === 'timeout'
      || category === 'oos'
      || category === 'not_found'
      || category === 'rate_limit'
      || category === 'proxy'
      || category === 'unknown'
    ) {
      skipped = true;
      gated = false;
      window.push({ ok: false, category, at: clock() });
      if (window.length > 40) window.shift();
      return snapshot();
    }
    const ok = result.ok === true;
    const decisive = ok || category === 'shape_block' || category === 'target_block';
    window.push({ ok, category, at: clock() });
    if (window.length > 40) window.shift();
    if (!decisive) return snapshot();

    if (gated) {
      warmupAttempts += 1;
      if (ok) warmupPasses += 1;
      if (warmupPasses > 0) gated = false;
      else if (warmupAttempts >= warmupFloor && warmupBudget === warmupFloor) {
        warmupBudget = warmupFloor + extra;
      }
    } else if (!ok && category === 'shape_block') {
      const recent = window.slice(-5);
      if (recent.length >= 5 && recent.every(item => !item.ok && item.category === 'shape_block')) {
        gated = true;
        warmupAttempts = 0;
        warmupPasses = 0;
        warmupBudget = warmupFloor;
      }
    }
    return snapshot();
  }

  return {
    reserve,
    wouldTake,
    shouldTakeOnMint: wouldTake,
    begin: reserve,
    record,
    engineMayTake,
    snapshot,
  };
}

// Downloaded checkout engines (ZYN_ENGINE_PATH) predate shape-canary and hang in
// ConnectFrontend if a license token leaks through. Canaries must use the bundled
// binary the app pins via ZYN_SHAPE_CANARY_BIN.
export function canaryCommandFromEnv(env = process.env) {
  const override = String(env.ZYN_SHAPE_CANARY_BIN || '').trim();
  if (!override) return null;
  const args = String(env.ZYN_SHAPE_CANARY_ARGS || '')
    .split('\t')
    .map(part => part.trim())
    .filter(Boolean);
  return { bin: override, args: args.length ? args : ['shape-canary'] };
}

export function canaryChildEnv(env = process.env) {
  const childEnv = { ...env, ZYN_SHAPE_CANARY: '1' };
  delete childEnv.ZYN_SHAPE_TOKEN;
  delete childEnv.ZYN_PARENT_WATCH;
  return childEnv;
}

function killCanaryProcess(child) {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 300);
  if (typeof killer.unref === 'function') killer.unref();
}

export function runEngineAtcReplay({
  bin,
  args = ['shape-canary'],
  cookie,
  tcin = DEFAULT_CANARY_TCIN,
  tcins = CANARY_TCINS,
  timeoutMs = 12000,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ skipped: true, category: 'no-engine' });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: canaryChildEnv(env),
      });
    } catch (error) {
      finish({ ok: false, category: 'spawn', error: String(error && error.message || error) });
      return;
    }
    timer = setTimeout(() => {
      killCanaryProcess(child);
      finish({ ok: false, category: 'timeout', error: 'canary timed out' });
    }, Math.max(1000, Number(timeoutMs) || 12000));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      finish({ ok: false, category: 'spawn', error: String(error && error.message || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      const raw = String(stdout || '').trim();
      if (!raw) {
        finish({
          ok: false,
          category: 'spawn',
          error: String(stderr || `canary exited ${code}`).slice(0, 300),
        });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed.skipped) {
          finish({ skipped: true, category: parsed.category || 'skipped' });
          return;
        }
        finish({
          ok: parsed.ok === true,
          status: Number(parsed.status) || 0,
          category: String(parsed.category || (parsed.ok ? 'ok' : 'unknown')),
          latencyMs: Number(parsed.latencyMs) || 0,
          tcin: String(parsed.tcin || tcin || ''),
          error: String(parsed.error || stderr || '').slice(0, 300),
        });
      } catch {
        finish({
          ok: false,
          category: 'spawn',
          error: String(stderr || stdout || `canary exited ${code}`).slice(0, 300),
        });
      }
    });
    const list = [...new Set(
      (Array.isArray(tcins) ? tcins : [])
        .concat(tcin)
        .map(value => String(value || '').replace(/\D/g, ''))
        .filter(Boolean),
    )];
    try {
      child.stdin.write(JSON.stringify({
        headers: cookie && cookie.headers || {},
        proxy: cookie && cookie.proxy || '',
        tcin: list[0] || DEFAULT_CANARY_TCIN,
        tcins: list,
      }));
      child.stdin.end();
    } catch (error) {
      finish({ ok: false, category: 'spawn', error: String(error && error.message || error) });
    }
  });
}
