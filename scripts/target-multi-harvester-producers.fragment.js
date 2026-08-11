function harvesterProxyLines(config) {
  return proxyLinesFor(config.proxyListName).filter(line => parseProxyLine(line));
}

function harvesterFingerprint(config) {
  let proxyState = 'local';
  if (config.proxyListName) {
    try {
      const lines = harvesterProxyLines(config);
      proxyState = lines.length
        ? `${lines.length}:${crypto.createHash('sha256').update(lines.join('\n')).digest('hex')}`
        : 'unavailable';
    } catch { proxyState = 'unavailable'; }
  }
  return JSON.stringify({ config, proxyState });
}

function stopHarvesterProducer(id) {
  const entry = harvesterProcs.get(id);
  if (!entry) return;
  harvesterProcs.delete(id);
  try { killTree(entry.proc); } catch {}
}

function spawnHarvesterProducer(config) {
  const botDir = botDirPath();
  const script = path.join(botDir, 'shape-farmer.mjs');
  if (!fs.existsSync(script)) { log('shape farmer missing: ' + script); return; }

  sweepStaleProxyFiles();
  let proxyFile = '';
  try {
    const lines = harvesterProxyLines(config);
    // A named proxy route is an instruction, not a preference. If its list was deleted, renamed,
    // emptied, or failed to decrypt, never turn a metered-proxy harvester into a home-IP harvester.
    if (config.proxyListName && !lines.length) {
      const failureKey = `proxy:${config.proxyListName}`;
      if (harvesterStartFailures.get(config.id) !== failureKey) {
        log(`[target] harvester ${config.name} not started — proxy group ${config.proxyListName} is unavailable or empty`);
        harvesterStartFailures.set(config.id, failureKey);
      }
      return;
    }
    harvesterStartFailures.delete(config.id);
    proxyFile = path.join(os.tmpdir(), `shape-proxies-${Date.now()}${Math.floor(Math.random() * 1000)}.txt`);
    fs.writeFileSync(proxyFile, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    const failureKey = `proxy-error:${e.message}`;
    if (harvesterStartFailures.get(config.id) !== failureKey) {
      log(`harvester ${config.name} proxy file error: ${e.message}`);
      harvesterStartFailures.set(config.id, failureKey);
    }
    if (config.proxyListName) return;
  }

  const env = nodeEnvironment({ FORCE_COLOR: '0', ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    ZYN_PARENT_WATCH: '1', ZYN_OWNER_PID: String(process.pid) });

  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  const builtInTargets = String(settings.targetAtcHarvestTcins || settings.targetAtcHarvestTcin || '').trim();
  const defaultTargets = [
    '95081084', '95225598', '95225596', '95081083', '94982545',
    '95051708', '1011960744', '94681699', '94681674', '94776406',
    '94860238', '94921087', '1011239459', '94336416', '1010649371',
    '1012199003', '1011904877', '1006295656', '1006088045', '95294439',
    '95027462', '95022215',
  ].join(',');
  const atcTcins = String(config.input || '').split(/[\s,]+/).filter(Boolean).join(',') || builtInTargets || defaultTargets;
  const poolSize = parseInt(settings.targetCookieBank, 10) > 0 ? parseInt(settings.targetCookieBank, 10) : 0;
  const capturesPerLoad = Math.max(1, Math.min(10, parseInt(settings.targetCapturesPerLoad, 10) || 1));
  const loadsPerBrowser = Math.max(1, Math.min(10, parseInt(settings.targetLoadsPerBrowser, 10) || 3));
  const blockHeavyResources = settings.targetBlockHeavyResources !== false && settings.targetBlockHeavyResources !== 'false';
  const types = config.type === 'auto' ? 'login,atc' : config.type;
  const args = [script,
    '--producer=true',
    `--harvesterId=${config.id}`,
    `--harvesterName=${config.name}`,
    `--harvesterType=${config.type}`,
    `--atcMode=${config.atcMode}`,
    `--routeLabel=${config.proxyListName || 'Local'}`,
    `--proxyFile=${proxyFile}`,
    `--atcTcins=${atcTcins}`,
    `--poolSize=${poolSize}`,
    `--workers=${config.workers}`,
    `--capturesPerLoad=${capturesPerLoad}`,
    `--loadsPerBrowser=${loadsPerBrowser}`,
    `--blockHeavyResources=${blockHeavyResources}`,
    `--browsers=${config.browser}`,
    `--types=${types}`,
    '--sessionReady=false',
    '--loginMode=password',
    '--headless=true',
    `--diag=${verboseLogs()}`,
    `--intervalDelayMs=${config.intervalDelaySec * 1000}`,
    `--cookieTtlMs=${config.cookieTtlSec * 1000}`,
  ];

  let proc;
  try {
    proc = spawn(findNodeExe(), args, { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });
  } catch (e) { log(`harvester ${config.name} spawn failed: ${e.message}`); return; }

  const fingerprint = harvesterFingerprint(config);
  harvesterProcs.set(config.id, { proc, fingerprint });
  const relay = (chunk) => String(chunk).split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (text && (verboseLogs() || KEEP_IN_QUIET.test(text))) log(`[${config.name}] ${text}`);
  });
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', error => log(`harvester ${config.name} error: ${error.message}`));
  proc.on('exit', (code) => {
    const current = harvesterProcs.get(config.id);
    if (current && current.proc === proc) harvesterProcs.delete(config.id);
    log(`harvester ${config.name} exited (code ${code})`);
    if (!quitting) setTimeout(ensureHarvesterBroker, 1000);
  });
  const mode = config.type === 'login' ? '' : config.atcMode === 'v2' ? ' ATC+' : ' ATC';
  log(`[target] harvester ${config.name} starting — ${config.type}${mode}, ${config.workers} worker(s), ${config.proxyListName || 'Local'}`);
}

function syncHarvesterProducers(configs = managedHarvesterConfigs() || []) {
  const active = configs.filter(config => harvesterScheduleActive(config));
  const wanted = new Map(active.map(config => [config.id, config]));
  for (const id of [...harvesterStartFailures.keys()]) {
    if (!wanted.has(id)) harvesterStartFailures.delete(id);
  }
  for (const [id, entry] of harvesterProcs) {
    const config = wanted.get(id);
    if (!config || entry.fingerprint !== harvesterFingerprint(config)) stopHarvesterProducer(id);
  }
  for (const config of active) {
    if (!harvesterProcs.has(config.id)) spawnHarvesterProducer(config);
  }
}

function armHarvesterScheduleSync() {
  if (harvesterSyncTimer) return;
  harvesterSyncTimer = setInterval(() => {
    if (quitting) return;
    if (!managedHarvesterMode()) {
      clearInterval(harvesterSyncTimer);
      harvesterSyncTimer = null;
      return;
    }
    ensureHarvesterBroker();
  }, 15000);
  harvesterSyncTimer.unref?.();
}

function syncTargetHarvesters(mainWindow) {
  if (mainWindow) attachWindow(mainWindow);
  ensureHarvesterBroker();
  syncTargetCookieBankDemand();
  return true;
}
