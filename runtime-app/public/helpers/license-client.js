// Single-instance lock + analytics identity against the dashboard.
// Runs in the Electron MAIN process. Node 18+ (global fetch) — the bundle ships it.
//
// start() returns:
//   'ok'     → key claimed; heartbeat running; onIdentity(discord) fired
//   'skip'   → key is NOT managed by the dashboard (legacy gist key) or the
//              dashboard was unreachable → run normally, no lock/analytics
//   'denied' → key is in use elsewhere or disabled → onDenied() fired (caller quits)
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const plat = require('./platform');

// ── HWID ────────────────────────────────────────────────────────────────────
// One key binds to ONE machine. Windows' MachineGuid and macOS' IOPlatformUUID
// are the canonical machine identities: both survive hostname changes, NIC swaps
// and app reinstalls, so a user isn't forced into a reset just because they
// renamed their machine or plugged in a dock. The composite hash below is only a
// fallback for when that read fails. Hashed (never sent raw) so the dashboard
// stores an opaque id, not a fingerprint of the user's hardware.
//
// The Windows read is unchanged, so every existing key stays bound to the same
// hwid — a change here would lock out every user on the next launch.
const machineGuid = plat.machineGuid;
const legacyHwidPrefix = String.fromCharCode(104, 111, 112, 101);

function computeHwid() {
  const guid = machineGuid();
  if (guid) return crypto.createHash('sha256').update(`${legacyHwidPrefix}:${guid}`).digest('hex').slice(0, 32);
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
    .map((n) => n.mac)
    .sort();
  const cpu = (os.cpus()[0] || {}).model || '';
  const parts = [os.platform(), os.arch(), os.hostname(), cpu, macs[0] || '', String(os.totalmem())];
  return crypto.createHash('sha256').update(`${legacyHwidPrefix}:${parts.join('|')}`).digest('hex').slice(0, 32);
}

function startLicense({ apiBase, key, deviceName, onDenied, onClose, onStopBots, onIdentity,
  getActivity, onFleetControl, heartbeatMs = 15000, log = console.log }) {
  const token = crypto.randomUUID();
  const dev = deviceName || os.hostname();
  const hwid = computeHwid();
  let timer = null;
  let stopped = false;
  let active = false;
  let stopSent = false;   // guards the stop notice to one per pause

  // Electron's MAIN process (Node 16 on Electron 19) has no global fetch — use https directly.
  function post(pathname, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const u = new URL(apiBase + pathname);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { b += d; });
          res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('bad response')); } });
        }
      );
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.write(data);
      req.end();
    });
  }

  async function claim() {
    let r;
    try {
      r = await post('/api/session/claim', { key, deviceId: dev, deviceName: dev, token, hwid });
    } catch (e) {
      // Dashboard unreachable — never brick the bot over a hosting blip. The
      // legacy license.js check still gates the run.
      log(`[license] claim network error (${e.message}) — proceeding without lock.`);
      return 'skip';
    }
    if (r.granted) {
      active = true;
      if (onIdentity) onIdentity(r.discord || null);
      log('[license] instance claimed ✓');
      return 'ok';
    }
    if (r.reason === 'invalid_key') {
      log('[license] key not managed by dashboard — running on legacy license.');
      return 'skip';
    }
    log(`[license] denied: ${r.reason}${r.device ? ` (in use on ${r.device})` : ''}`);
    if (onDenied) onDenied(r.reason, r.device);
    return 'denied';
  }

  async function beat() {
    if (stopped) return;
    try {
      // Report what this copy is DOING, so the operator can see who is running what without asking.
      // Optional and best-effort: a getActivity that throws must not take the heartbeat down with
      // it, because the heartbeat is what keeps the session alive.
      let act = {};
      try { act = (getActivity && getActivity()) || {}; } catch { act = {}; }
      const r = await post('/api/session/heartbeat', {
        key, token,
        module: act.module || null,
        tasks: typeof act.tasks === 'number' ? act.tasks : null,
        version: act.version || null,
      });

      // Modules the operator has switched off fleet-wide. Rides along on a HEALTHY response rather
      // than being its own verdict: a client with Target disabled is still fine, it just must not
      // start that one module — making it a failure would have stopped every other module too.
      if (r && r.ok !== false && onFleetControl) {
        onFleetControl({
          disabledModules: Array.isArray(r.disabled_modules) ? r.disabled_modules : [],
          notice: r.notice || '',
        });
      }
      // 'stop' is the SOFT kill: stop the bots, keep the session. The operator's intent is almost
      // always "stop burning my proxies", not "lock this person out" -- and the two used to be the
      // same action, which is why stopping someone cost them their session and a support ticket.
      //
      // Deliberately does NOT call stop(): the heartbeat keeps running, so the dashboard still sees
      // the client, and clearing the flag server-side lets them start again with no re-activation.
      if (r && r.ok === false && r.action === 'stop') {
        // ONCE per pause, not once per beat. The flag stays set on the dashboard for as long as the
        // operator wants the fleet down, so acting on every heartbeat would re-stop already-stopped
        // bots and stack a modal on the user's screen every 15 seconds.
        if (!stopSent) {
          stopSent = true;
          log('[license] stop-bots from dashboard — halting tasks, session kept.');
          if (onStopBots) onStopBots(r.reason);
        }
        return;
      }
      // Cleared on the dashboard — arm the notice again so the NEXT pause is announced.
      if (r && r.ok !== false) stopSent = false;
      if (r && r.ok === false && r.action === 'close') {
        log(`[license] reset from dashboard (${r.reason}) — closing.`);
        stop();
        if (onClose) onClose(r.reason);
      }
    } catch {
      /* transient — retry next beat */
    }
  }

  // Tell the server we are letting go of this device.
  //
  // Without this the client only ever CLAIMED, never released, so a revoked or reset session sat on
  // the dashboard holding the device. The user re-entered the very same key on the very same machine
  // and got 'in_use' -- refused by their own orphan. Reinstalling did not fix that (the HWID is a
  // hash of platform/arch/hostname/CPU/MAC/RAM, none of which an install changes); people simply
  // reinstalled until the stale session aged out server-side, which is why it took "2-3 times"
  // instead of a predictable one.
  //
  // Fire-and-forget: this runs while the app is heading back to the key gate, and a failed release
  // must not hold that up. The server-side timeout stays the backstop.
  async function release(reason) {
    try { await post('/api/session/release', { key, token, hwid, reason: reason || 'client_release' }); }
    catch { /* best effort — the session's own timeout still reclaims it */ }
  }

  function stop(reason) {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (active) { active = false; release(reason); }
  }

  async function start() {
    const res = await claim();
    if (res === 'ok') timer = setInterval(beat, heartbeatMs);
    return res;
  }

  return { start, stop, release, token, hwid, isActive: () => active };
}

module.exports = { startLicense };
