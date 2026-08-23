// ── Pokemon Center US: native checkout tasks on the shared Go transport ─────────
const POKEMON_SITE = engineContract.SITES.POKEMON_CENTER_US;
const pokemonTaskIds = new Set();
const pokemonTaskConfigs = new Map();
const pendingPokemonStarts = [];
let pokemonStartSeq = 0;
let pokemonQueueStreamHealth = { configured: false, connected: false, connecting: false };
let pokemonQueueStreamLogKey = '';
let solverLucaApiKey = '';

function pokemonStatus(state, color, detail, taskId, taskState, running) {
  state = zynBrandText(state);
  detail = zynBrandText(detail);
  toRenderer('pokemonStatus', {
    taskId: String(taskId || ''), state: String(state || ''), label: String(state || ''),
    color: String(color || ''), detail: String(detail || ''),
    taskState: typeof taskState === 'number' ? taskState : undefined,
    running: typeof running === 'boolean' ? running : undefined,
  });
}

function pokemonLog(line, taskId = '') {
  let value = zynBrandText(redactProxies(String(line || ''))).replace(/[\r\n]+/g, ' ').trim();
  if (!value) return;
  if (value.length > LOG_LINE_MAX) value = value.slice(0, LOG_LINE_MAX) + '…';
  toRenderer('pokemonLog', { taskId: String(taskId || ''), line: value });
}

function pokemonDone(taskId = '') {
  toRenderer('pokemonDone', { taskId: String(taskId || '') });
}

// A native crash or spawn failure is not retryable here: blindly respawning can loop forever on a
// missing/invalid executable. Fail every optimistic start together and clear both FIFOs so a later
// user start cannot resurrect a card that was already reported done.
function failNativeEngineRuns(reason, publishError = false) {
  const detail = String(reason || 'Native engine stopped').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const failedConnection = engineConn;
  engineConn = null;
  try { if (failedConnection) failedConnection.close(); } catch {}
  taskActive = false;
  activeMonitorBandwidthRuns.clear();
  stopLiveEditMonitor();
  targetMainMonitorPendingStopIds.clear();
  clearTargetMainMonitorState();
  cancelAllOtpFetches(detail);
  for (const id of runningTaskIds) {
    if (publishError) status('Error', '#fb5454', detail, id, undefined, false);
    toRenderer('targetDone', { taskId: id });
  }
  for (const id of pokemonTaskIds) {
    if (publishError) pokemonStatus('Error', '#fb5454', detail, id, 0, false);
    pokemonDone(id);
  }
  runningTaskIds.clear();
  clearTargetCookieTasks();
  clearPendingTargetStarts();
  pokemonTaskIds.clear();
  pokemonTaskConfigs.clear();
  pendingPokemonStarts.length = 0;
  engineTaskSites.clear();
  taskAccountById.clear();
  taskProfileById.clear();
  taskCheckoutConfigById.clear();
  manualCaptchaManager.cancelPending();
  nativeHyperBroker.cancelPending();
  toRenderer('targetDone', { taskId: '' });
}

function pokemonQueueStreamLine() {
  if (pokemonQueueStreamHealth.connected) {
    return '[queue-monitor] push event stream connected; HTTPS fallback remains active';
  }
  if (pokemonQueueStreamHealth.connecting) {
    return '[queue-monitor] push event stream reconnecting; HTTPS fallback remains active';
  }
  if (!pokemonQueueStreamHealth.configured) {
    return '[queue-monitor] push event stream is not configured; HTTPS fallback remains active';
  }
  return '[queue-monitor] push event stream unavailable; HTTPS fallback remains active';
}

function setPokemonQueueStreamHealth(next = {}) {
  pokemonQueueStreamHealth = {
    configured: next.configured === true,
    connected: next.connected === true,
    connecting: next.connecting === true,
  };
  const line = pokemonQueueStreamLine();
  if (line === pokemonQueueStreamLogKey) return;
  pokemonQueueStreamLogKey = line;
  for (const id of pokemonTaskIds) pokemonLog(line, id);
}

function setSolverLucaKey(key = '') {
  const next = String(key || '').trim();
  if (next === solverLucaApiKey) return;
  solverLucaApiKey = next;
  if (solverLucaApiKey) sendConfigs();
}

function publishPokemonQueueProtection(event = {}) {
  const kind = String(event.kind || '').toLowerCase() === 'captcha' ? 'captcha' : 'queue';
  const sent = sendStockPing({
    site: 'PokemonCenter',
    sku: 'queue',
    name: kind === 'captcha' ? 'Site captcha protection detected' : 'Site queue detected',
    from: 'zyn-event-stream',
  });
  if (sent) {
    for (const id of pokemonTaskIds) pokemonLog(`[queue-monitor] push event received (${kind})`, id);
  }
  return sent;
}

function normalizePokemonInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.toLowerCase() === 'placeholder') return 'placeholder';
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!(parsed.hostname === 'pokemoncenter.com' || parsed.hostname.endsWith('.pokemoncenter.com'))) return '';
      const product = parsed.pathname.match(/\/product\/([^/]+)/);
      return product && product[1] ? `https://www.pokemoncenter.com/product/${product[1]}` : '';
    } catch { return ''; }
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) ? input : '';
}

function validatePokemonInputs(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const entries = list.map(entry => String(entry || '').trim()).filter(Boolean);
  const normalized = entries.map(normalizePokemonInput);
  return {
    inputs: [...new Set(normalized.filter(Boolean))].slice(0, 3),
    invalid: entries.filter((entry, index) => !normalized[index]),
    tooMany: [...new Set(normalized.filter(Boolean))].length > 3,
  };
}

function pokemonInputs(value) {
  return validatePokemonInputs(value).inputs;
}

function validatePokemonProducts(products, legacyInputs, legacyQuantity) {
  const rows = Array.isArray(products)
    ? products
    : pokemonInputs(legacyInputs).map(input => ({ input, quantity: legacyQuantity }));
  const populated = rows.map(row => ({
    input: String((row && (row.input || row.monitorInput || row.id)) || '').trim(),
    quantity: String(Math.max(1, parseInt(row && row.quantity, 10) || 1)),
  })).filter(row => row.input);
  const normalized = populated.map(row => normalizePokemonInput(row.input));
  const seen = new Set();
  const valid = [];
  populated.forEach((row, index) => {
    const input = normalized[index];
    if (!input || seen.has(input)) return;
    seen.add(input);
    valid.push({ input, quantity: row.quantity });
  });
  return {
    products: valid.slice(0, 3),
    invalid: populated.filter((row, index) => !normalized[index]).map(row => row.input),
    tooMany: valid.length > 3 || populated.length > 3,
  };
}

function pokemonItems(products) {
  return products.map(product => ({
    id: product.input, monitorInput: product.input, quantity: product.quantity, maxPrice: '', color: '', sizes: [],
  }));
}

function pokemonMessage(task = {}, shared = {}) {
  const products = validatePokemonProducts(
    task.products != null ? task.products : shared.products,
    task.inputs != null ? task.inputs : shared.inputs,
    task.quantity != null ? task.quantity : shared.quantity,
  ).products;
  const items = pokemonItems(products);
  return engineContract.normalizeStartTask({
    id: String(task.id || ''), type: POKEMON_SITE, site: POKEMON_SITE,
    taskGroup: '',
    monitorDelay: String(task.monitorDelay || shared.monitorDelay || '3000'),
    retryDelay: String(task.retryDelay || shared.retryDelay || '3000'),
    proxyGroup: String(task.proxyListName || '').trim() || 'Local',
    profileId: String(task.profileId || ''), profileGroup: '', accountId: '',
    item: items, monitorItems: items,
    status: '', mode: 'Default', minPrice: '', maxPrice: '', statusColor: '',
    running: true, carted: false, failed: false, successful: false,
    loopCheckout: task.loopCheckout != null ? !!task.loopCheckout : !!shared.loopCheckout,
    waitForQueue: task.waitForQueue != null ? !!task.waitForQueue : !!shared.waitForQueue,
    QueueEntryDelay: String(task.queueEntryDelay != null ? task.queueEntryDelay : (shared.queueEntryDelay || '0')),
    allInstock: task.allInstock != null ? !!task.allInstock : !!shared.allInstock,
    endless: false, useFillerItem: false, useOtpLogin: false,
    startSchedule: '', stopSchedule: '', ignoreLowStock: false,
  });
}

function rememberPokemonConfig(task, shared) {
  const merged = {
    ...shared, ...task,
    products: validatePokemonProducts(
      task.products != null ? task.products : shared.products,
      task.inputs != null ? task.inputs : shared.inputs,
      task.quantity != null ? task.quantity : shared.quantity,
    ).products,
  };
  pokemonTaskConfigs.set(String(task.id), merged);
  return merged;
}

// Loop Checkout rotates inside the selected profile's first group. The engine replaces its entire
// profile store on send-configs, so every rotation candidate must be present even when it does not
// own an initial task.
function addPokemonRotationProfiles(tasks) {
  let profiles = [];
  try {
    profiles = (dm.getProfiles() || []).filter(profile => profile && profile.profileType === 'pokemoncenter');
  } catch {}
  const groups = new Set();
  for (const task of tasks) {
    if (!task.loopCheckout) continue;
    const profile = profiles.find(value => String(value.id) === String(task.profileId));
    const group = String((profile && (profile.group || (profile.groups || [])[0])) || '').trim();
    if (group) groups.add(group);
  }
  for (const profile of profiles) {
    const group = String(profile.group || (profile.groups || [])[0] || '').trim();
    if (group && groups.has(group)) Object.assign(sentConfigs.profiles, buildProfileMap(profile.id, ''));
  }
}

function flushPokemonStarts() {
  if (pendingTargetEngineStop || !engineConn || engineConn.readyState !== WebSocket.OPEN) return 0;
  let started = 0;
  while (pendingPokemonStarts.length) {
    const config = pendingPokemonStarts[0] || {};
    const tasks = (config.tasks || []).filter(task => task && pokemonTaskIds.has(String(task.id || '')));
    if (!tasks.length) {
      pendingPokemonStarts.shift();
      continue;
    }
    addPokemonRotationProfiles(tasks);
    const messages = tasks.map(task => pokemonMessage(task, config));
    if (!messages.every(message => message.profileId && message.item.length)) {
      for (const message of messages) {
        if (!message.profileId || !message.item.length) {
          pokemonStatus('Invalid Task', '#fb5454', !message.profileId ? 'Select a checkout profile' : 'Add a product', message.id, 0, false);
          pokemonTaskIds.delete(message.id);
          pokemonTaskConfigs.delete(message.id);
          engineTaskSites.remove(message.id);
          pokemonDone(message.id);
        }
      }
    }
    const valid = messages.filter(message => message.profileId && message.item.length);
    if (!valid.length) {
      pendingPokemonStarts.shift();
      continue;
    }
    if (!sendConfigs({ tasks }) || !sendToEngine({ type: 'start-tasks', messages: valid })) {
      break;
    }
    pendingPokemonStarts.shift();
    started += valid.length;
    for (const message of valid) {
      pokemonLog('Pokémon Center task started', message.id);
      pokemonLog(pokemonQueueStreamLine(), message.id);
    }
  }
  taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0;
  return started;
}

function startPokemonCenter(config = {}, mainWindow) {
  attachWindow(mainWindow);
  const requestedTasks = Array.isArray(config.tasks) ? config.tasks : [config];
  const sharedValidation = validatePokemonProducts(config.products, config.inputs, config.quantity);
  const usesSharedProducts = requestedTasks.some(task => !task || task.products == null);
  const invalidTask = requestedTasks.some(task => {
    const validation = validatePokemonProducts(
      task && task.products != null ? task.products : config.products,
      task && task.inputs != null ? task.inputs : config.inputs,
      task && task.quantity != null ? task.quantity : config.quantity,
    );
    return validation.invalid.length || validation.tooMany || !validation.products.length;
  });
  if ((usesSharedProducts && (sharedValidation.invalid.length || sharedValidation.tooMany || !sharedValidation.products.length)) || invalidTask) return false;
  let validProfileIds = new Set();
  try {
    validProfileIds = new Set((dm.getProfiles() || [])
      .filter(profile => profile && profile.profileType === 'pokemoncenter')
      .map(profile => String(profile.id)));
  } catch {}
  const tasks = requestedTasks
    .filter(task => task && task.id && validProfileIds.has(String(task.profileId)));
  const products = sharedValidation.products;
  if (!tasks.length) return false;

  const batch = { ...config, products, tasks: tasks.map(task => rememberPokemonConfig(task, { ...config, products })) };
  pendingPokemonStarts.push(batch);
  for (const task of batch.tasks) {
    const id = String(task.id);
    pokemonTaskIds.add(id);
    engineTaskSites.register(id, POKEMON_SITE);
    pokemonStatus('Starting', '#868686', 'launching engine', id, 1, true);
  }
  lastStatusKeys = {};
  const seq = ++pokemonStartSeq;
  ensureServer(() => {
    if (seq !== pokemonStartSeq && !batch.tasks.some(task => pokemonTaskIds.has(String(task.id)))) return;
    spawnEngine();
    if (engineConn && engineConn.readyState === WebSocket.OPEN) flushPokemonStarts();
  });
  return true;
}

function editPokemonCenter(config = {}) {
  const requested = Array.isArray(config.tasks) ? config.tasks : [];
  const selected = requested.length
    ? requested.filter(task => task && pokemonTaskIds.has(String(task.id || '')))
    : [...pokemonTaskIds].map(id => ({ id }));
  if (!selected.length) return { ok: false, updated: 0, error: 'No selected Pokémon Center tasks are running.' };

  const invalidInput = selected.some(update => {
    const previous = pokemonTaskConfigs.get(String(update.id)) || {};
    const products = update.products != null ? update.products
      : (config.products != null ? config.products : previous.products);
    const inputs = update.inputs != null ? update.inputs : (config.inputs != null ? config.inputs : previous.inputs);
    const quantity = update.quantity != null ? update.quantity : (config.quantity != null ? config.quantity : previous.quantity);
    const validation = validatePokemonProducts(products, inputs, quantity);
    return validation.invalid.length || validation.tooMany;
  });
  if (invalidInput) {
    return { ok: false, updated: 0, error: 'Use up to three Pokémon Center SKUs, product URLs, or placeholder.' };
  }

  const tasks = selected.map(update => {
    const id = String(update.id);
    const previous = pokemonTaskConfigs.get(id) || { id };
    const { tasks: ignoredTasks, ...shared } = config;
    return rememberPokemonConfig({ ...previous, ...shared, ...update, id }, previous);
  });
  addPokemonRotationProfiles(tasks);
  sendConfigs({ tasks });
  const messages = tasks.map(task => pokemonMessage(task, task));
  if (!messages.every(message => message.profileId && message.item.length)) {
    return { ok: false, updated: 0, error: 'Every running task needs a profile and at least one product.' };
  }
  const ok = sendToEngine({ type: 'edit-tasks', messages });
  if (ok) {
    for (const message of messages) pokemonLog(`Watch list updated (${message.item.length} product${message.item.length === 1 ? '' : 's'})`, message.id);
  }
  return { ok, updated: ok ? messages.length : 0, error: ok ? '' : 'The native engine is not connected.' };
}

function setPokemonCenterTaskProxy(taskId, proxyListName) {
  const id = String(taskId || '');
  if (!pokemonTaskIds.has(id)) return false;
  const group = String(proxyListName || '').trim() || 'Local';
  if (group !== 'Local') {
    Object.assign(sentConfigs.proxies, buildProxyMap(group));
    sendConfigs();
  }
  const current = pokemonTaskConfigs.get(id) || { id };
  pokemonTaskConfigs.set(id, { ...current, proxyListName: group === 'Local' ? '' : group });
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id, proxyGroup: group }] });
}

function stopPokemonCenter(taskId) {
  const requestedId = String(taskId || '');
  const ids = requestedId ? [requestedId] : [...pokemonTaskIds];
  if (engineConn && ids.length) sendToEngine({ type: 'stop-tasks', messages: ids.map(id => ({ id })) });
  for (const id of ids) {
    pokemonTaskIds.delete(id);
    pokemonTaskConfigs.delete(id);
    engineTaskSites.remove(id);
    manualCaptchaManager.cancelTask(id);
    pokemonDone(id);
  }
  if (!requestedId) {
    pokemonStartSeq += 1;
    pendingPokemonStarts.length = 0;
  } else {
    for (let i = pendingPokemonStarts.length - 1; i >= 0; i -= 1) {
      pendingPokemonStarts[i].tasks = (pendingPokemonStarts[i].tasks || []).filter(task => String(task.id) !== requestedId);
      if (!pendingPokemonStarts[i].tasks.length) pendingPokemonStarts.splice(i, 1);
    }
  }
  if (pokemonTaskIds.size || runningTaskIds.size) {
    taskActive = true;
    return true;
  }
  taskActive = false;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
  beginTargetEngineStop(engineProc);
  return true;
}

function runningPokemonCenterCount() { return pokemonTaskIds.size; }

function decodeNativeTaskLog(value) {
  try {
    const input = Buffer.from(String(value || ''), 'base64');
    const key = Buffer.from('Zyn-Task-Log-v1');
    const output = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 1) output[i] = input[i] ^ key[i % key.length];
    return output.toString('utf8');
  } catch { return ''; }
}
