// Every OS-specific primitive Zyn needs, in one place.
//
// WHY THIS EXISTS. The app grew up on Windows, so `taskkill /F /T`, `netstat -ano`, `tasklist`,
// PowerShell CIM queries and the literal string `backend.exe` are scattered across four helpers.
// None of that is wrong — it is just unportable, and each copy drifted slightly from the others.
// Collecting it here means a second platform is a change in ONE file rather than a hunt through
// process-management code that took real debugging to get right.
//
// THE HARD RULE: the win32 branch of every function below must behave EXACTLY as the code it
// replaced. Zyn ships to Windows users today; a refactor that "improves" a kill path is a
// regression waiting for a drop. Where a Windows command is reproduced it is reproduced verbatim,
// same flags, same timeouts, same swallowed errors.
//
// The posix branches are new and unproven against a live drop. They are written to match the
// INTENT of the Windows behaviour (force-kill a whole tree; identify a listener; refuse to touch a
// stranger's process) rather than to be individually clever.

const { execFileSync } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ── binary names ─────────────────────────────────────────────────────────────────
// The Go engine and the bundled Node runtime are the only two native binaries we ship. Everything
// else that varies is a command, not a filename.
const EXE = isWin ? '.exe' : '';
const engineBin = () => `backend${EXE}`;
const nodeBin = () => `node${EXE}`;

// ── spawning ─────────────────────────────────────────────────────────────────────
// Tree-killing on posix has a prerequisite that Windows does not: the child must be a process-GROUP
// leader, which only happens when it is spawned `detached`. Without this, killTree below can only
// signal the direct child, and Playwright's Chromium — a grandchild — survives. That is precisely
// the bug `taskkill /T` was introduced to fix on Windows, so posix needs its own answer or "Stop"
// leaves browser windows running.
//
// Deliberately NOT set on Windows: `detached: true` there allocates a new console window, so every
// task launch would flash a black box on screen.
//
// Note we never call .unref() — detached only establishes the group; the parent still owns the pipes
// and still waits on the child, exactly as today.
function spawnOpts(extra) {
  const base = isWin ? {} : { detached: true };
  return extra ? { ...extra, ...base } : base;
}

// ── killing ──────────────────────────────────────────────────────────────────────
// Force-kill a process and everything it spawned.
//
// Windows: taskkill /F /T, verbatim — /T walks the child tree, /F skips the polite shutdown. The
// farmer therefore never gets to close its own browsers, which is why sweepOrphanHarvesters exists.
// Posix: signal the whole process GROUP via the negative pid. SIGKILL rather than SIGTERM so the
// semantics match /F — a half-dead engine holding :8727 is worse than an ungraceful exit, and the
// Windows side has been living with exactly that trade for months.
function killTree(proc) {
  if (!proc) return;
  try {
    if (isWin && proc.pid) {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { timeout: 4000, stdio: 'ignore' });
    } else if (proc.pid) {
      // Negative pid = "the group led by this pid". Only valid because spawnOpts() detached it.
      try { process.kill(-proc.pid, 'SIGKILL'); }
      catch { proc.kill('SIGKILL'); }   // not a group leader after all — settle for the one process
    }
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

// Same, for a pid we found rather than a child we own (the untracked cookie broker). There is no
// child handle to fall back on here, so the group attempt degrades to a plain kill.
function killPid(pid) {
  if (!pid) return;
  if (isWin) {
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 4000, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch { process.kill(pid, 'SIGKILL'); }
}

// ── process inspection ───────────────────────────────────────────────────────────
// Who is listening on a loopback port? Returns 0 when nothing is, or when we cannot tell — callers
// treat 0 as "could not resolve" and decline to kill anything, which is the safe direction.
function listenerPid(port) {
  try {
    if (isWin) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000 });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return 0;
    }
    // -t prints bare pids; the @127.0.0.1 restriction mirrors the loopback-only match above, so a
    // service bound to a public interface on the same port is never mistaken for ours.
    const out = execFileSync('lsof',
      ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 4000 });
    const first = out.trim().split(/\r?\n/)[0];
    return first ? Number(first) || 0 : 0;
  } catch { return 0; }
}

// A display name for a pid — used to tell the user WHO is holding a port before we refuse to touch
// it. Lowercased so callers can compare without worrying about case.
function imageNameOf(pid) {
  try {
    if (isWin) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 4000 });
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1].toLowerCase() : '';
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 4000 });
    // comm= is a full path on macOS (/usr/local/bin/node); the basename is the comparable part.
    return path.basename(out.trim()).toLowerCase();
  } catch { return ''; }
}

// "Is this the farmer?" — the caller wants to know whether an unrecognised port-holder is one of our
// own Node processes or a stranger's program. The answer differs only by file extension, and leaking
// that distinction to the call site is exactly what this module exists to prevent.
function isNodeImage(name) {
  return String(name || '').toLowerCase() === nodeBin();
}

// ── orphan harvest browsers ──────────────────────────────────────────────────────
// Kill harvest browsers that outlived their farmer.
//
// Matched on OUR OWN launch flags, never on process name. Every harvest browser carries
// --disable-blink-features=AutomationControlled AND the off-screen window position; the operator's
// own Chrome carries neither. Requiring BOTH is what makes it safe to run while they are browsing.
//
// ownFarmerPid: the farmer we just killed, if any. It may still be dying when this runs, and it must
// not be mistaken for the "someone else is live" signal — we never sweep while ANOTHER farmer is
// alive, because a dev instance and the packaged app can both be running and the flag match cannot
// tell whose browsers are whose.
const HARVEST_FLAG_A = 'AutomationControlled';
const HARVEST_FLAG_B = 'window-position=-32000';

// Windows pre-filters by image name inside the CIM query purely so the query stays cheap; the flag
// pair below is what actually decides. CocCoc and Yandex both ship as browser.exe — generic, but
// harmless for that reason.
const HARVEST_EXES = ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe',
  'whale.exe', 'browser.exe', 'slimjet.exe'];

function sweepOrphanHarvesters(ownFarmerPid = 0) {
  try {
    if (isWin) {
      const nameFilter = HARVEST_EXES.map((n) => `Name='${n}'`).join(' OR ');
      // Backticks so the single quotes PowerShell needs survive verbatim.
      const ps = [
        `$mine = ${Number(ownFarmerPid) || 0};`,
        `$others = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'"`,
        `| Where-Object { $_.CommandLine -like '*shape-farmer*' -and $_.ProcessId -ne $mine });`,
        `if ($others.Count -eq 0) {`,
        `Get-CimInstance Win32_Process -Filter "${nameFilter}"`,
        `| Where-Object { $_.CommandLine -like '*${HARVEST_FLAG_A}*' -and $_.CommandLine -like '*${HARVEST_FLAG_B}*' }`,
        `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
      ].join(' ');
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 8000, stdio: 'ignore' });
      return;
    }

    // Posix: one `ps` dump, filtered here. -ww defeats the default column truncation, without which
    // the launch flags we match on are cut off the end of the line and NOTHING is ever swept.
    // No image-name pre-filter: on macOS these are "Google Chrome Helper", "Chromium" and friends,
    // and the flag pair is the real discriminator anyway.
    const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 8000 });
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
    }

    const mine = Number(ownFarmerPid) || 0;
    const otherFarmerAlive = rows.some(r =>
      r.pid !== mine && /\bnode\b/.test(r.cmd) && r.cmd.includes('shape-farmer'));
    if (otherFarmerAlive) return;

    for (const r of rows) {
      if (!r.cmd.includes(HARVEST_FLAG_A) || !r.cmd.includes(HARVEST_FLAG_B)) continue;
      try { process.kill(r.pid, 'SIGKILL'); } catch {}
    }
  } catch { /* best effort — a failed sweep must never block teardown */ }
}

// ── machine identity ─────────────────────────────────────────────────────────────
// One key binds to ONE machine. Returns a raw platform identifier or '' — the caller hashes it, so
// nothing here ever leaves the machine in this form.
//
// Windows' MachineGuid and macOS' IOPlatformUUID are equivalent in the ways that matter: both
// survive hostname changes, NIC swaps and app reinstalls, so a user is not forced into a licence
// reset just because they renamed their machine or plugged in a dock.
function machineGuid() {
  try {
    if (isWin) {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
      return m ? m[1] : '';
    }
    if (isMac) {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 3000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/);
      return m ? m[1] : '';
    }
  } catch {}
  return '';
}

// ── locating a Node runtime ──────────────────────────────────────────────────────
// In Electron process.execPath is the app binary, not node — the bot scripts need a real one.
// The installer ships its own copy under resources/vendor precisely so users do not need Node
// installed; system lookup is the fallback, and the bare string 'node' the last resort.
function whichNode() {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', ['node'], { encoding: 'utf8', timeout: 3000 });
    const p = out.trim().split(/\r?\n/)[0].trim();
    if (p) return p;
  } catch {}
  return '';
}

// Well-known install locations, checked only after the above fail.
function nodeFallbackPaths() {
  if (isWin) {
    return [
      'C:\\Program Files\\nodejs\\node.exe',
      process.env.APPDATA && path.join(process.env.APPDATA, 'nvm', 'current', 'node.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'nvm', 'current', 'node.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    ].filter(Boolean);
  }
  // Homebrew differs by arch on macOS: /opt/homebrew is Apple Silicon, /usr/local is Intel. Listing
  // both costs nothing and means one build works on either.
  return [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    process.env.HOME && path.join(process.env.HOME, '.nvm', 'current', 'bin', 'node'),
  ].filter(Boolean);
}

module.exports = {
  isWin, isMac,
  EXE, engineBin, nodeBin,
  spawnOpts,
  killTree, killPid,
  listenerPid, imageNameOf, isNodeImage,
  sweepOrphanHarvesters, HARVEST_EXES,
  machineGuid,
  whichNode, nodeFallbackPaths,
};
