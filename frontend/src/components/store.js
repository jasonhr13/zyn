import { createStore } from 'redux';
import {
  isQueuedTargetProxyStatus,
  isTargetProxyRotationStatus,
  isTargetProxyStatusForGroup,
} from './target-proxy-status';
import { timestampLogLine, timestampLogLines } from './log-timestamp';

// Single-use bypass guard: a Queue-It qitq token dies after ONE redeem, so a token ever handed to a
// task must never re-enter the pool — even when a Discord reconnect ('ready') or a refreshQueuePasses
// history re-fetch re-broadcasts the same message. We track spent tokens with a TTL, and drop pool
// links that have gone stale or lack a parseable issue-time so the "queued" count stays honest.
const SPENT_TTL_MS = 20 * 60 * 1000; // keep a consumed token blocked past its Queue-It lifetime

const qitqOf  = (url) => (String(url).match(/[?&]qitq=([^&]+)/) || [])[1] || String(url);
const qittsOf = (url) => parseInt((String(url).match(/[?&]qitts=(\d+)/) || [])[1] || '0', 10);

// Max age of a pooled link, in seconds. 0 = no age limit (current behaviour — left as-is because it
// was deliberately disabled for testing). Set to e.g. 900 to stop handing tasks Queue-It tokens that
// have already expired: an expired token fails silently at checkout and burns the task's turn.
export const LINK_MAX_AGE_S = 0;

// spentQitqs survives a restart. Without this, relaunching mid-drop clears the spent set and the
// startup history re-fetch happily re-pools tokens that were already used — handing a dead link to a
// fresh task exactly when it matters most.
const SPENT_KEY = 'zyn.spentQitqs';
const PREVIOUS_SPENT_KEY = `${String.fromCharCode(104, 111, 112, 101)}.spentQitqs`;
function loadSpent() {
  try {
    const current = window.localStorage.getItem(SPENT_KEY);
    const previous = current == null ? window.localStorage.getItem(PREVIOUS_SPENT_KEY) : null;
    const raw = JSON.parse(current || previous || '{}');
    if (current == null && previous != null) {
      window.localStorage.setItem(SPENT_KEY, previous);
      window.localStorage.removeItem(PREVIOUS_SPENT_KEY);
    }
    const now = Date.now();
    const out = {};
    for (const k in raw) if (raw[k] > now) out[k] = raw[k];
    return out;
  } catch { return {}; }
}
function saveSpent(spent) {
  try { window.localStorage.setItem(SPENT_KEY, JSON.stringify(spent)); } catch {}
}
// Freshness cap REMOVED for testing — the pool is not pruned by age (only consumed/duplicate/malformed
// tokens are dropped). To restore: `return pool.filter(p => p.qitts && (Date.now()/1000 - p.qitts) <= 900);`
const prunePool  = (pool) => pool;
const pruneSpent = (spent) => { const now = Date.now(); const out = {}; for (const k in spent) if (spent[k] > now) out[k] = spent[k]; return out; };

const defaultState = {
  // 'dev' (unpacked/source) shows every module, including ones not ready to ship. 'beta' (packaged)
  // is the conservative default here so a not-yet-fetched real value can't flash hidden features to
  // a beta tester on first paint — page-handler corrects this synchronously right after mount.
  channel: 'beta',
  tasks: [],
  profiles: [],
  accounts: [],   // site logins (email + hasPassword flag only — never the password itself)
  proxies: { lists: [] },
  settings: {},
  discordStatus: { status: 'disconnected' },
  taskStatus: {},
  taskLogs: {},
  update: null,     // auto-update status: { state: checking|current|downloading|ready|error, version, percent }
  runtime: null,    // first-run Chromium/Wine/engine setup status from the main process
  lastOrders: {},   // profileId -> epoch ms of that profile's last placed order (persisted in main)
  cartUrlPool: [],  // Queue of queue-pass URLs from Discord, one per task
  spentQitqs: loadSpent(),   // qitq -> expiry ms; single-use guard, persisted across restarts
  // P-Bandai lives here rather than in the page's own state: React Router unmounts the page on a
  // tab switch, which destroyed `instances`/`logs` (the UI showed "nothing running" while the
  // browsers were still going) AND tore down the IPC listeners, so restock/checkout events that
  // arrived while you were on another tab were dropped for good.
  pbandai: {
    instances: {},   // instanceId -> { tag, state, detail }
    logs: [],
    multi: false,    // once >1 account has run, tag every log line with its account
    // profileId -> true, for the launch list. {} = none selected (the default — nothing is picked until
    // you tick accounts or a group chip). null would mean "all"; we deliberately start empty so a fresh
    // page selects nothing.
    selected: {},
    rotate: false,   // Rotate Mode active (an order frees its slot for the next profile)
    // connection: which proxies to use. 'inhouse1'|'inhouse2'|'inhouse3'|'inhousemix' | 'list:<name>'
    // (a personal Proxies-page list) | 'none' (home IP). Derived into useVpn/inHousePool/proxyListName
    // at send time in pbandai.js.
    // Default: home IP. The in-house pools are down, so a default that points at them makes
    // every new task fail on a connection the user never chose. Pick a list on the page.
    connection: 'none',
    qty: 1, profileId: '', useVpn: true, inHousePool: '1', turbo: false, headless: false, drop: false, interval: 15, watchlist: 'N2903432003',
  },
  // Pokemon Center US: profile-based guest checkout tasks driven by the shared native Go engine.
  // Runtime state stays here so switching pages never loses task status or logs.
  pokemon: {
    products: [{ id: 'pc_product_1', input: '', quantity: '1' }],
    tasks: [],
    taskStatus: {},
    taskInputs: {},
    taskLogs: {},
    logs: [],
    monitorDelay: '3000',
    retryDelay: '3000',
    loopCheckout: false,
    waitForQueue: false,
    queueEntryDelay: '0',
    allInstock: false,
  },
  // Target: one compiled Go engine instance driving MANY checkout tasks plus a single shared
  // monitor. Lives in the store (not page state) for the same reason as pokemon above — the page
  // unmounts on a tab switch, but the engine keeps running and its status/log events must survive
  // being off-screen.
  //
  // Shape of the module, which mirrors how the engine actually works:
  //   skus     — ONE shared watch list (newline separated). A single monitor task watches all of
  //              them; every checkout task is handed the whole list, so `matchKeys()` makes each
  //              task fire on whichever SKU restocks first rather than being pinned to one.
  //   tasks[]  — checkout tasks. A task selects an ACCOUNT; its profile is resolved by matching
  //              profile.email to account.email (see resolveProfileForAccount), so there is no
  //              separate profile picker to keep in sync.
  target: {
    skus: '',                 // newline-separated TCINs or full Target URLs; shared by all tasks
    tasks: [],                // [{ id, accountId, proxyListName, cardId, qty }]
    taskStatus: {},           // taskId -> { state, label, color, detail }
    proxyStatus: {},          // taskId -> transient live-proxy result; never replaces taskStatus
    taskLogs: {},             // taskId -> [lines]
    monitorStatus: null,      // { state, label, color } | null when the monitor isn't running
    otpPending: [],           // [{ email, taskId, since }] logins the engine is blocked on
    logs: [],                 // module-level log (engine lifecycle, monitor, farmer)
    // Defaults applied to newly created tasks.
    proxyListName: '',
    cardId: '',
    qty: 2,
    useFillerItem: false,
    endless: false,
  },
  // Walmart: same compiled Go engine as Target, own instance (port 8728). Lives in the store
  // (not page state) so the engine's status/log events survive the page unmounting on a tab switch.
  walmart: {
    instance: null,   // { state, label, color, detail } | null (not running)
    logs: [],
    proxyListName: '',
    accountId: '',
    profileId: '',
    input: '',
    quantity: '1',
    maxPrice: '',
    endless: false,
  },
  // Riot Games: monitors for account registrations and manages multiple account generation.
  // Similar to pbandai, this lives in the store to persist across page unmounts.
  riotgames: {
    instances: {},   // instanceId -> { tag, state, detail }
    logs: [],
    multi: false,    // once >1 account has run, tag every log line with its account
    selected: null,  // profileId -> true for the launch list. null = all profiles
    // Default: home IP. The in-house pools are down, so a default that points at them makes
    // every new task fail on a connection the user never chose. Pick a list on the page.
    connection: 'none',
    qty: 1, interval: 15, watchlist: '',
  },
};

export function reducer(state = defaultState, action) {
  switch (action.type) {
    case 'update':
      return Object.assign({}, state, action.obj);

    case 'queuePass': {
      // Pool entries are { cartUrl, proxy, qitq, qitts } — proxy is the IP the queue was cleared
      // through; qitq is the (single-use) bypass token; qitts is when it was issued (epoch seconds).
      const url = action.cartUrl || '';
      const qitq = qitqOf(url);
      const qitts = qittsOf(url);
      const spentQitqs = pruneSpent(state.spentQitqs);
      const cartUrlPool = prunePool(state.cartUrlPool);
      // Reject if: no parseable issue-time (can't age-verify → could be stale), OR the token was
      // already consumed by a task (single-use), OR it's already pooled. This is what stops a
      // reconnect/history re-fetch from re-broadcasting a spent pass to a second task (= queue dump).
      //
      // action.sim is the `.sim` drop rehearsal: it replays real historical links, which are spent
      // by definition, so the single-use guard is bypassed (and the token un-spent) or the command
      // would work exactly once. Only ever set by the local simulator, never by a live pass.
      if (action.sim) delete spentQitqs[qitq];   // spentQitqs is a fresh object from pruneSpent
      const dupe = !action.sim && (spentQitqs[qitq] || cartUrlPool.some(p => p.qitq === qitq));
      if (!qitts || dupe) {
        if (!qitts) console.warn('[queuePass] dropped link with no qitts:', url.slice(0, 80));
        return { ...state, spentQitqs, cartUrlPool };
      }
      // A replayed link may still be pooled from a previous .sim — drop the stale copy. filter, not
      // splice: prunePool returns state.cartUrlPool by reference, so splicing would mutate state.
      const basePool = action.sim ? cartUrlPool.filter(p => p.qitq !== qitq) : cartUrlPool;
      const entry = { cartUrl: url, proxy: action.proxy || null, qitq, qitts };
      return { ...state, spentQitqs, cartUrlPool: [...basePool, entry] };
    }

    case 'consumeLinks': {
      // A link handed to a task is spent forever (single-use). Remove it from the pool AND record it
      // as spent so a later reconnect/history re-fetch can never hand the same token to another task.
      const spentQitqs = pruneSpent(state.spentQitqs);
      const exp = Date.now() + SPENT_TTL_MS;
      const gone = new Set(action.qitqs || []);
      for (const q of gone) spentQitqs[q] = exp;
      saveSpent(spentQitqs);
      return { ...state, spentQitqs, cartUrlPool: prunePool(state.cartUrlPool).filter(p => !gone.has(p.qitq)) };
    }

    // ── P-Bandai ──────────────────────────────────────────────────────────────
    case 'pbandaiSet':
      return { ...state, pbandai: { ...state.pbandai, ...action.obj } };

    case 'pbandaiLastOrder':   // main pushes a new order timestamp for a profile
      return { ...state, lastOrders: { ...state.lastOrders, [action.profileId]: action.ts } };

    // Launching N accounts fires N dispatches inside one React event handler. React batches those,
    // so props never refresh between them — building the instances map in the component meant each
    // dispatch spread a stale map and erased the previous account, leaving every launched engine
    // but the last with no status row and no Stop button. Merging here composes against live state.
    case 'pbandaiLaunch': {
      const pb = state.pbandai;
      if (pb.instances[action.id]) return state;   // already running — checked against LIVE state
      const instances = { ...pb.instances, [action.id]: { tag: action.tag, state: 'starting', detail: action.detail || '' } };
      return { ...state, pbandai: { ...pb, instances, multi: pb.multi || Object.keys(instances).length > 1 } };
    }

    case 'pbandaiLog': {
      const pb = state.pbandai;
      const line = timestampLogLine((pb.multi && action.tag ? `[${action.tag}] ` : '') + action.line, action.at);
      return { ...state, pbandai: { ...pb, logs: [...pb.logs.slice(-800), line] } };
    }

    case 'pbandaiStatus': {
      const pb = state.pbandai;
      if (!action.instanceId) return state;
      const prev = pb.instances[action.instanceId] || { tag: action.tag };
      return { ...state, pbandai: { ...pb, instances: { ...pb.instances,
        [action.instanceId]: { ...prev, tag: prev.tag || action.tag, state: action.state, detail: action.detail } } } };
    }

    case 'pbandaiDone': {
      const pb = state.pbandai;
      if (!action.instanceId || !pb.instances[action.instanceId]) return state;
      const instances = { ...pb.instances };
      delete instances[action.instanceId];
      return { ...state, pbandai: { ...pb, instances } };
    }

    // ── Pokemon Center ────────────────────────────────────────────────────────
    case 'pokemonSet':
      return { ...state, pokemon: { ...state.pokemon, ...action.obj } };

    case 'pokemonTasksAdd':
      return { ...state, pokemon: { ...state.pokemon,
        tasks: [...state.pokemon.tasks, ...(action.tasks || [])] } };

    case 'pokemonTaskUpdate':
      return { ...state, pokemon: { ...state.pokemon,
        tasks: state.pokemon.tasks.map(task => task.id === action.id ? { ...task, ...action.obj } : task) } };

    case 'pokemonTaskDelete': {
      const taskStatus = { ...state.pokemon.taskStatus }; delete taskStatus[action.id];
      const taskInputs = { ...state.pokemon.taskInputs }; delete taskInputs[action.id];
      const taskLogs = { ...state.pokemon.taskLogs }; delete taskLogs[action.id];
      return { ...state, pokemon: { ...state.pokemon,
        tasks: state.pokemon.tasks.filter(task => task.id !== action.id), taskStatus, taskInputs, taskLogs } };
    }

    case 'pokemonLaunch': {
      const ids = action.taskIds || [];
      const taskStatus = { ...state.pokemon.taskStatus };
      for (const id of ids) taskStatus[id] = { state: 'Starting', label: 'Starting', color: '#868686', detail: '', running: true };
      return { ...state, pokemon: { ...state.pokemon, taskStatus } };
    }

    case 'pokemonLog': {
      const incoming = Array.isArray(action.lines) ? action.lines : (action.line != null ? [action.line] : []);
      if (!incoming.length) return state;
      const timestamped = timestampLogLines(incoming, action.at);
      if (!action.taskId) return { ...state, pokemon: { ...state.pokemon,
        logs: [...state.pokemon.logs, ...timestamped].slice(-800) } };
      const previous = state.pokemon.taskLogs[action.taskId] || [];
      return { ...state, pokemon: { ...state.pokemon, taskLogs: { ...state.pokemon.taskLogs,
        [action.taskId]: [...previous, ...timestamped].slice(-400) } } };
    }

    case 'pokemonStatus': {
      if (!action.taskId) return state;
      const previous = state.pokemon.taskStatus[action.taskId] || {};
      return { ...state, pokemon: { ...state.pokemon, taskStatus: { ...state.pokemon.taskStatus,
        [action.taskId]: {
          ...previous, state: action.state, label: action.label || action.state,
          color: action.color || '#6DACFF', detail: action.detail || '',
          taskState: action.taskState === undefined ? previous.taskState : action.taskState,
          running: action.running === undefined ? previous.running : action.running,
        } } } };
    }

    case 'pokemonInput':
      if (!action.taskId) return state;
      return { ...state, pokemon: { ...state.pokemon, taskInputs: { ...state.pokemon.taskInputs,
        [action.taskId]: { productName: action.productName || '', productSize: action.productSize || '' } } } };

    case 'pokemonDone': {
      if (!action.taskId) return state;
      const taskStatus = { ...state.pokemon.taskStatus }; delete taskStatus[action.taskId];
      return { ...state, pokemon: { ...state.pokemon, taskStatus } };
    }

    // ── Target ────────────────────────────────────────────────────────────────
    case 'targetSet':
      return { ...state, target: { ...state.target, ...action.obj } };

    // Create N tasks in one go (the "quantity" field on the create form). Each account produces
    // its own task, which is what makes bulk creation useful — one task per account, profile
    // resolved from the account's email at launch time.
    case 'targetTasksAdd':
      return { ...state, target: { ...state.target, tasks: [...state.target.tasks, ...(action.tasks || [])] } };

    case 'targetTaskUpdate':
      return { ...state, target: { ...state.target,
        tasks: state.target.tasks.map(t => (t.id === action.id ? { ...t, ...action.obj } : t)) } };

    case 'targetTaskDelete': {
      const status = { ...state.target.taskStatus }; delete status[action.id];
      const proxyStatus = { ...state.target.proxyStatus }; delete proxyStatus[action.id];
      const logs = { ...state.target.taskLogs }; delete logs[action.id];
      return { ...state, target: { ...state.target,
        tasks: state.target.tasks.filter(t => t.id !== action.id),
        taskStatus: status, proxyStatus, taskLogs: logs } };
    }

    case 'targetTasksClear':
      return { ...state, target: { ...state.target, tasks: [], taskStatus: {}, proxyStatus: {}, taskLogs: {} } };

    // Marks a live proxy command as outstanding. It starts hidden: the selector already confirms
    // delivery, and the status column should only change when the engine reports the real outcome.
    case 'targetProxyEditSent':
      return { ...state, target: { ...state.target,
        proxyStatus: { ...state.target.proxyStatus, [action.taskId]: {
          pending: true, hidden: true, at: action.at, group: action.group,
        } } } };

    // Per-task log. The engine tags every line with the task it came from (taskStatus.taskID in
    // bot-base/task/schema.go), so lines land on the right card instead of one shared firehose.
    // Lines with no id are module-level (engine lifecycle, farmer, monitor) and go to target.logs.
    case 'targetLog': {
      const incoming = Array.isArray(action.lines) ? action.lines : (action.line != null ? [action.line] : []);
      if (!incoming.length) return state;
      const timestamped = timestampLogLines(incoming, action.at);
      if (!action.taskId) {
        return { ...state, target: { ...state.target, logs: [...state.target.logs, ...timestamped].slice(-800) } };
      }
      const prev = state.target.taskLogs[action.taskId] || [];
      return { ...state, target: { ...state.target,
        taskLogs: { ...state.target.taskLogs, [action.taskId]: [...prev, ...timestamped].slice(-400) } } };
    }

    case 'targetStatus': {
      const entry = {
        state: action.state,
        label: action.label || action.state,
        color: action.color || '#6DACFF',
        detail: action.detail || '',
        // The engine's own step, used to group tasks (see STATE_* in pages/target.js). Carried
        // forward when an update omits it so a status line without one cannot blank the group a
        // task is already in.
        taskState: action.taskState,
        running: action.running,
      };
      if (!action.taskId) return { ...state, target: { ...state.target, monitorStatus: entry } };

      // A runtime proxy edit is feedback about the connection, not a new task step. Only intercept
      // it while a selector command is actually outstanding; that avoids mistaking an unrelated
      // engine phrase such as "Switched To Out of Stock" for proxy feedback.
      const proxyEdit = state.target.proxyStatus[action.taskId];
      if (proxyEdit && isTargetProxyRotationStatus(entry.label)) {
        return state;
      }
      if (proxyEdit && proxyEdit.pending && isTargetProxyStatusForGroup(entry.label, proxyEdit.group)) {
        return { ...state, target: { ...state.target,
          proxyStatus: { ...state.target.proxyStatus, [action.taskId]: {
            ...proxyEdit,
            ...entry,
            at: action.receivedAt,
            pending: isQueuedTargetProxyStatus(entry.label),
            hidden: false,
          } },
        } };
      }
      const prev = state.target.taskStatus[action.taskId];
      if (prev && entry.taskState === undefined) entry.taskState = prev.taskState;
      if (prev && entry.running === undefined) entry.running = prev.running;
      const proxyStatus = { ...state.target.proxyStatus };
      // A completed edit remains hidden as a narrow guard against late "Rotating Proxy" chatter.
      // The first genuine task step proves the engine has moved on and retires that guard.
      if (proxyEdit && !proxyEdit.pending) delete proxyStatus[action.taskId];
      return { ...state, target: { ...state.target,
        taskStatus: { ...state.target.taskStatus, [action.taskId]: entry }, proxyStatus } };
    }

    case 'targetOtp':
      return { ...state, target: { ...state.target, otpPending: action.pending || [] } };

    // Queued edits stay armed after their notice fades because the engine will send a second status
    // when the Shape-pinned step ends. Completed/failed edits stay hidden as a guard against the
    // engine's late "Rotating Proxy" chatter, then retire on the next genuine task step.
    case 'targetProxyStatusClear': {
      const current = state.target.proxyStatus[action.taskId];
      if (!current || current.at !== action.at) return state;
      const proxyStatus = { ...state.target.proxyStatus };
      proxyStatus[action.taskId] = { ...current, hidden: true };
      return { ...state, target: { ...state.target, proxyStatus } };
    }

    case 'targetDone': {
      if (!action.taskId) return { ...state, target: { ...state.target, monitorStatus: null } };
      const status = { ...state.target.taskStatus }; delete status[action.taskId];
      const proxyStatus = { ...state.target.proxyStatus }; delete proxyStatus[action.taskId];
      return { ...state, target: { ...state.target, taskStatus: status, proxyStatus } };
    }

    // ── Walmart ───────────────────────────────────────────────────────────────
    case 'walmartSet':
      return { ...state, walmart: { ...state.walmart, ...action.obj } };

    case 'walmartLaunch':
      return { ...state, walmart: { ...state.walmart, instance: { state: 'Starting', label: 'Starting', color: '#868686', detail: '' } } };

    case 'walmartLog':
      return { ...state, walmart: { ...state.walmart,
        logs: [...state.walmart.logs.slice(-800), timestampLogLine(action.line, action.at)] } };

    case 'walmartStatus':
      return { ...state, walmart: { ...state.walmart, instance: {
        state: action.state,
        label: action.label || action.state,
        color: action.color || '#6DACFF',
        detail: action.detail || '',
      } } };

    case 'walmartDone':
      return { ...state, walmart: { ...state.walmart, instance: null } };

    // ── Riot Games ────────────────────────────────────────────────────────────
    case 'riotgamesSet':
      return { ...state, riotgames: { ...state.riotgames, ...action.obj } };

    case 'riotgamesLaunch': {
      const rg = state.riotgames;
      if (rg.instances[action.id]) return state;
      const instances = { ...rg.instances, [action.id]: { tag: action.tag, state: 'starting', detail: action.detail || '' } };
      return { ...state, riotgames: { ...rg, instances, multi: rg.multi || Object.keys(instances).length > 1 } };
    }

    case 'riotgamesLog': {
      const rg = state.riotgames;
      const line = timestampLogLine((rg.multi && action.tag ? `[${action.tag}] ` : '') + action.line, action.at);
      return { ...state, riotgames: { ...rg, logs: [...rg.logs.slice(-800), line] } };
    }

    case 'riotgamesStatus': {
      const rg = state.riotgames;
      if (!action.instanceId) return state;
      const prev = rg.instances[action.instanceId] || { tag: action.tag };
      return { ...state, riotgames: { ...rg, instances: { ...rg.instances,
        [action.instanceId]: { ...prev, tag: prev.tag || action.tag, state: action.state, detail: action.detail } } } };
    }

    case 'riotgamesDone': {
      const rg = state.riotgames;
      if (!action.instanceId || !rg.instances[action.instanceId]) return state;
      const instances = { ...rg.instances };
      delete instances[action.instanceId];
      return { ...state, riotgames: { ...rg, instances } };
    }

    case 'taskStarted': {
      const taskStatus = { ...state.taskStatus };
      taskStatus[action.taskId] = { status: 'running', threads: {} };
      return { ...state, taskStatus };
    }

    case 'taskStopped': {
      const taskStatus = { ...state.taskStatus };
      if (taskStatus[action.taskId]) {
        taskStatus[action.taskId] = { ...taskStatus[action.taskId], status: 'idle' };
      }
      return { ...state, taskStatus };
    }

    case 'taskDone': {
      const taskStatus = { ...state.taskStatus };
      if (taskStatus[action.taskId]) {
        taskStatus[action.taskId] = { ...taskStatus[action.taskId], status: 'done' };
      }
      return { ...state, taskStatus };
    }

    case 'taskThreadStatus': {
      const taskStatus = { ...state.taskStatus };
      if (!taskStatus[action.taskId]) taskStatus[action.taskId] = { status: 'running', threads: {} };
      taskStatus[action.taskId] = {
        ...taskStatus[action.taskId],
        threads: {
          ...taskStatus[action.taskId].threads,
          [action.threadId]: {
            ...(taskStatus[action.taskId].threads[action.threadId] || {}),
            status: action.status,
          },
        },
      };
      return { ...state, taskStatus };
    }

    case 'taskLog': {
      const taskLogs = { ...state.taskLogs };
      const existing = taskLogs[action.taskId] || [];
      const updated = [...existing, { threadId: action.threadId, line: timestampLogLine(action.line, action.at) }];
      taskLogs[action.taskId] = updated.slice(-500);

      // Also update lastLog on the thread
      const taskStatus = { ...state.taskStatus };
      if (!taskStatus[action.taskId]) taskStatus[action.taskId] = { status: 'running', threads: {} };
      taskStatus[action.taskId] = {
        ...taskStatus[action.taskId],
        threads: {
          ...taskStatus[action.taskId].threads,
          [action.threadId]: {
            ...(taskStatus[action.taskId].threads[action.threadId] || { status: 'running' }),
            lastLog: action.line,
          },
        },
      };

      return { ...state, taskLogs, taskStatus };
    }

    default:
      return state;
  }
}

const Store = createStore(reducer);

// ── queue-pass claiming ──────────────────────────────────────────────────────────────────────
// Newest-first; a link with no parseable issue time is unusable and never pooled anyway.
export const freshPool = (pool) => {
  let list = (pool || []).slice();
  if (LINK_MAX_AGE_S > 0) {
    const now = Date.now() / 1000;
    list = list.filter(p => p.qitts && (now - p.qitts) <= LINK_MAX_AGE_S);
  }
  return list.sort((a, b) => (b.qitts || 0) - (a.qitts || 0));
};

// THE claim path — every caller must go through this. It reads the pool from the live store and
// dispatches the consume in the SAME synchronous turn, so two claims can never see the same link.
//
// Callers used to read `this.props.cartUrlPool` instead. React props only refresh on re-render, so
// starting several tasks in quick succession had them all read the same pre-consume snapshot and
// take fresh[0] — every browser opening on one identical link. That is a local race only: it cannot
// dedupe against OTHER users' apps, which pull the same Discord messages into their own pools.
export function claimLinks(count) {
  const n = Math.max(0, count | 0);
  if (!n) return [];
  const take = freshPool(Store.getState().cartUrlPool).slice(0, n);
  if (take.length) Store.dispatch({ type: 'consumeLinks', qitqs: take.map(l => l.qitq) });
  return take;
}
// Diagnostic hook: the renderer has been OOM-killed mid-run (4.9 GB in ~30 s). Main samples this
// from outside via executeJavaScript to see which slice is actually growing. Read-only, no cost.
try {
  window.__zynDebug = {
    sizes: () => {
      const s = Store.getState();
      const out = {};
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (Array.isArray(v)) out[k] = v.length;
        else if (v && Array.isArray(v.logs)) out[k + '.logs'] = v.logs.length;
      }
      if (window.performance && window.performance.memory) {
        out.jsHeapMB = Math.round(window.performance.memory.usedJSHeapSize / 1048576);
      }
      out.domNodes = document.getElementsByTagName('*').length;
      return out;
    },
  };
} catch (e) {}
export default Store;
