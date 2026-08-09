// ── Pokemon Center US: native checkout tasks on the shared Go transport ─────────
const POKEMON_SITE = engineContract.SITES.POKEMON_CENTER_US;
const pokemonTaskIds = new Set();
const pokemonTaskConfigs = new Map();
const pendingPokemonStarts = [];
let pokemonStartSeq = 0;

function pokemonStatus(state, color, detail, taskId, taskState, running) {
  toRenderer('pokemonStatus', {
    taskId: String(taskId || ''), state: String(state || ''), label: String(state || ''),
    color: String(color || ''), detail: String(detail || ''),
    taskState: typeof taskState === 'number' ? taskState : undefined,
    running: typeof running === 'boolean' ? running : undefined,
  });
}

function pokemonLog(line, taskId = '') {
  let value = redactProxies(String(line || '')).replace(/[\r\n]+/g, ' ').trim();
  if (!value) return;
  if (value.length > LOG_LINE_MAX) value = value.slice(0, LOG_LINE_MAX) + '…';
  toRenderer('pokemonLog', { taskId: String(taskId || ''), line: value });
}

function pokemonDone(taskId = '') {
  toRenderer('pokemonDone', { taskId: String(taskId || '') });
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

function pokemonItems(inputs, quantity) {
  const qty = String(Math.max(1, parseInt(quantity, 10) || 1));
  return pokemonInputs(inputs).map(input => ({
    id: input, monitorInput: input, quantity: qty, maxPrice: '', color: '', sizes: [],
  }));
}

function pokemonMessage(task = {}, shared = {}) {
  const inputs = pokemonInputs(task.inputs != null ? task.inputs : shared.inputs);
  const quantity = task.quantity != null ? task.quantity : shared.quantity;
  const items = pokemonItems(inputs, quantity);
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
    inputs: pokemonInputs(task.inputs != null ? task.inputs : shared.inputs),
  };
  pokemonTaskConfigs.set(String(task.id), merged);
  return merged;
}

// Loop Checkout rotates inside the selected profile's first group. The engine replaces its entire
// profile store on send-configs, so every rotation candidate must be present even when it does not
// own an initial task.
function addPokemonRotationProfiles(tasks) {
  let profiles = [];
  try { profiles = dm.getProfiles() || []; } catch {}
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
  if (!engineConn || engineConn.readyState !== WebSocket.OPEN) return 0;
  let started = 0;
  while (pendingPokemonStarts.length) {
    const config = pendingPokemonStarts.shift() || {};
    const tasks = (config.tasks || []).filter(task => task && pokemonTaskIds.has(String(task.id || '')));
    if (!tasks.length) continue;
    addPokemonRotationProfiles(tasks);
    sendConfigs({ tasks });
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
    if (!valid.length) continue;
    if (sendToEngine({ type: 'start-tasks', messages: valid })) {
      started += valid.length;
      for (const message of valid) pokemonLog('Pokémon Center task started', message.id);
    }
  }
  taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0;
  return started;
}

function startPokemonCenter(config = {}, mainWindow) {
  attachWindow(mainWindow);
  const sharedValidation = validatePokemonInputs(config.inputs);
  const invalidTask = (Array.isArray(config.tasks) ? config.tasks : [config]).some(task => {
    const validation = validatePokemonInputs(task && task.inputs != null ? task.inputs : config.inputs);
    return validation.invalid.length || validation.tooMany;
  });
  if (sharedValidation.invalid.length || sharedValidation.tooMany || invalidTask) return false;
  const tasks = (Array.isArray(config.tasks) ? config.tasks : [config])
    .filter(task => task && task.id && task.profileId);
  const inputs = sharedValidation.inputs;
  if (!tasks.length || !inputs.length) return false;

  const batch = { ...config, inputs, tasks: tasks.map(task => rememberPokemonConfig(task, { ...config, inputs })) };
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
    const value = update.inputs != null ? update.inputs : (config.inputs != null ? config.inputs : previous.inputs);
    const validation = validatePokemonInputs(value);
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
  killTree(engineProc);
  engineProc = null;
  return true;
}

function runningPokemonCenterCount() { return pokemonTaskIds.size; }

function decodeNativeTaskLog(value) {
  try {
    const input = Buffer.from(String(value || ''), 'base64');
    const key = Buffer.from('PolarAIO-Task-Log-v1');
    const output = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 1) output[i] = input[i] ^ key[i % key.length];
    return output.toString('utf8');
  } catch { return ''; }
}
