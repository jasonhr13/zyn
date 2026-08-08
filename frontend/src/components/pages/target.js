import React, { Component, createRef } from 'react';
import ReactDOM from 'react-dom';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

// Target runs ONE shared monitor over a list of SKUs plus many checkout tasks. Every task watches
// the whole list (see sendStart in target-engine.js), so whichever SKU restocks first is the one
// they all fire on — tasks are not pinned to a product.
//
// A task selects an ACCOUNT only. Its profile is resolved by matching profile.email to the
// account's email, so to run account1@gmail.com there must be a profile whose email is
// account1@gmail.com. That removes the "which profile goes with which account" bookkeeping
// entirely, at the cost of requiring the two to be named consistently — which the UI surfaces
// per row rather than failing at checkout.

// Built-in Target drop pools, decrypted in main from the shipped .enc files. Kept in sync with
// INHOUSE_POOLS in target-engine.js — these strings ARE the proxy group names sent to the engine,
// so the two lists must match exactly. A mismatch surfaces as "invalid group" on every rotation,
// which the user has no way to fix from the UI.
const INHOUSE_TARGET = '727OPTARGET';
const INHOUSE_TARGET_2 = 'TARGETDROP2';

const uid = () => 't_' + Math.random().toString(36).slice(2, 10);

// "Local" is stored as the empty string everywhere else, which cannot be told apart from a select's
// "nothing chosen" value. Only the bulk dropdown needs the distinction.
const LOCAL_SENTINEL = '__local__';

// Only explicitly tagged Target accounts can be assigned to a Target task.
const siteOf = (a) => String((a && a.site) || '').toLowerCase();

// Local panel styling. `.panel-header` renders its children inline, which ran the title straight
// into the meta text ("Watch List0 valid"), so spacing is set explicitly here.
const HEAD = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: '0 14px', height: 40, boxSizing: 'border-box', flexShrink: 0,
  borderBottom: '1px solid var(--panel-border)',
};
// Shared by the watch-list textarea AND the ghost layer painted behind it. One object, because the
// two only line up while their font, size, line-height and padding are identical — as two separate
// style blocks they drift the moment either is touched.
// Kept as numbers, because the per-line hover below derives which row the pointer is over from
// them. A textarea has no per-line elements to hover, so the line index is computed — and that only
// works while these are the real metrics of both layers.
const LIST_LINE_H = 18;
const LIST_PAD_TOP = 6;
const LIST_BORDER = 1;   // .form-input's border, part of the offset to the first line's top
const LIST_TEXT = {
  fontFamily: 'monospace', fontSize: 12, lineHeight: LIST_LINE_H + 'px',
  padding: LIST_PAD_TOP + 'px 8px', boxSizing: 'border-box',
};

// The header chips (BANK SIZE, MONITOR, COOKIE BANK). One object, because they sit stacked and any
// difference reads as a mistake — and they DID differ: the chip holding an <input> was ~5px taller,
// since the input brought its own padding and border. A fixed height with border-box is what makes
// a box containing a control the same size as a box containing text.
const CHIP = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '0 11px',
  height: 30, boxSizing: 'border-box',
  border: '1px solid var(--panel-border)', borderRadius: 7, fontSize: 11,
  background: 'var(--panel-bg-alt, rgba(0,0,0,.15))',
};

const HEAD_TITLE = { fontSize: 12, fontWeight: 700, letterSpacing: .3 };
const HEAD_META = { fontSize: 11, color: 'var(--muted)', fontWeight: 500 };

// Accepts bare TCINs or pasted Target URLs (.../A-1234567). Mirrors parseTcinFromInput in the Go
// engine so what the UI shows as valid is exactly what the engine will accept.
function parseTcin(line) {
  const s = String(line || '').trim();
  if (!s) return '';
  // Leading digits win outright, because a line may carry the product name after the number
  // ("1012055696 - Prismatic Evolutions Booster Bundle"). Running the A- search first would find an
  // "A-" inside a product NAME and silently drop that SKU from the watch list.
  const lead = (s.match(/^(\d{6,})/) || [])[1];
  if (lead) return lead;
  const m = s.toUpperCase().lastIndexOf('A-');
  const rest = m >= 0 ? s.slice(m + 2) : s;
  const digits = (rest.match(/^\d+/) || [])[0] || '';
  return digits;
}

// Undo the annotation an earlier build wrote INTO the box. The names belong behind the text, not
// in it — as real content they were selectable, copyable, and part of what you had to edit around.
// Only lines that are exactly "<tcin> - <something>" are touched, so nothing hand-typed is lost.
function stripSkuNames(raw) {
  const lines = String(raw || '').split('\n');
  let changed = false;
  const next = lines.map(l => {
    const m = l.match(/^\s*(\d{6,})\s*-\s*\S.*$/);
    if (!m) return l;
    changed = true;
    return m[1];
  });
  return changed ? next.join('\n') : null;
}

const parseSkuBox = (raw) => String(raw || '')
  .split(/[\n,]/).map(parseTcin).filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i);   // de-dupe: the same SKU twice is a wasted monitor slot

// Engine task steps, forwarded verbatim by target-engine.js from bot-base/task/constants/status.go.
// Grouping reads THESE, not the wording of a status line: the engine rephrases its statuses freely,
// and a group that silently stopped matching is worse than no group at all.
const STATE_CARTED = 2;
const STATE_DECLINED = 4;
const COLOR_RED = '#fb5454';   // constants.Colors.RED — every engine failure status carries it

// Which bucket a task is in, or null when it has not started. Order matters: a declined task is
// also "running" as far as the engine is concerned, and the useful answer is the one you would act
// on — declines need restarting, running tasks need stopping.
function groupOfStatus(st) {
  if (!st) return null;
  if (st.taskState === STATE_DECLINED) return 'error';
  if (String(st.color || '').toLowerCase() === COLOR_RED) return 'error';
  if (st.taskState === STATE_CARTED) return 'carted';
  if (st.running === false) return null;
  return 'running';
}

const GROUPS = [
  { key: 'running', icon: '▶', label: 'running', color: '#6DACFF' },
  { key: 'carted', icon: '●', label: 'carted', color: '#34ca6e' },
  { key: 'error', icon: '▲', label: 'error / declined', color: COLOR_RED },
];

// The monitor's own status, said the way an operator reads it. "Getting Product(s)" is the engine
// describing its HTTP call; what the reader wants to know is simply whether stock is there yet.
function monitorLabel(st) {
  const raw = String((st && st.label) || '').trim();
  if (!raw) return '';
  if (/getting product/i.test(raw)) return 'Refreshing';
  if (/out of stock/i.test(raw)) return 'Out of Stock';
  if (/in stock/i.test(raw)) return 'In Stock';
  return raw;
}

function StatusPill({ st }) {
  const label = (st && st.label) || 'Idle';
  const color = (st && st.color) || '#6b7280';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
      color, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

class Target extends Component {
  logBox = createRef();
  ghostBox = createRef();
  state = {
    // Home IP by default — the built-in pools are down. NOTE: redsky 403s home IPs, so a
    // Target task left on Local cannot monitor; pick a working list before a drop.
    draft: { accountIds: [], proxyListName: '' },
    // The farmer's own pool. Separate from any task's, because its cookies are shared by ALL
    // tasks and it should not silently inherit whichever one sorts first.
    harvesterProxyList: '',
    expanded: null, filter: '', bank: null, copied: null,
    // { id, at } for the last live proxy edit accepted by the engine bridge. The backend may queue
    // it through a Shape-bound step, so this is intentionally not presented as final confirmation.
    proxySwitched: null,
    // Where a carted task goes when Target throttles its checkout. Always active — the selector is
    // the whole setting. Local (the home IP) is the default destination.
    throttleFallbackGroup: 'Local',
    // id -> true for every ticked row. An object rather than a Set so setState comparisons stay
    // shallow and React re-renders normally.
    selected: {},
    // The last row picked WITHOUT shift. Shift-click selects everything between it and the row you
    // click, so it deliberately survives a shift-click — that is what lets you widen and narrow a
    // range from one fixed end instead of re-anchoring on every click.
    anchorId: null,
    // { x, y } for the right-click menu, or null. Screen coordinates, because the menu is rendered
    // fixed: the task list scrolls, and a menu positioned inside it would drift away from the row.
    menu: null,
    // tcin -> product name, read from the on-disk cache at mount so the list is already annotated
    // on launch rather than blank until a lookup finishes.
    skuTitles: {},
    // Cookie bank cap, mirrored from settings. Lives here as well as in Settings → Target because
    // this is where you watch the bank fill, and the control that stops it filling belongs beside it.
    cookieBank: '',
    // Cap on how fast a BANKED reserve may be drained, mirrored from settings. Blank = unlimited,
    // which is what shipped before it existed.
    cookieDrain: '',
    // The single TCIN the pointer is currently over, or '' when it is between/past lines. Drives
    // the highlight in the hover panel.
    hoverSku: '',
    // Hovering the watch list lifts the SKUs to full white. At rest they sit at the normal input
    // colour, which is close in weight to the ghosted names behind them; on hover — the moment you
    // are actually reading a row to match a number against its product — the number wins.
    skuHover: false,
  };

  componentDidMount() {
    // The farmer's pool is read back here, not just defaulted in state — the ENGINE reads it from
    // settings, so a selector that resets to the default on every launch would show one pool while
    // a different one was actually harvesting.
    try {
      const st = ipcRenderer.sendSync('getSettings') || {};
      // Same migration as the tasks, for the two settings that can also name a built-in pool.
      // The harvester one matters most: the ENGINE reads it from settings, so leaving it pointing at
      // a removed pool would keep farming through a group that no longer resolves while the selector
      // showed blank. Written back through the normal setters so main is corrected too, not just the
      // on-screen value.
      const gone = (v) => v === INHOUSE_TARGET || v === INHOUSE_TARGET_2;
      if (gone(st.targetHarvesterProxyList)) this.setHarvesterProxies('');
      else if (typeof st.targetHarvesterProxyList === 'string') {
        this.setState({ harvesterProxyList: st.targetHarvesterProxyList });
      }
      if (gone(st.targetThrottleFallbackGroup)) this.saveThrottleFallback('Local');
      else this.setState({ throttleFallbackGroup: st.targetThrottleFallbackGroup || 'Local' });
    } catch {}
    try { this.setState({ skuTitles: ipcRenderer.sendSync('getTargetSkuTitles') || {} }); } catch {}
    try {
      const st = ipcRenderer.sendSync('getSettings') || {};
      this.setState({
        cookieBank: st.targetCookieBank == null ? '' : String(st.targetCookieBank),
        cookieDrain: st.targetCookieDrainPerMin == null ? '' : String(st.targetCookieDrainPerMin),
      });
    } catch {}
    // Pushed by main when a run resolves names for its watch list. The lookup happens at START,
    // where the final SKU list is known — the page can mount before the list is restored, so a
    // page-driven lookup can run against nothing and quietly resolve zero.
    this.onSkuTitles = (e, payload) => this.setState({ skuTitles: (payload && payload.titles) || {} });
    ipcRenderer.on('targetSkuTitles', this.onSkuTitles);
    window.addEventListener('keydown', this.onKeyDown);
    // Tasks + the SKU list live in main so they survive a restart.
    try {
      const saved = ipcRenderer.sendSync('getTargetTasks') || {};
      const rawTasks = Array.isArray(saved.tasks) ? saved.tasks : [];
      // The two built-in Target pools are gone from every picker. A task still pointing at one would
      // render an empty selector and ask the engine to rotate onto a group it can no longer resolve,
      // so EXACTLY those move to Local.
      //
      // Deliberately narrow: a task on a list the user added themselves is left alone, because that
      // pool still exists and the choice was theirs. Only the two hardcoded names are rewritten.
      let migrated = false;
      const tasks = rawTasks.map(t => {
        let next = t;
        if (t.proxyListName === INHOUSE_TARGET || t.proxyListName === INHOUSE_TARGET_2) {
          next = { ...next, proxyListName: '' };
          migrated = true;
        }
        // Older tasks only stored the account and reconstructed the profile at Start. Persist the
        // resolved profile now so request-code can always choose its mailbox by ID; email matching
        // remains a compatibility fallback for aliases and old backend messages.
        const profile = this.profileForAccount(t.accountId);
        if (profile && String(next.profileId || '') !== String(profile.id)) {
          next = { ...next, profileId: profile.id };
          migrated = true;
        }
        return next;
      });
      const cleaned = stripSkuNames(saved.skus || '');
      const skus = cleaned === null ? (saved.skus || '') : cleaned;
      this.props.dispatch({ type: 'targetSet', obj: { skus, tasks } });
      if (cleaned !== null || migrated) {
        try { ipcRenderer.sendSync('saveTargetTasks', { skus, tasks }); } catch {}
      }
    } catch { /* first run: nothing persisted yet */ }
    this.pollBank();
    this.bankTimer = setInterval(this.pollBank, 4000);
    this.scrollToBottom();
  }

  componentWillUnmount() {
    clearInterval(this.bankTimer);
    clearTimeout(this.proxyNoteTimer);
    try { ipcRenderer.removeListener('targetSkuTitles', this.onSkuTitles); } catch {}
    window.removeEventListener('keydown', this.onKeyDown);
  }

  // Escape closes the context menu. A backdrop catches clicks, but a menu you cannot dismiss from
  // the keyboard is the kind of thing that gets noticed mid-drop.
  onKeyDown = (e) => {
    if (e.key === 'Escape' && this.state.menu) this.setState({ menu: null });
  };

  // null => broker not running. Rendered as "offline" rather than 0, because no pool and an empty
  // pool mean different things and only one of them is a farming problem.
  pollBank = () => {
    ipcRenderer.invoke('targetCookieBank')
      .then(b => this.setState({ bank: b }))
      .catch(() => this.setState({ bank: null }));
  };

  getSnapshotBeforeUpdate(prev) {
    const a = (prev.target && prev.target.logs) || [];
    const b = (this.props.target && this.props.target.logs) || [];
    if (a.length !== b.length && this.logBox.current) {
      const el = this.logBox.current;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    return null;
  }

  componentDidUpdate(prev, prevState, wasAtBottom) { if (wasAtBottom) this.scrollToBottom(); }

  scrollToBottom = () => {
    const el = this.logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Which watch-list line the pointer is on.
  //
  // A textarea renders plain text — there are no per-line nodes to attach a hover to — so the row
  // is worked out from the pointer's Y against the line box: subtract the border and top padding,
  // add whatever the box is scrolled by, divide by the line height. Exact because both layers are
  // pinned to LIST_TEXT rather than styled independently.
  skuLineAt = (e) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top - LIST_BORDER - LIST_PAD_TOP + el.scrollTop;
    if (y < 0) return '';
    const idx = Math.floor(y / LIST_LINE_H);
    const lines = String(this.props.target.skus || '').split('\n');
    if (idx < 0 || idx >= lines.length) return '';
    return parseTcin(lines[idx]);
  };

  // ── persistence ────────────────────────────────────────────────────────────
  persist = (over = {}) => {
    const { target } = this.props;
    const payload = {
      skus: over.skus !== undefined ? over.skus : target.skus,
      tasks: over.tasks !== undefined ? over.tasks : target.tasks,
    };
    try { ipcRenderer.sendSync('saveTargetTasks', payload); } catch {}
  };

  setSkus = (v) => {
    this.props.dispatch({ type: 'targetSet', obj: { skus: v } });
    this.persist({ skus: v });
  };

  // ── account -> profile matching ────────────────────────────────────────────
  profileForAccount = (accountId) => {
    const { accounts = [], profiles = {} } = this.props;
    const list = profiles.list || profiles.profiles || (Array.isArray(profiles) ? profiles : []);
    const acct = accounts.find(a => String(a.id) === String(accountId));
    if (!acct) return null;
    const email = String(acct.email || '').trim().toLowerCase();
    if (!email) return null;
    return list.find(p => String(p.email || '').trim().toLowerCase() === email) || null;
  };

  accountEmail = (accountId) => {
    const acct = (this.props.accounts || []).find(a => String(a.id) === String(accountId));
    return acct ? acct.email : '';
  };

  // ── task CRUD ──────────────────────────────────────────────────────────────
  createTasks = () => {
    const { draft } = this.state;
    if (!draft.accountIds.length) return;
    // One task per selected account. That IS the bulk-create: pick ten accounts, get ten tasks,
    // each already bound to its own account and matched profile.
    const tasks = draft.accountIds.map(accountId => {
      const profile = this.profileForAccount(accountId);
      return {
        id: uid(),
        accountId,
        profileId: profile ? profile.id : '',
        proxyListName: draft.proxyListName,
      };
    });
    this.props.dispatch({ type: 'targetTasksAdd', tasks });
    this.persist({ tasks: [...this.props.target.tasks, ...tasks] });
    this.setState({ draft: { ...draft, accountIds: [] } });
  };

  // Blank stays blank: the engine treats an empty value as "no cap", and writing 0 would be a
  // different thing entirely. Read by the farmer when it spawns, so a change lands on the next
  // Start rather than needing an app restart.
  setCookieBank = (v) => {
    const clean = String(v).replace(/[^0-9]/g, '').slice(0, 4);
    this.setState({ cookieBank: clean });
    try {
      const s = ipcRenderer.sendSync('getSettings') || {};
      ipcRenderer.sendSync('saveSettings', { ...s, targetCookieBank: clean });
    } catch {}
  };

  setCookieDrain = (v) => {
    const clean = String(v).replace(/[^0-9]/g, '').slice(0, 4);
    this.setState({ cookieDrain: clean });
    try {
      const s = ipcRenderer.sendSync('getSettings') || {};
      ipcRenderer.sendSync('saveSettings', { ...s, targetCookieDrainPerMin: clean });
    } catch {}
  };

  setHarvesterProxies = (name) => {
    this.setState({ harvesterProxyList: name });
    try {
      const s = ipcRenderer.sendSync('getSettings') || {};
      ipcRenderer.sendSync('saveSettings', { ...s, targetHarvesterProxyList: name });
    } catch {}
  };

  // Only reaches the engine on the next send-configs, which start does — so changing it mid-run
  // affects the next batch, not tasks already going.
  saveThrottleFallback = (group) => {
    this.setState({ throttleFallbackGroup: group });
    try {
      const s = ipcRenderer.sendSync('getSettings') || {};
      ipcRenderer.sendSync('saveSettings', { ...s, targetThrottleFallbackGroup: group });
    } catch {}
  };

  // Changing this on a RUNNING task switches its proxy mid-drop.
  //
  // The case it exists for: add-to-cart lands on residential, then checkout is throttled
  // (DCO_RATE_LIMITED / 429) and the order dies on an IP Target is deliberately slowing. Nothing
  // between add-to-cart and check-order re-pins the connection, so a switch made during checkout
  // holds for the rest of the order — no restart, no lost cart.
  //
  // Until now this only wrote to the store and disk, so changing it mid-run looked like it worked
  // and did nothing at all.
  setTaskProxy = (id, proxyListName) => {
    this.props.dispatch({ type: 'targetTaskUpdate', id, obj: { proxyListName } });
    this.persist({ tasks: this.props.target.tasks.map(t => (t.id === id ? { ...t, proxyListName } : t)) });
    let sent = false;
    try { sent = ipcRenderer.sendSync('setTargetTaskProxy', id, proxyListName); } catch {}
    // Only surfaced for a live task. For a stopped one the stored value IS the whole effect, and a
    // "queued" note there would imply something is pending when nothing is.
    if (sent) {
      this.props.dispatch({
        type: 'targetProxyEditSent', taskId: id, at: Date.now(),
        group: String(proxyListName || '').trim() || 'Local',
      });
      this.setState({ proxySwitched: { id, at: Date.now() } });
      clearTimeout(this.proxyNoteTimer);
      this.proxyNoteTimer = setTimeout(() => this.setState({ proxySwitched: null }), 5000);
    }
  };

  // Deleting a task STOPS it first.
  //
  // This only removed the row from the list: the engine kept running the task, kept logging, and the
  // only way out was closing the app. Removing something from a list is the most natural way to
  // express "stop doing this", and it did everything except that.
  //
  // Stop is sent unconditionally rather than only for rows that look busy — taskStatus can lag the
  // engine, and stopping an already-stopped task is a no-op while missing a live one is the bug.
  // Takes a LIST, and persists once.
  //
  // Deleting several tasks cannot be a loop over a single-delete helper. persist() writes the whole
  // array, computed from this.props.target.tasks — and props do not update between synchronous calls
  // inside one handler, so every iteration starts from the ORIGINAL list and the last write wins.
  // Deleting three tasks left two of them on disk; they were gone from the screen until the page
  // remounted (switching tabs is enough) and read the file back, at which point they reappeared and
  // it looked like delete had never saved.
  deleteTasks = (ids) => {
    const gone = new Set(ids.map(String));
    for (const id of ids) {
      // Stop is sent unconditionally rather than only for rows that look busy — taskStatus can lag
      // the engine, and stopping an already-stopped task is a no-op while missing a live one is the bug.
      try { ipcRenderer.sendSync('stopTarget', id); } catch {}
      this.props.dispatch({ type: 'targetTaskDelete', id });
    }
    this.persist({ tasks: (this.props.target.tasks || []).filter(t => !gone.has(String(t.id))) });
  };

  // Deleting a task STOPS it first.
  //
  // This only removed the row from the list: the engine kept running the task, kept logging, and the
  // only way out was closing the app. Removing something from a list is the most natural way to
  // express "stop doing this", and it did everything except that.
  deleteTask = (id) => this.deleteTasks([id]);

  clearTasks = () => {
    // Irreversible and one click from Start. The tasks carry account/profile/proxy pairings that
    // have to be rebuilt by hand, and the button sits in the same header as the filter box.
    const n = (this.props.target.tasks || []).length;
    if (n && !window.confirm(`Delete all ${n} task${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
    // Stop EVERYTHING, not each task in turn: stopTarget with no id tears down the engine, the
    // farmer and the monitor together, which is what clearing the whole list means.
    try { ipcRenderer.sendSync('stopTarget'); } catch {}
    this.props.dispatch({ type: 'targetTasksClear' });
    this.persist({ tasks: [] });
  };

  // ── run control ────────────────────────────────────────────────────────────
  // `list` omitted => every task. Shared by Start All and a single row's Start so both go through
  // exactly the same profile-matching and validation.
  start = (list) => {
    const { target } = this.props;
    const skus = parseSkuBox(target.skus);
    if (!skus.length) { window.alert('Add at least one SKU to the watch list first.'); return; }

    const wanted = list || target.tasks;
    const runnable = [];
    const skipped = [];
    for (const t of wanted) {
      const prof = this.profileForAccount(t.accountId);
      if (!prof) { skipped.push(this.accountEmail(t.accountId) || t.accountId); continue; }
      runnable.push({ ...t, profileId: prof.id });
    }
    if (!runnable.length) {
      window.alert(skipped.length
        ? 'No profile has an email matching that account, so the task cannot run.'
        : 'Nothing to start.');
      return;
    }
    if (skipped.length) {
      window.alert(`Skipping ${skipped.length} task(s) with no matching profile:\n` + skipped.slice(0, 8).join('\n'));
    }
    ipcRenderer.send('startTarget', { tasks: runnable, skus, qty: target.qty || 2 });
  };

  startAll = () => this.start();
  startTask = (t) => this.start([t]);

  stopAll = () => ipcRenderer.sendSync('stopTarget');
  stopTask = (id) => ipcRenderer.sendSync('stopTarget', id);

  // ── bulk selection ─────────────────────────────────────────────────────────
  // Twenty tasks and one dropdown each is not a workflow you can run during a drop. Selecting by
  // STATE is the point: every declined task at once to restart them, every running one to stop.
  toggleSelected = (id) => this.setState(({ selected }) => {
    const next = { ...selected };
    if (next[id]) delete next[id]; else next[id] = true;
    // Every plain pick re-anchors, so the next shift-click measures from the row you last touched.
    return { selected: next, anchorId: id };
  });

  // Shift-click: everything between the anchor and this row, inclusive.
  //
  // Ranges are computed over the VISIBLE list, never the full task list. Under a filter, "from here
  // to there" that quietly swept up rows scrolled out of the filter would be a nasty surprise one
  // click before Stop — the same reason select-all already operates on what is shown.
  selectRange = (visible, id) => this.setState(({ selected, anchorId }) => {
    const ids = visible.map(t => t.id);
    const to = ids.indexOf(id);
    if (to < 0) return null;
    const from = ids.indexOf(anchorId);
    // No anchor yet, or the anchor is filtered out of view: treat this as an ordinary pick rather
    // than guessing at an endpoint the operator cannot see.
    if (from < 0) return { selected: { ...selected, [id]: true }, anchorId: id };
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const next = { ...selected };
    for (let i = lo; i <= hi; i++) next[ids[i]] = true;
    // Anchor deliberately unchanged — shift-clicking again re-measures from the same fixed end.
    return { selected: next };
  });

  // A row click is a SELECTION, the way it is in a file manager: plain click picks exactly one row
  // and drops the rest, ctrl adds or removes one, shift takes a range. The log expander moved to the
  // chevron — clicking a row to select it and getting a wall of log output instead was the old
  // behaviour, and selecting is by far the more common intent during a drop.
  rowClick = (e, t, visible) => {
    if (e.shiftKey) {
      // Shift-clicking across rows makes the browser text-select everything between them, which
      // leaves the list highlighted blue until the next click somewhere else.
      try { window.getSelection().removeAllRanges(); } catch {}
      this.selectRange(visible, t.id);
      return;
    }
    // metaKey so Cmd works the same as Ctrl — the Mac build is being prepared and this is the one
    // convention that would feel broken there.
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelected(t.id);
      return;
    }
    // Replaces rather than adds. Clicking a fresh row almost always means "just this one now", and
    // a plain click that quietly accumulated would make Stop act on rows chosen minutes ago.
    this.setState({ selected: { [t.id]: true }, anchorId: t.id });
  };

  toggleExpanded = (id) => this.setState(({ expanded }) => ({ expanded: expanded === id ? null : id }));

  // ── right-click menu ───────────────────────────────────────────────────────
  openMenu = (e, t) => {
    e.preventDefault();
    e.stopPropagation();
    // Read the coordinates NOW, not inside the updater below.
    //
    // React 16 pools synthetic events: the moment this handler returns, `e` is recycled and every
    // field on it is nulled. A setState updater runs after that, so reading e.clientX in there
    // yielded null, Math.min(null, ...) collapsed to 0, and the menu opened at the top-left corner
    // of the screen on every right-click regardless of where the pointer was.
    const menu = { x: e.clientX, y: e.clientY };
    this.setState(({ selected }) => {
      // Right-clicking INSIDE a selection keeps it and acts on the whole thing, the way a file
      // manager does. Right-clicking a row that is not selected replaces the selection with just
      // that row, so the menu can never act on rows you had forgotten were ticked.
      if (selected[t.id]) return { menu };
      return { selected: { [t.id]: true }, anchorId: t.id, menu };
    });
  };

  closeMenu = () => this.setState({ menu: null });

  menuStart = () => { this.closeMenu(); this.bulkStart(); };
  menuStop = () => { this.closeMenu(); this.bulkStop(); };
  menuDelete = () => {
    const list = this.selectedTasks();
    this.closeMenu();
    if (!list.length) return;
    // One row matches the per-row Delete button, which has never prompted. More than one is a bulk
    // irreversible action reached from a mis-clickable menu, so it gets the same guard as Delete All.
    if (list.length > 1 &&
        !window.confirm(`Delete ${list.length} tasks? This cannot be undone.`)) return;
    this.deleteTasks(list.map(t => t.id));
    this.clearSelection();
  };

  // Operates on what is VISIBLE. With a filter applied, "select all" meaning "including the rows
  // you filtered out" would be a nasty surprise the moment the next click is Stop.
  toggleSelectAll = (visible) => this.setState(({ selected }) => {
    const allOn = visible.length > 0 && visible.every(t => selected[t.id]);
    if (allOn) return { selected: {} };
    const next = { ...selected };
    for (const t of visible) next[t.id] = true;
    return { selected: next };
  });

  // Replaces the selection rather than adding to it: clicking "error" then "running" almost always
  // means "now show me the running ones", not "both".
  selectGroup = (visible, key) => {
    const { taskStatus = {} } = this.props.target;
    const next = {};
    for (const t of visible) {
      if (groupOfStatus(taskStatus[t.id]) === key) next[t.id] = true;
    }
    this.setState({ selected: next });
  };

  clearSelection = () => this.setState({ selected: {} });

  selectedTasks = () => {
    const { selected } = this.state;
    return (this.props.target.tasks || []).filter(t => selected[t.id]);
  };

  // Same one-write rule as deleteTasks, and for the same reason: looping over setTaskProxy persisted
  // the full array once per task from stale props, so picking a pool for ten selected tasks saved it
  // for exactly one of them — the last. The engine still gets told per task, since that is a live
  // message and not a write.
  bulkSetProxy = (name) => {
    if (!name && name !== '') return;
    const list = this.selectedTasks();
    if (!list.length) return;
    const ids = new Set(list.map(t => String(t.id)));
    let sentAny = false;
    for (const t of list) {
      this.props.dispatch({ type: 'targetTaskUpdate', id: t.id, obj: { proxyListName: name } });
      try {
        if (ipcRenderer.sendSync('setTargetTaskProxy', t.id, name)) {
          sentAny = true;
          this.props.dispatch({
            type: 'targetProxyEditSent', taskId: t.id, at: Date.now(),
            group: String(name || '').trim() || 'Local',
          });
        }
      } catch {}
    }
    this.persist({
      tasks: (this.props.target.tasks || []).map(t =>
        (ids.has(String(t.id)) ? { ...t, proxyListName: name } : t)),
    });
    // Only surfaced when a switch actually reached a RUNNING task, matching the single-task path.
    if (sentAny) {
      this.setState({ proxySwitched: { id: list[0].id, at: Date.now() } });
      clearTimeout(this.proxyNoteTimer);
      this.proxyNoteTimer = setTimeout(() => this.setState({ proxySwitched: null }), 5000);
    }
  };

  bulkStart = () => {
    const list = this.selectedTasks();
    if (list.length) this.start(list);
  };

  bulkStop = () => {
    for (const t of this.selectedTasks()) this.stopTask(t.id);
  };

  clearLogs = () => this.props.dispatch({ type: 'targetSet', obj: { logs: [] } });

  // Logs are the whole diagnostic surface — without a copy path the only way to report a problem is
  // a screenshot, which loses the lines scrolled out of view.
  copy = (lines, label) => {
    const text = (lines || []).join('\n');
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => this.setState({ copied: label }, () => setTimeout(() => this.setState({ copied: null }), 1400)))
      .catch(() => {});
  };

  // Select every Target account, or clear the selection when they are all already picked.
  //
  // One button rather than separate All/None: with the label switching between "All (12)" and
  // "Clear" it always says what pressing it will do, and it is the same click either way — which is
  // what you want when the list is 200 long and ticking them by hand is the thing being avoided.
  toggleAllAccounts = () => {
    const { accounts = [] } = this.props;
    const ids = accounts.filter(a => siteOf(a) === 'target').map(a => a.id);
    const all = ids.length > 0 && ids.every(id => this.state.draft.accountIds.includes(id));
    this.setState({ draft: { ...this.state.draft, accountIds: all ? [] : ids } });
  };

  toggleAccount = (id) => {
    const ids = this.state.draft.accountIds;
    const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
    this.setState({ draft: { ...this.state.draft, accountIds: next } });
  };

  render() {
    const { target = {}, accounts = [], proxies = {} } = this.props;
    const { tasks = [], taskStatus = {}, proxyStatus = {}, taskLogs = {}, logs = [], monitorStatus } = target;
    const { draft, expanded, filter, harvesterProxyList, throttleFallbackGroup, selected, skuTitles, skuHover, hoverSku, cookieBank, cookieDrain, menu } = this.state;

    const proxyLists = (proxies && proxies.lists) || [];
    const skus = parseSkuBox(target.skus);
    const { bank } = this.state;

    const q = filter.trim().toLowerCase();
    // Matches the account OR the live status line, because during a drop the question is almost
    // never "where is this account" — it is "show me everything sitting on X". The status text is
    // the engine's own wording (statuses are not put through plain-log), so what is on screen is
    // exactly what is searched.
    const shown = q
      ? tasks.filter(t => {
          if (String(this.accountEmail(t.accountId)).toLowerCase().includes(q)) return true;
          const st = taskStatus[t.id];
          if (!st) return false;
          return String(st.label || '').toLowerCase().includes(q)
            || String(st.detail || '').toLowerCase().includes(q);
        })
      : tasks;
    const selectedCount = shown.filter(t => selected[t.id]).length;
    const allShownSelected = shown.length > 0 && selectedCount === shown.length;

    // Target accounts only; other or untagged legacy records stay preserved but hidden.
    const targetAccounts = accounts.filter(a => siteOf(a) === 'target');
    const allAccountsPicked = targetAccounts.length > 0
      && targetAccounts.every(a => draft.accountIds.includes(a.id));

    // Fixed-height column, not a growing stack.
    //
    // Every panel rendered one after another and the page simply got taller, so past about six tasks
    // the module log was pushed below the fold and the only way to read it was to maximise the
    // window. Now the middle scrolls and the log keeps its place at the bottom.
    return (
      <div className="page" style={{
        // flex:1, not height:100%. The parent (.page-area) is a flex COLUMN, so a percentage height
        // has no definite box to resolve against and the page collapsed to its content — which is
        // why the engine log floated up with empty space beneath it instead of sitting at the bottom.
        padding: '16px 20px 16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      }}>
        <div className="page-header" style={{ marginBottom: 14 }}>
          <h1 className="page-title" style={{ margin: 0 }}>Target</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Harvester pool sits with the cookie bank because they are the same subject: this is
                the pool that FILLS that bank. It was buried inside Create Tasks, a panel you stop
                looking at once the tasks exist, while the thing it feeds is read constantly. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px',
              border: '1px solid var(--panel-border)', borderRadius: 7,
              background: 'var(--panel-bg-alt, rgba(0,0,0,.15))',
            }}>
              <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3, fontSize: 11 }}>HARVESTER</span>
              <select
                className="form-select"
                value={harvesterProxyList}
                onChange={e => this.setHarvesterProxies(e.target.value)}
                style={{ fontSize: 11, padding: '2px 6px', maxWidth: 190 }}
              >
                <option value="">Local (no proxy)</option>
                {proxyLists.map(l => <option key={proxyRef(l)} value={proxyRef(l)}>{proxyLabel(l)}</option>)}
              </select>
            </div>
            {/* Always on: a task that has carted and then hits DCO_RATE_LIMITED switches to whatever
                is selected here. There is no off switch by design — the selector IS the setting.
                The engine still enforces the gating: carted tasks only, once per task, and (for
                Local only) one task at a time, so a fleet-wide throttle cannot stack every task
                onto one address. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px',
              border: '1px solid var(--panel-border)', borderRadius: 7, fontSize: 11,
              background: 'var(--panel-bg-alt, rgba(0,0,0,.15))',
            }}>
              <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3 }}>FALLBACK</span>
              <select
                className="form-select"
                value={throttleFallbackGroup}
                onChange={e => this.saveThrottleFallback(e.target.value)}
                style={{ fontSize: 11, padding: '2px 6px', maxWidth: 190 }}
              >
                <option value="Local">Local (no proxy)</option>
                {proxyLists.map(l => <option key={proxyRef(l)} value={proxyRef(l)}>{proxyLabel(l)}</option>)}
              </select>
            </div>
            {/* Bank stacked ON TOP of the buttons rather than beside them. The header row is as tall
                as the buttons anyway, so the space above them was already being paid for and sat
                empty — this uses it and shortens the row. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* BANK cap beside the monitor state. It was only in Settings, behind the five-tap
                  operator gate, with a placeholder that claimed a default of 30 while the real
                  default was uncapped — so the box everyone left blank never limited anything. The
                  control that stops the bank filling belongs next to where you watch it fill. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={CHIP}
                  title={'Stop farming once this many cookies of each type are banked. At the cap the harvest browsers CLOSE rather than idle, so a full bank costs no proxy data at all; farming restarts when cookies are used or expire. Blank = no limit. Applies on the next Start.'}
                >
                  <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3 }}>BANK SIZE</span>
                  <input
                    className="form-input"
                    value={cookieBank}
                    onChange={e => this.setCookieBank(e.target.value)}
                    placeholder="∞"
                    style={{
                      width: 46, height: 20, boxSizing: 'border-box',
                      fontSize: 11, padding: '0 6px', textAlign: 'center',
                      color: cookieBank ? 'var(--text)' : 'var(--muted)',
                    }}
                  />
                </div>
                {/* Sits beside BANK SIZE because the two are the same conversation: one caps how
                    much you hold, this caps how fast it can leave. */}
                <div
                  style={CHIP}
                  title={'Cap how many BANKED cookies can be handed out per minute. A failing add-to-cart takes a fresh cookie on every retry, so two stuck tasks can empty a 60-cookie bank in about 30 seconds — and if Target poisons a batch, burning them all at once loses the lot. This paces the reserve ONLY: a cookie handed straight to a waiting task is never delayed, so a live drop runs at full speed. Blank = no limit. Applies on the next Start.'}
                >
                  <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3 }}>DRAIN /MIN</span>
                  <input
                    className="form-input"
                    value={cookieDrain}
                    onChange={e => this.setCookieDrain(e.target.value)}
                    placeholder="∞"
                    style={{
                      width: 46, height: 20, boxSizing: 'border-box',
                      fontSize: 11, padding: '0 6px', textAlign: 'center',
                      color: cookieDrain ? 'var(--text)' : 'var(--muted)',
                    }}
                  />
                </div>
              {monitorStatus && (
                <div style={CHIP}>
                  <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3 }}>MONITOR</span>
                  <span style={{ color: monitorStatus.color || 'var(--muted)', fontWeight: 600 }}>
                    {monitorLabel(monitorStatus)}
                  </span>
                </div>
              )}
              </div>
              {/* Cookie bank: the farmed Shape pool the engine draws from. "offline" means the broker
                  isn't up at all, which is a different problem from an empty pool. */}
              <div style={CHIP}>
                <span style={{ color: 'var(--muted)', fontWeight: 600, letterSpacing: .3 }}>COOKIE BANK</span>
                {bank ? (
                  <>
                    <span title="login cookies pooled">
                      <b style={{ color: bank.login > 0 ? 'var(--ok)' : 'var(--run)' }}>{bank.login}</b>
                      <span style={{ color: 'var(--muted)' }}> login</span>
                    </span>
                    <span title="add-to-cart cookies pooled">
                      <b style={{ color: bank.atc > 0 ? 'var(--ok)' : 'var(--run)' }}>{bank.atc}</b>
                      <span style={{ color: 'var(--muted)' }}> atc</span>
                    </span>
                  </>
                ) : (
                  <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>offline</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" onClick={this.startAll} disabled={!tasks.length} style={{ flex: 1 }}>
                  Start All
                </button>
                {/* NEVER disabled. Gating Stop on "we have seen a status" meant a task that died
                    before reporting one — an engine that exits on Error Assigning Proxy, say —
                    could not be stopped at all, and the only way out was killing the app. Stop must
                    always be reachable; a redundant stop is harmless. */}
                <button className="btn btn-secondary" onClick={this.stopAll} style={{ flex: 1 }}>
                  Stop All
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* The login-code prompt now lives in OtpBanner, pinned to the top of the app on every page.
            Here it was only visible if you happened to be on this tab, and only after scrolling past
            the header — which is exactly how people missed it. */}

        {/* The scrolling middle. Header stays above it and the log stays below, so neither can be
            pushed off screen however many tasks there are. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

        {/* Create tasks and the watch list sit SIDE BY SIDE: stacked, they pushed the task list and
            engine log below the fold on a non-maximised window. */}
        {/* alignItems stretch, not flex-start: the three panels are read side by side, and with
            each one sizing to its own content their bottom edges landed at three different heights.
            Every panel below is a flex COLUMN whose scrolling body takes the slack, so the extra
            height becomes usable list/log space rather than dead padding. */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 14, alignItems: 'stretch' }}>

          {/* LEFT: the things you set up. Stacked, because each is short and neither needs the
              height that the task list does. */}
          <div style={{ flex: '0 0 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* ── Create tasks ─────────────────────────────────────────────── */}
            <div className="panel" style={{ flex: '1 1 auto', minHeight: 0, marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
              {/* The button IS the heading. A panel titled "Create Tasks" whose only action is a
                  button labelled "Create Tasks" said it twice and spent a full row doing it. */}
              <div style={HEAD}>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ padding: '3px 10px', lineHeight: 1.4 }}
                  onClick={this.createTasks}
                  disabled={!draft.accountIds.length}
                >
                  Create {draft.accountIds.length || ''} Task{draft.accountIds.length === 1 ? '' : 's'}
                </button>
                <span style={HEAD_META}>
                  {draft.accountIds.length} selected — one task each
                </span>
              </div>
              <div style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <label className="form-label" style={{ marginBottom: 0 }}>Target Accounts</label>
                    {targetAccounts.length > 0 && (
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ padding: '1px 8px', fontSize: 10.5 }}
                        onClick={this.toggleAllAccounts}
                      >
                        {allAccountsPicked ? 'Clear' : `All (${targetAccounts.length})`}
                      </button>
                    )}
                  </div>
                  <div style={{
                    height: 172, overflowY: 'auto', border: '1px solid var(--panel-border)',
                    borderRadius: 6, padding: 4,
                  }}>
                    {targetAccounts.length === 0 && (
                      <div style={{ padding: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                        No accounts tagged <b>Target</b>. Add them under Accounts → Target tab.
                      </div>
                    )}
                    {targetAccounts.map(a => {
                      const matched = !!this.profileForAccount(a.id);
                      const inUse = tasks.some(t => String(t.accountId) === String(a.id));
                      const on = draft.accountIds.includes(a.id);
                      return (
                        <div
                          key={a.id}
                          onClick={() => this.toggleAccount(a.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                            borderRadius: 4, cursor: 'pointer', fontSize: 12,
                            background: on ? 'var(--accent-soft)' : 'transparent',
                          }}
                        >
                          <input type="checkbox" readOnly checked={on} style={{ pointerEvents: 'none' }} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {a.email}
                          </span>
                          {/* Only says something when there IS something to say.
                              "profile ✓" was on every healthy row, which is the majority of them —
                              a badge that is almost always present stops being read, and it buried
                              the one that matters. Missing profile still wins outright: that
                              account cannot run at all, and finding out mid-drop is too late.
                              "in use" is next, so building a second batch does not quietly
                              duplicate accounts that already have a task. */}
                          {!matched ? (
                            <span style={{ fontSize: 10, color: '#ff5a5a', flexShrink: 0 }}>no profile</span>
                          ) : inUse ? (
                            <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>in use</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* The Card selector was removed: it was never wired to anything. The engine always
                    charges the card on the task's matched PROFILE (SubmitPayment reads
                    t.Profile.CardNumber), so offering "Auto-detect / Default Card" implied a choice
                    that did not exist. Change the card on the profile instead. */}

                </div>
              </div>
            </div>

            {/* ── Watch list ───────────────────────────────────────────────── */}
              <div className="panel" style={{ flex: '0 0 auto', marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={HEAD}>
                  <span style={HEAD_TITLE}>Watch List</span>
                  <span style={HEAD_META}>{skus.length} valid · qty {target.qty || 2} each</span>
                </div>
                <div style={{ padding: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {/* Names are painted BEHIND the textarea, not typed into it.
                      As real text they were selectable, copyable, and something you had to edit
                      around — and they had to be parsed back out again on every read, which is one
                      stray character away from dropping a SKU from the watch list. Here they are
                      pure decoration: the layer cannot be clicked, focused or selected, and the
                      box's value is still nothing but TCINs. Hover a row for the full name.
                      Alignment relies on the two layers sharing font, size, line-height and
                      padding — hence the shared LIST_TEXT below rather than two style blocks that
                      could drift apart. */}
                  <div
                    style={{ position: 'relative', width: 190, maxWidth: '100%', flex: 1, minHeight: 0 }}
                    onMouseEnter={() => this.setState({ skuHover: true })}
                    onMouseLeave={() => this.setState({ skuHover: false, hoverSku: '' })}
                  >
                    <div
                      aria-hidden
                      ref={this.ghostBox}
                      style={{
                        ...LIST_TEXT,
                        position: 'absolute', inset: 0, zIndex: 0,
                        pointerEvents: 'none', userSelect: 'none',
                        overflow: 'hidden', whiteSpace: 'pre',
                        border: '1px solid transparent',   // matches the input's border box
                      }}
                    >
                      {String(target.skus || '').split('\n').map((line, i) => {
                        const t = parseTcin(line);
                        const name = t && skuTitles[t];
                        if (!name) return <div key={i}>&nbsp;</div>;
                        return (
                          <div key={i}>
                            {/* Reserves exactly the width of the typed text so the name starts
                                after it, whatever the TCIN's length. */}
                            <span style={{ visibility: 'hidden' }}>{line}</span>
                            <span style={{
                              color: skuHover ? 'var(--text)' : 'var(--muted)',
                              opacity: skuHover ? .95 : .75,
                            }}>{'  ' + name}</span>
                          </div>
                        );
                      })}
                    </div>
                    <textarea
                      className="form-input"
                      rows={8}
                      spellCheck={false}
                      placeholder={'One per line — TCIN or full Target URL\n\n94992306\n95040448\nhttps://www.target.com/p/-/A-93873074'}
                      value={target.skus || ''}
                      onChange={e => this.setSkus(e.target.value)}
                      onScroll={e => { if (this.ghostBox.current) this.ghostBox.current.scrollTop = e.target.scrollTop; }}
                      onMouseMove={e => {
                        const t = this.skuLineAt(e);
                        if (t !== this.state.hoverSku) this.setState({ hoverSku: t });
                      }}
                      style={{
                        ...LIST_TEXT,
                        position: 'relative', zIndex: 1,
                        // Fills the panel rather than being fixed at rows={8}: the three panels are
                        // the same height now, and a short box would leave a gap under it.
                        width: '100%', height: '100%', resize: 'none',
                        // Transparent so the names behind it show through; the typed digits still
                        // paint on top.
                        background: 'transparent',
                        color: skuHover ? '#fff' : undefined,
                      }}
                    />
                    {/* Our own tooltip, replacing the `title` attribute.
                        A native tooltip is drawn by the OS — grey text on the OS's own background,
                        with no way to restyle it, which is exactly the complaint. This is an
                        ordinary element: it can be white, it can use the panel colours, and it can
                        show the FULL name instead of whatever fits in 190px. pointerEvents none so
                        it can never eat a click meant for the box underneath. */}
                    {skuHover && skus.length > 0 && (
                      <div style={{
                        // BELOW the box, not beside it. To the right is the engine log, and an
                        // overlay there put two sets of text on top of each other.
                        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 30,
                        pointerEvents: 'none', minWidth: 300, maxWidth: 560, width: 'max-content',
                        // Solid, NOT var(--panel) — that is rgba(255,255,255,.06), so whatever sits
                        // underneath reads straight through it and the two mix into noise.
                        background: '#0d1f24',
                        border: '1px solid var(--panel-border)',
                        borderRadius: 8, padding: '11px 14px', fontSize: 13, lineHeight: 1.95,
                        boxShadow: '0 10px 30px rgba(0,0,0,.6)',
                      }}>
                        {skus.map(t => {
                          const name = skuTitles[t];
                          return (
                            <div key={t} style={{
                              display: 'flex', gap: 10, whiteSpace: 'nowrap',
                              // The row for the line the pointer is actually on. With eight
                              // near-identical numbers, "which of these am I looking at" is the
                              // whole question the panel exists to answer.
                              background: t === hoverSku ? 'rgba(94,234,212,.16)' : 'transparent',
                              borderLeft: '2px solid ' + (t === hoverSku ? 'var(--accent)' : 'transparent'),
                              borderRadius: 3,
                              margin: '0 -6px', padding: '0 6px 0 4px',
                            }}>
                              <span style={{ fontFamily: 'monospace', color: '#fff', fontWeight: 600 }}>{t}</span>
                              {/* Green for a name we have, red for one we don't — the two states are
                                  read at a glance, and colour carries that faster than wording. */}
                              <span style={{
                                color: name ? '#4ade80' : '#ff5a5a',
                                fontWeight: name ? 500 : 600,
                              }}>
                                {name || 'Item not loaded yet'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

            {/* ── Module log (engine / monitor / farmer) ───────────────────────
                THIRD COLUMN of this row, beside the watch list. It used to live in a block below
                the row at full width, which is why it sat at the very bottom of the page while
                the space next to the watch list stayed empty no matter how long the run got.
                Its body scrolls at a fixed height, so a long run does not stretch the row. */}
            <div className="panel" style={{ flex: '1 1 0', minWidth: 0, marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={HEAD}>
                <span style={HEAD_TITLE}>
                  Engine Log <span style={HEAD_META}>({logs.length})</span>
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => this.copy(logs, 'engine')}
                    disabled={!logs.length}
                  >
                    {this.state.copied === 'engine' ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={this.clearLogs} disabled={!logs.length}>
                    Clear
                  </button>
                </div>
              </div>
              {/* Fixed height, not max-height: the log must occupy space even when empty, otherwise the
                  panel collapses to a sliver and you have to maximise the window to find it. */}
              <div
                ref={this.logBox}
                style={{
                  // Grows with the row instead of a fixed 120. minHeight keeps a usable log even
                  // when the row is short, and flex-basis 0 stops the log's own content deciding
                  // the height of all three panels.
                  flex: '1 1 0', minHeight: 120, overflowY: 'auto', padding: '8px 14px',
                  fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
                }}
              >
                {logs.length === 0
                  ? <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>Nothing yet.</span>
                  : logs.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </div>

          </div>

          {/* RIGHT: the task list, level with the setup rather than beneath it. */}
          <div style={{ flex: '1 1 0', minWidth: 0, alignSelf: 'flex-start' }}>
          {/* ── Task list ──────────────────────────────────────────────────── */}
          <div className="panel" style={{ marginBottom: 14 }}>
            <div style={HEAD}>
              <span style={HEAD_TITLE}>Tasks <span style={HEAD_META}>({tasks.length})</span></span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* Click a group to select every task in it. This is the whole point of the groups:
                    "restart everything that declined" and "stop everything still running" are the
                    two things you actually do mid-drop, and doing either by hand across twenty rows
                    is not something there is time for. */}
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={() => this.toggleSelectAll(shown)}
                    disabled={!shown.length}
                    style={{ cursor: 'pointer' }}
                  />
                  All
                </label>
                {GROUPS.map(g => {
                  const n = shown.filter(t => groupOfStatus(taskStatus[t.id]) === g.key).length;
                  return (
                    <button
                      key={g.key}
                      className="btn btn-sm"
                      onClick={() => this.selectGroup(shown, g.key)}
                      disabled={!n}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
                        padding: '3px 9px', background: 'transparent',
                        border: '1px solid var(--panel-border)',
                        color: n ? g.color : 'var(--muted)', opacity: n ? 1 : .45,
                      }}
                    >
                      <span>{g.icon}</span>
                      <b>{n}</b>
                    </button>
                  );
                })}
                <input
                  className="form-input"
                  placeholder="Filter by account or status…"
                  value={filter}
                  onChange={e => this.setState({ filter: e.target.value })}
                  style={{ width: 170, fontSize: 11, padding: '3px 8px' }}
                />
                <button className="btn btn-danger btn-sm" onClick={this.clearTasks} disabled={!tasks.length}>
                  Delete All
                </button>
              </div>
            </div>

            {/* Bulk bar. Only appears with a selection, so the list is not carrying a permanently
                empty toolbar. Acts on the SELECTION, which may span groups. */}
            {selectedCount > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px',
                borderTop: '1px solid var(--panel-border)', fontSize: 11,
                background: 'var(--panel-bg-alt, rgba(0,0,0,.15))',
              }}>
                <b>{selectedCount} selected</b>
                <select
                  className="form-select"
                  value=""
                  onChange={e => {
                    const v = e.target.value;
                    if (v) this.bulkSetProxy(v === LOCAL_SENTINEL ? '' : v);
                    e.target.value = '';
                  }}
                  style={{ fontSize: 11, padding: '2px 6px', maxWidth: 200 }}
                >
                  <option value="" disabled>Set proxy list…</option>
                  {/* Local is stored as the empty string, which is also this select's "nothing
                      chosen" value — so it travels under a sentinel and is unwrapped on apply. */}
                  <option value={LOCAL_SENTINEL}>Local (no proxy)</option>
                  {proxyLists.map(l => <option key={proxyRef(l)} value={proxyRef(l)}>{proxyLabel(l)}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" onClick={this.bulkStart}>Start</button>
                <button className="btn btn-secondary btn-sm" onClick={this.bulkStop}>Stop</button>
                <button className="btn btn-sm" onClick={this.clearSelection} style={{ background: 'transparent', color: 'var(--muted)' }}>
                  Clear
                </button>
              </div>
            )}

            {/* Scrolls once the list is taller than the pane. Rows rendered straight into the panel
                simply grew it past the bottom of the window, so task 7 onward could not be reached at
                all — and 7 tasks is an ordinary number, not an edge case. */}
            <div>
            {shown.length === 0 ? (
              <div style={{ padding: 18, fontSize: 12, color: 'var(--muted)' }}>
                {tasks.length ? 'No tasks match that filter.' : 'No tasks yet — pick accounts above and create some.'}
              </div>
            ) : shown.map(t => {
              const st = taskStatus[t.id];
              const prof = this.profileForAccount(t.accountId);
              const tlogs = taskLogs[t.id] || [];
              const open = expanded === t.id;
              return (
                <div key={t.id} style={{ borderTop: '1px solid var(--panel-border)' }}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer',
                      // Selected rows need to read as selected even with the checkbox off screen-edge,
                      // because right-click now acts on the whole selection and the menu says how many.
                      background: selected[t.id] ? 'rgba(96,165,250,0.13)' : 'transparent',
                      // Shift-click otherwise text-selects the rows it sweeps across.
                      userSelect: 'none',
                    }}
                    onClick={e => this.rowClick(e, t, shown)}
                    onContextMenu={e => this.openMenu(e, t)}
                  >
                    {/* stopPropagation: the row itself toggles the expander, and ticking a box to
                        select it must not also open it. Shift on the box does what shift on the row
                        does — that is where the hand already is when extending a range. */}
                    <input
                      type="checkbox"
                      checked={!!selected[t.id]}
                      onClick={e => {
                        e.stopPropagation();
                        if (!e.shiftKey) return;
                        // preventDefault so the box does not also toggle itself and fight the range.
                        e.preventDefault();
                        try { window.getSelection().removeAllRanges(); } catch {}
                        this.selectRange(shown, t.id);
                      }}
                      onChange={e => { e.stopPropagation(); this.toggleSelected(t.id); }}
                      style={{ flexShrink: 0, cursor: 'pointer' }}
                    />
                    {/* The log expander. It used to be decoration on a row that toggled as a whole;
                        now the row selects, so this is the only way in and needs a real hit area
                        rather than a 10px glyph. */}
                    <span
                      onClick={e => { e.stopPropagation(); this.toggleExpanded(t.id); }}
                      title={open ? 'Hide this task’s log' : 'Show this task’s log'}
                      style={{
                        flexShrink: 0, fontSize: 10, width: 18, height: 18, borderRadius: 4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: open ? 'var(--text)' : 'var(--muted)',
                        background: open ? 'rgba(255,255,255,.10)' : 'transparent',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.14)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = open ? 'rgba(255,255,255,.10)' : 'transparent'; }}
                    >
                      {open ? '▾' : '▸'}
                    </span>
                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {this.accountEmail(t.accountId) || <span style={{ color: '#ff5a5a' }}>account missing</span>}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {prof
                          ? `profile: ${prof.profileName || prof.email}`
                          : <span style={{ color: '#ff5a5a' }}>no profile with this email — task will be skipped</span>}
                      </div>
                    </div>
                    {/* Editable in place. Previously the proxy could only be chosen at creation, so a
                        task built on "Local" had to be deleted and rebuilt to get off the home IP —
                        which is exactly the state that gets the monitor 403'd by redsky. */}
                    <select
                      className="form-select"
                      value={t.proxyListName || ''}
                      onClick={e => e.stopPropagation()}
                      onChange={e => { e.stopPropagation(); this.setTaskProxy(t.id, e.target.value); }}
                      style={{
                        flex: '0 0 140px', width: 140, fontSize: 10.5, padding: '3px 7px',
                        color: t.proxyListName ? 'var(--text)' : '#ff8a5a',
                      }}
                      title={t.proxyListName ? '' : 'Local IP, do not run many tasks'}
                    >
                      <option value="">Local (no proxy)</option>
                      {proxyLists.map(l => <option key={proxyRef(l)} value={proxyRef(l)}>{proxyLabel(l)}</option>)}
                    </select>
                    {/* This confirms delivery to the live engine socket, not completion. The
                        engine's status line says whether it switched now or waits until the current
                        Shape-bound step is complete. */}
                    {this.state.proxySwitched && this.state.proxySwitched.id === t.id && (
                      <span style={{ fontSize: 10, color: '#4ade80', whiteSpace: 'nowrap' }}>change sent ✓</span>
                    )}
                    <div style={{ flex: '0 0 150px' }}>
                      <StatusPill st={(proxyStatus[t.id] && !proxyStatus[t.id].hidden) ? proxyStatus[t.id] : st} />
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={e => { e.stopPropagation(); this.startTask(t); }}
                    >
                      Start
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={e => { e.stopPropagation(); this.stopTask(t.id); }}
                    >
                      Stop
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={e => { e.stopPropagation(); this.deleteTask(t.id); }}
                    >
                      Delete
                    </button>
                  </div>
                  {open && (
                    <div style={{ background: 'var(--panel-bg-alt, rgba(0,0,0,.18))' }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '5px 14px', fontSize: 10.5, color: 'var(--muted)',
                      }}>
                        <span>{tlogs.length} line{tlogs.length === 1 ? '' : 's'}</span>
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '2px 8px', fontSize: 10 }}
                          onClick={e => { e.stopPropagation(); this.copy(tlogs, t.id); }}
                          disabled={!tlogs.length}
                        >
                          {this.state.copied === t.id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <div style={{
                        maxHeight: 200, overflowY: 'auto',
                        padding: '4px 14px 8px', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
                      }}>
                        {tlogs.length === 0
                          ? <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>No output yet.</span>
                          : tlogs.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>
          </div>
        </div>

        {/* Right-click menu, rendered into document.body via a portal.
            NOT because of z-index — because of containing blocks. .panel sets backdrop-filter, and
            any transform/filter/backdrop-filter on an ancestor makes position:fixed resolve against
            THAT element instead of the viewport. Left in the tree, the menu took its coordinates
            from the panel's corner and opened nowhere near the pointer. The portal moves it out
            from under every such ancestor, so clientX/clientY mean what they say. */}
        {menu && ReactDOM.createPortal(
          <React.Fragment>
            {/* Full-screen backdrop: one click anywhere dismisses, including a second right-click.
                Cheaper and more reliable than a document listener that has to be added and removed
                in step with the menu's own lifetime. */}
            <div
              onClick={this.closeMenu}
              onContextMenu={e => { e.preventDefault(); this.closeMenu(); }}
              style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1400 }}
            />
            <div
              style={{
                position: 'fixed',
                // Clamped so a right-click near the bottom or right edge does not open a menu that
                // is half off screen and unreachable.
                left: Math.min(menu.x, window.innerWidth - 200),
                top: Math.min(menu.y, window.innerHeight - 132),
                zIndex: 1401, minWidth: 186,
                background: 'var(--modal-bg)', backdropFilter: 'var(--blur)', WebkitBackdropFilter: 'var(--blur)',
                border: '1px solid var(--panel-border)', borderRadius: 8, overflow: 'hidden',
                boxShadow: '0 8px 26px rgba(0,0,0,.45)', fontSize: 12,
              }}
            >
              <div style={{
                padding: '6px 12px', fontSize: 10.5, color: 'var(--muted)',
                borderBottom: '1px solid var(--panel-border)',
              }}>
                {selectedCount} task{selectedCount === 1 ? '' : 's'} selected
              </div>
              {[
                { label: 'Start', run: this.menuStart, color: '' },
                { label: 'Stop', run: this.menuStop, color: '' },
                { label: 'Delete', run: this.menuDelete, color: '#ff5a5a' },
              ].map(item => (
                <div
                  key={item.label}
                  onClick={item.run}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  style={{ padding: '8px 12px', cursor: 'pointer', color: item.color || 'var(--text)' }}
                >
                  {item.label}
                  {selectedCount > 1 && <span style={{ color: 'var(--muted)' }}> ({selectedCount})</span>}
                </div>
              ))}
            </div>
          </React.Fragment>,
          document.body
        )}

      </div>
    );
  }
}

export default connect(s => ({
  target: s.target,
  accounts: s.accounts,
  profiles: s.profiles,
  proxies: s.proxies,
}))(Target);
