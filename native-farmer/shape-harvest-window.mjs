// Hide headed harvest Chrome without throttling Shape's VM.
// Windows: caller parks the window off-screen via --window-position.
// macOS: that flag is clamped onto a real display, so we minimize the harvest window only.

export async function concealHarvestWindow(page, {
  platform = process.platform,
  offscreen = true,
  execFile,
} = {}) {
  if (!offscreen || !page || platform !== 'darwin') return false;
  if (await minimizeHarvestWindowViaCdp(page)) return true;
  return minimizeHarvestWindowViaOsascript(page, execFile);
}

async function minimizeHarvestWindowViaCdp(page) {
  let session = null;
  try {
    session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    if (windowId == null) return false;
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
    return true;
  } catch {
    return false;
  } finally {
    try { await session?.detach(); } catch {}
  }
}

async function minimizeHarvestWindowViaOsascript(page, execFile) {
  const run = execFile || (await import('node:child_process')).execFile;
  const userDataDir = harvestUserDataDir(page);
  if (!userDataDir) return false;
  const pid = await harvestBrowserPid(userDataDir);
  if (!pid) return false;
  const hide = `
    tell application "System Events"
      set theProc to first process whose unix id is ${Number(pid)}
      repeat with w in windows of theProc
        try
          set value of attribute "AXMinimized" of w to true
        end try
      end repeat
    end tell
  `;
  try {
    await execFilePromise(run, '/usr/bin/osascript', ['-e', hide]);
    return true;
  } catch {
    return false;
  }
}

function harvestUserDataDir(page) {
  try {
    const browser = page.context().browser();
    const args = (browser && browser.process && browser.process()?.spawnargs) || [];
    const flag = args.find(arg => String(arg).startsWith('--user-data-dir='));
    return flag ? flag.slice('--user-data-dir='.length) : '';
  } catch {
    return '';
  }
}

async function harvestBrowserPid(userDataDir) {
  const { execFile } = await import('node:child_process');
  try {
    const { stdout } = await execFilePromise(execFile, '/bin/ps', ['-A', '-ww', '-o', 'pid=,command=']);
    const needle = `--user-data-dir=${userDataDir}`;
    for (const line of String(stdout || '').split('\n')) {
      if (!line.includes(needle)) continue;
      const match = line.trim().match(/^(\d+)\s+/);
      if (match) return Number(match[1]);
    }
  } catch {}
  return 0;
}

function execFilePromise(execFile, command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

export {
  minimizeHarvestWindowViaCdp,
  harvestUserDataDir,
};
