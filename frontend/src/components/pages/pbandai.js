import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

// Per-account status pill styling (mirrors the engine's @@STATUS states).
// Known-good SKU used only by the Test Checkout dry run.
const TEST_SKU = 'F2768650001';

const STATUS_META = {
  starting:    { label: 'Starting…',        color: '#9aa0aa' },
  login:       { label: 'Login needed',      color: '#f5a623' },
  lostsession: { label: 'Re-login needed',   color: '#ff5a5a' },
  monitoring:  { label: 'Monitoring',        color: '#2dd4bf' },
  atc:         { label: 'Adding to cart',    color: '#a78bfa' },
  checkout:    { label: 'Checking out',      color: '#a78bfa' },
  blocked:     { label: 'IP blocked',        color: '#ff8c42' },
  rotating:    { label: 'Switching IP…',     color: '#38bdf8' },
  preallocation:{ label: 'Preallocation gate', color: '#f5a623' },
  success:     { label: 'Success ✓',         color: '#34d399' },
  declined:    { label: 'Declined',          color: '#ff5a5a' },
  auth:        { label: 'Bank verify',       color: '#f5a623' },
  unconfirmed: { label: 'Unclear',           color: '#f5a623' },
  retrying:    { label: 'Retrying…',         color: '#f5a623' },
  error:       { label: 'Error',             color: '#ff5a5a' },
};

// All P-Bandai state lives in redux (see store.js). This page is unmounted by the router on every
// tab switch, so anything kept in component state was destroyed — the UI showed "nothing running"
// while the browsers were still going — and the IPC listeners went with it, dropping restock and
// checkout events that arrived while you were on another tab. Listeners now live in page-handler.
class Pbandai extends Component {
  logBox = createRef();
  // picker filters + Coupon-Mode progress + the persisted { has, none } tally a re-scan works from
  state = { acctSearch: '', acctGroup: '', coupon: null, couponStats: null };

  componentDidMount() {
    this.scrollToBottom();
    this.loadCouponStats();
    this._onCoupon = (_e, p) => {
      this.setState({ coupon: p });
      // When a run finishes, pull the freshly-tagged profiles into the store so the Coupon group chip
      // shows up in the picker and can be selected.
      if (p && p.running === false) {
        try { this.props.dispatch({ type: 'update', obj: { profiles: ipcRenderer.sendSync('getProfiles') } }); } catch {}
        this.loadCouponStats();
      }
    };
    ipcRenderer.on('couponProgress', this._onCoupon);
  }
  componentWillUnmount() { try { ipcRenderer.removeListener('couponProgress', this._onCoupon); } catch {} }

  // Only auto-scroll when the user is already following the bottom. Capture that BEFORE the new lines
  // render — otherwise scrolling up to read history yanked them back down on every log line.
  getSnapshotBeforeUpdate(prev) {
    if (prev.pb.logs.length !== this.props.pb.logs.length && this.logBox.current) {
      const el = this.logBox.current;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;   // within 40px of the bottom = "following"
    }
    return null;
  }
  componentDidUpdate(prev, prevState, wasAtBottom) { if (wasAtBottom) this.scrollToBottom(); }

  scrollToBottom = () => { const el = this.logBox.current; if (el) el.scrollTop = el.scrollHeight; };

  set = (k, v) => this.props.dispatch({ type: 'pbandaiSet', obj: { [k]: v } });
  setWatchlist = (v) => {
    this.set('watchlist', v);
    try { ipcRenderer.send('saveWatchlist', v); } catch {}
  };

  // Test Checkout / Reset Session act on the first selected account (or the first profile if the
  // picker isn't shown), now that the Profile dropdown is gone.
  currentInstance = () => {
    const sel = this.selectedProfiles();
    const p = sel[0] || this.props.profiles[0];
    return { id: (p && p.id) || 'default', tag: (p && (p.profileName || p.email)) || 'default' };
  };

  // Turn the single 'connection' selector into the fields the engine expects.
  connPayload = () => {
    const c = this.props.pb.connection || 'none';
    if (c.startsWith('list:')) return { useVpn: false, inHousePool: '1', proxyListName: c.slice(5) };
    return { useVpn: false, inHousePool: '1', proxyListName: '' };
  };

  codesFromWatchlist = () => this.props.pb.watchlist.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

  launch = (id, tag, profileId) => {
    const pb = this.props.pb;
    if (pb.instances[id]) return false; // already running
    const codes = this.codesFromWatchlist();
    if (!codes.length) return false;
    this.props.dispatch({ type: 'pbandaiLaunch', id, tag });
    ipcRenderer.send('startPbandai', {
      instanceId: id, mode: 'monitor', codes,
      interval: Math.max(1, parseInt(pb.interval) || 3),
      qty: Math.max(1, parseInt(pb.qty) || 1),
      profileId, ...this.connPayload(), turbo: pb.turbo, headless: pb.headless, drop: pb.drop, area: 'us',
    });
    return true;
  };

  // Which accounts a launch starts. Filtering over `profiles` means a deleted profile's leftover id
  // in `selected` can't resurrect it. Only the untouched (null) state means "all".
  selectedProfiles = () => {
    const { profiles, pb } = this.props;
    if (!pb.selected) return profiles;
    return profiles.filter(p => pb.selected[p.id]);
  };

  isSelected = (id) => !this.props.pb.selected || !!this.props.pb.selected[id];

  toggleProfile = (id) => {
    const { profiles, pb } = this.props;
    // Untouched draws every box ticked, so unticking one must start from that same all-ticked map.
    // Starting from {} would make the unticked account the ONLY selected one — the inverse of the click.
    const base = pb.selected || Object.fromEntries(profiles.map(p => [p.id, true]));
    const selected = { ...base };
    if (selected[id]) delete selected[id]; else selected[id] = true;
    this.set('selected', selected);
  };

  // Shift-click selects the contiguous range from the last-clicked row to this one (file-explorer style),
  // over the CURRENTLY shown/filtered list. A plain click toggles just that row. `_lastIdx` is an instance
  // field (no re-render needed to remember the anchor).
  onRowClick = (e, i, shown) => {
    if (e.shiftKey && this._lastIdx != null && this._lastIdx !== i && shown[this._lastIdx]) {
      const { profiles, pb } = this.props;
      const [a, b] = this._lastIdx < i ? [this._lastIdx, i] : [i, this._lastIdx];
      const base = pb.selected || Object.fromEntries(profiles.map(p => [p.id, true]));
      const selected = { ...base };
      for (let k = a; k <= b; k++) if (shown[k]) selected[shown[k].id] = true;
      this.set('selected', selected);
    } else {
      this.toggleProfile(shown[i].id);
    }
    this._lastIdx = i;
  };

  selectAll  = () => this.set('selected', Object.fromEntries(this.props.profiles.map(p => [p.id, true])));
  selectNone = () => this.set('selected', {});   // {} is literal here — none, not "all"

  // Select / deselect a specific set (the search-filtered rows), leaving accounts outside the filter
  // untouched. Base = the current selection, or "all" when the picker has never been touched (null).
  selectShown = (shown, on) => {
    const { profiles, pb } = this.props;
    const base = pb.selected || Object.fromEntries(profiles.map(p => [p.id, true]));
    const selected = { ...base };
    shown.forEach(p => { if (on) selected[p.id] = true; else delete selected[p.id]; });
    this.set('selected', selected);
  };

  // Picking a group chip filters the picker to that group AND selects exactly its profiles, so one click
  // arms the whole group (e.g. "Coupon" selects all coupon-holders). Passing '' — the "All" chip, or
  // un-picking the active group — clears the filter and deselects everything.
  pickGroup = (g) => {
    if (!g) { this.setState({ acctGroup: '' }); this.set('selected', {}); return; }
    const ids = this.props.profiles.filter(p => (p.groups || []).includes(g)).map(p => p.id);
    this.setState({ acctGroup: g });
    this.set('selected', Object.fromEntries(ids.map(id => [id, true])));
  };

  // Coupon Mode: log into the selected accounts (all, if none selected), check /mypage/coupon, and
  // tag the ones that hold the free-shipping coupon into a "Coupon" group.
  startCouponCheck = () => {
    if (this.state.coupon && this.state.coupon.running) return;
    const ids = this.selectedProfiles().map(p => p.id);
    if (!ids.length) return;
    this.setState({ coupon: { done: 0, total: ids.length, has: 0, running: true } });
    ipcRenderer.send('startCouponCheck', { profileIds: ids, ...this.connPayload() });
  };
  stopCouponCheck = () => ipcRenderer.send('stopCouponCheck');

  // A definitive has/none is remembered in coupon-checks.json and skipped on the next run; accounts that
  // were only ever soft-blocked are NOT recorded, so they already retry on their own. These two just let
  // the operator forget recorded results — 'none' goes stale as P-Bandai issues new coupons, 'has' doesn't.
  loadCouponStats = () => { try { this.setState({ couponStats: ipcRenderer.sendSync('getCouponStats') }); } catch {} };
  forgetCouponChecks = (only) => {
    const s = this.state.couponStats || { has: 0, none: 0 };
    const n = only === 'none' ? s.none : s.has + s.none;
    if (!n) return;
    const what = only === 'none'
      ? `Re-check the ${n} account(s) confirmed to have no coupon?\n\nThe ${s.has} confirmed holder(s) stay skipped.`
      : `Forget all ${n} coupon result(s), including the ${s.has} confirmed holder(s)?\n\nThe next run re-checks every selected account from scratch.`;
    if (!window.confirm(what)) return;
    try { ipcRenderer.sendSync('clearCouponChecks', { only }); } catch {}
    this.loadCouponStats();
  };

  launchAll = () => {
    // Hard ceiling on simultaneous browsers — launching hundreds at once froze the machine. Count what's
    // already running, only fill the remaining slots, and tell the user if the selection was capped.
    const LAUNCH_CAP = 10;
    const pb = this.props.pb;
    const running = Object.keys(pb.instances || {}).length;
    const slots = Math.max(0, LAUNCH_CAP - running);
    const pending = this.selectedProfiles().filter(p => !pb.instances[p.id]);
    if (!slots) { window.alert(`Launch cap reached: ${LAUNCH_CAP} accounts are already running. Stop some before launching more.`); return; }
    const toLaunch = pending.slice(0, slots);
    toLaunch.forEach(p => this.launch(p.id, p.profileName || p.email, p.id));
    const skipped = pending.length - toLaunch.length;
    if (skipped > 0) window.alert(`Launched ${toLaunch.length} — capped at ${LAUNCH_CAP} simultaneous accounts${running ? ` (${running} already running)` : ''}. ${skipped} not launched; stop some and launch again for the rest.`);
  };

  // Rotate Mode: main runs up to 5 selected accounts; when one orders it closes and the next opens.
  // The Accounts board (driven by pbandaiStatus) shows which are live as they cycle.
  startRotate = () => {
    const pb = this.props.pb;
    const ids = this.selectedProfiles().map(p => p.id);
    const codes = this.codesFromWatchlist();
    if (!ids.length || !codes.length) return;
    // Tag every log line with its account, and mark rotate active so the button reflects it.
    this.props.dispatch({ type: 'pbandaiSet', obj: { rotate: true, multi: true } });
    const ok = ipcRenderer.sendSync('startPbandaiRotate', {
      profileIds: ids, codes,
      interval: Math.max(1, parseInt(pb.interval) || 15),
      qty: Math.max(1, parseInt(pb.qty) || 1),
      headless: pb.headless, drop: pb.drop,
      ...this.connPayload(),
    });
    if (!ok) this.props.dispatch({ type: 'pbandaiSet', obj: { rotate: false } });
  };

  // Dry run on the selected profile: adds the test SKU, fills shipping + card, and stops at the
  // payment page WITHOUT paying (engine `--nopay`). Runs headed so you can eyeball the filled form.
  // Uses the profile's own instanceId on purpose, so it reuses that account's logged-in browser
  // profile — which also means it replaces a monitor already running for this profile.
  testCheckout = () => {
    const { id, tag } = this.currentInstance();
    const pb = this.props.pb;
    if (pb.instances[id] && !window.confirm(`${tag} is running — stop it and start a test checkout?`)) return;
    this.props.dispatch({ type: 'pbandaiSet', obj: {
      instances: { ...pb.instances, [id]: { tag, state: 'starting', detail: 'test checkout' } },
    } });
    ipcRenderer.send('startPbandai', {
      instanceId: id, mode: 'single', productCode: TEST_SKU, dry: true,
      qty: 1, profileId: id, ...this.connPayload(), area: 'us',
    });
  };

  dropInstance = (id) => {
    const instances = { ...this.props.pb.instances };
    delete instances[id];
    this.props.dispatch({ type: 'pbandaiSet', obj: { instances } });
  };

  // Copy this account's email:password to the clipboard (decrypted in main; only {ok,email} returns).
  copyCreds = (id) => {
    try {
      const r = ipcRenderer.sendSync('copyAccountCreds', id) || {};
      window.alert(r.ok ? `Copied to clipboard:\n${r.email} + password` : (r.msg || 'Could not copy credentials.'));
    } catch {}
  };
  // Manual proxy rotate — relaunch this browser on a different proxy (clears a white/blank screen).
  rotateProxyInstance = (id) => { try { ipcRenderer.send('rotatePbandaiProxy', id); } catch {} };
  // Un-park an account that stopped on an unclear result / bank verification. The engine reloads and
  // re-fires the checkout, so the double-order risk is real — confirm before sending it.
  resumeInstance = (id) => {
    if (!window.confirm(
      'Resume this checkout?\n\nThe page reloads and the bot continues checking out from wherever it is.\n\n' +
      '⚠ The result was UNCLEAR — if that payment actually went through, resuming can place a SECOND order. ' +
      'Check the browser window (or your order history) first.'
    )) return;
    try { ipcRenderer.send('resumePbandai', id); } catch {}
  };
  // Acts on EVERY selected account, not just the first. Note selectedProfiles() returns all profiles
  // when the picker has never been touched (pb.selected === null means "all"), so this can legitimately
  // be 37 accounts — hence the count in the confirm. Each wipe forces that account to log in again.
  resetSession = () => {
    const sel = this.selectedProfiles();
    const targets = sel.length ? sel : (this.props.profiles[0] ? [this.props.profiles[0]] : []);
    if (!targets.length) return;
    const names = targets.map(p => p.profileName || p.email).filter(Boolean);
    const preview = names.slice(0, 8).join(', ') + (names.length > 8 ? `, +${names.length - 8} more` : '');
    const msg = targets.length === 1
      ? `Wipe the saved browser session for ${names[0] || 'this account'}?\n\nIt will have to log in again on the next Start.`
      : `Wipe the saved browser session for ${targets.length} accounts?\n\n${preview}\n\nEvery one of them will have to log in again on the next Start.`;
    if (!window.confirm(msg)) return;
    // ONE dispatch for the whole batch: React batches these handlers, so calling dropInstance() per
    // profile would each spread a STALE instances map and only the last delete would survive.
    const instances = { ...this.props.pb.instances };
    for (const p of targets) {
      try { ipcRenderer.send('resetPbandaiSession', p.id); } catch {}
      delete instances[p.id];
    }
    this.props.dispatch({ type: 'pbandaiSet', obj: { instances } });
  };

  // Button label: a count once more than one account is selected, so it can never look like it's
  // only going to touch a single profile when it's about to wipe many.
  resetLabel = () => {
    const sel = this.selectedProfiles();
    if (sel.length > 1) return `${sel.length} accounts`;
    const p = sel[0] || this.props.profiles[0];
    return (p && (p.profileName || p.email)) || 'default';
  };
  stopInstance = (id) => {
    ipcRenderer.sendSync('stopPbandai', id);
    this.dropInstance(id);
  };
  stopAll = () => {
    ipcRenderer.sendSync('stopAllPbandai');
    this.props.dispatch({ type: 'pbandaiSet', obj: { instances: {}, rotate: false } });
  };

  clearLogs = () => this.props.dispatch({ type: 'pbandaiSet', obj: { logs: [] } });
  copyLogs = () => { navigator.clipboard.writeText(this.props.pb.logs.join('\n')).catch(() => {}); };

  render() {
    const { profiles, pb } = this.props;
    const { qty, watchlist, interval, instances, logs, connection, drop } = pb;
    const { lastOrders, proxies } = this.props;
    const proxyLists = (proxies && proxies.lists) || [];
    const running = Object.entries(instances);
    const anyRunning = running.length > 0;
    const cur = this.currentInstance();
    const launchList = this.selectedProfiles();
    const launchable = launchList.filter(p => !instances[p.id]);   // a running account is skipped, so don't count it
    const acctQuery = (this.state.acctSearch || '').trim().toLowerCase();
    const acctGroup = this.state.acctGroup || '';
    const groups = [...new Set(profiles.flatMap(p => p.groups || []))].sort((a, b) => a.localeCompare(b));
    const shownProfiles = profiles.filter(p =>
      (!acctQuery || `${p.profileName || ''} ${p.email || ''}`.toLowerCase().includes(acctQuery)) &&
      (!acctGroup || (p.groups || []).includes(acctGroup)));
    const shownAllOn  = shownProfiles.length > 0 && shownProfiles.every(p => this.isSelected(p.id));
    const shownAllOff = shownProfiles.every(p => !this.isSelected(p.id));
    const coupon = this.state.coupon;
    const cstats = this.state.couponStats;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Bandai</div>
          <div className="page-actions">
            {anyRunning && (
              <button className="btn btn-secondary btn-sm" onClick={this.stopAll}>
                <i className="ion-md-square" style={{ fontSize: 11 }} /> Stop All ({running.length})
              </button>
            )}
          </div>
        </div>

        <div className="page-content">
          <div className="settings-section">
            <div className="form-group">
              <label className="form-label">Watchlist <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(one SKU per line)</span></label>
              <textarea
                className="form-textarea"
                style={{ minHeight: 70 }}
                placeholder={'N2903432003\nF1234567890'}
                value={watchlist}
                onChange={e => this.setWatchlist(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Connection</label>
              <select
                className="form-select"
                value={String(connection || '').startsWith('list:') ? connection : 'none'}
                onChange={e => this.set('connection', e.target.value)}
              >
                {proxyLists.map(l => (
                  <option key={proxyRef(l)} value={`list:${proxyRef(l)}`}>My Proxies: {proxyLabel(l)}</option>
                ))}
                <option value="none">None (home IP)</option>
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Qty</label>
                <input className="form-input" type="number" min="1" max="10" value={qty} onChange={e => this.set('qty', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Poll interval (sec)</label>
                <input className="form-input" type="number" min="1" max="60" value={interval} onChange={e => this.set('interval', e.target.value)} />
              </div>
            </div>
            {/* Headless toggle removed from the UI for now — runs headed (Shape flags headless harder).
                `pb.headless` stays in state (defaults false) so it can be re-enabled later. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', marginTop: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!drop} onChange={e => this.set('drop', e.target.checked)} />
              🐢 Drop Mode (patient — for a laggy / high-traffic drop)
            </label>
            {drop ? (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
                Doubles page-load timeouts and retries a truncated page once, so slow pages get time to load
                under heavy traffic. Turn off for normal fast conditions (quicker fail-over to a fresh IP).
              </div>
            ) : null}
            <div style={{ fontSize: 11, fontWeight: 700, color: '#ff5a5a', letterSpacing: 0.4, marginTop: 8 }}>
              ● LIVE — places real orders.
            </div>
            {profiles.length > 1 && (
              <div style={{ marginTop: 12, border: '1px solid var(--field-border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '7px 10px', background: 'var(--field)', borderBottom: '1px solid var(--field-border)' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3 }}>
                    Launch accounts <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({launchList.length} of {profiles.length}{(acctQuery || acctGroup) ? ` · ${shownProfiles.length} shown` : ''})</span>
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => this.selectShown(shownProfiles, true)} disabled={shownAllOn}>{(acctQuery || acctGroup) ? 'All shown' : 'All'}</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => this.selectShown(shownProfiles, false)} disabled={shownAllOff}>{(acctQuery || acctGroup) ? 'None shown' : 'None'}</button>
                  </div>
                </div>
                <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--field-border)', background: 'var(--field)' }}>
                  <input
                    type="text"
                    value={this.state.acctSearch}
                    onChange={e => this.setState({ acctSearch: e.target.value })}
                    placeholder="Search accounts by name or email…"
                    style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 8px',
                             border: '1px solid var(--field-border)', borderRadius: 6, background: 'var(--bg)', color: 'inherit', outline: 'none' }}
                  />
                </div>
                {groups.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--field-border)', background: 'var(--field)' }}>
                    <button onClick={() => this.pickGroup('')}
                      style={{ fontSize: 10, padding: '2px 9px', cursor: 'pointer', background: acctGroup ? 'transparent' : '#4f46e5', color: acctGroup ? 'var(--muted)' : '#fff', border: '1px solid var(--field-border)', borderRadius: 999 }}>All</button>
                    {groups.map(g => (
                      <button key={g} onClick={() => this.pickGroup(acctGroup === g ? '' : g)}
                        style={{ fontSize: 10, padding: '2px 9px', cursor: 'pointer', background: acctGroup === g ? '#4f46e5' : 'transparent', color: acctGroup === g ? '#fff' : 'var(--muted)', border: '1px solid var(--field-border)', borderRadius: 999 }}>{g}</button>
                    ))}
                  </div>
                )}
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {shownProfiles.length === 0 && (
                    <div style={{ padding: '10px', fontSize: 12, color: 'var(--muted)' }}>No accounts match{acctGroup ? ` group “${acctGroup}”` : ''}{this.state.acctSearch.trim() ? ` “${this.state.acctSearch.trim()}”` : ''}.</div>
                  )}
                  {shownProfiles.map((p, i) => {
                    const on = this.isSelected(p.id);
                    const isRunning = !!instances[p.id];
                    const ordered = lastOrders[p.id];
                    return (
                      <div
                        key={p.id}
                        onClick={(e) => this.onRowClick(e, i, shownProfiles)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', userSelect: 'none',
                                 background: on ? 'rgba(45,212,191,0.06)' : 'transparent' }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          readOnly
                          tabIndex={-1}
                          style={{ accentColor: '#2dd4bf', width: 14, height: 14, flexShrink: 0, pointerEvents: 'none' }}
                        />
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {p.profileName || p.email}
                          </span>
                          {ordered && (
                            <span style={{ fontSize: 10, color: '#34d399', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              Last placed order: {new Date(ordered).toLocaleString()}
                            </span>
                          )}
                        </span>
                        {isRunning && <span style={{ fontSize: 10, color: '#2dd4bf', fontWeight: 700, flexShrink: 0 }}>running</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Start selected accounts — the primary action, up top. */}
            <button
              className="btn btn-primary"
              onClick={this.launchAll}
              disabled={!watchlist.trim() || !launchable.length}
              style={{ width: '100%', marginTop: 12 }}
              title="Start a monitor for each selected account — up to 10 at once (a safety cap so a stray click can't open hundreds and freeze the machine). Accounts already running are skipped; stop some to launch more."
            >
              🚀{' '}
              {launchable.length
                ? (launchable.length > 10
                    ? `Launch 10 of ${launchable.length} Accounts`
                    : `Launch ${launchable.length} Account${launchable.length > 1 ? 's' : ''}`)
                : (launchList.length ? 'Selected accounts already running' : 'No accounts selected')}
            </button>
            {/* Rotate mode directly under Start. */}
            {profiles.length > 1 && (
              <button
                className="btn btn-secondary"
                onClick={this.startRotate}
                disabled={!watchlist.trim() || !launchList.length || pb.rotate}
                style={{ width: '100%', marginTop: 8, borderColor: '#38bdf8', color: '#38bdf8' }}
                title={`Rotate Mode: runs up to 5 selected accounts at once. When one places an order, it closes and the next account that hasn't ordered opens in its place — until all ${launchList.length} have had a turn.`}
              >
                {pb.rotate ? '🔄 Rotate Mode running…' : '🔄 Rotate Mode'}{' '}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(5 at a time, next after checkout)</span>
              </button>
            )}
            {/* Compact utilities — Coupon · Test · Reset — square buttons to save vertical space. */}
            {profiles.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary"
                    onClick={coupon && coupon.running ? this.stopCouponCheck : this.startCouponCheck}
                    disabled={!(coupon && coupon.running) && !launchList.length}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '10px 4px', lineHeight: 1.15 }}
                    title="Coupon Mode: log into the selected accounts, open /mypage/coupon, and tag the ones that hold the free-shipping coupon into a 'Coupon' group. Best run when your IPs are fresh."
                  >
                    <span style={{ fontSize: 16 }}>🎟</span>
                    <span style={{ fontSize: 11 }}>{coupon && coupon.running ? 'Stop' : 'Coupon'}</span>
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={this.testCheckout}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '10px 4px', lineHeight: 1.15 }}
                    title={`Test Checkout — dry run on ${cur.tag}: adds ${TEST_SKU}, fills shipping + card, stops AT the payment page. Never pays.`}
                  >
                    <span style={{ fontSize: 16 }}>🧪</span>
                    <span style={{ fontSize: 11 }}>Test</span>
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={this.resetSession}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '10px 4px', lineHeight: 1.15 }}
                    title="Reset Session — wipes the browser session of EVERY selected account for a clean Shape identity (the real fix for a persistent 501). Each re-logs in on next Start."
                  >
                    <span style={{ fontSize: 16 }}>🧹</span>
                    <span style={{ fontSize: 11 }}>Reset</span>
                  </button>
                </div>
                {coupon && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                    {coupon.running
                      ? `🎟 Checking… ${coupon.done}/${coupon.total} · ${coupon.has} have it → tagged “Coupon”`
                      : `✓ Done — ${coupon.has} of ${coupon.done} tagged “Coupon”`}
                  </div>
                )}
                {/* What's already on record. A definitive has/none is skipped next run; accounts that were
                    only soft-blocked were never recorded, so they retry by themselves — nothing to do here. */}
                {cstats && (cstats.has + cstats.none) > 0 && !(coupon && coupon.running) && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                    Checked so far: <b>{cstats.has + cstats.none}</b> — {cstats.has} have it, {cstats.none} don’t.
                    Both are skipped next run; anything blocked retries on its own.
                    {cstats.none > 0 && (
                      <>
                        {' '}
                        <span role="button" tabIndex={0} onClick={() => this.forgetCouponChecks('none')}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') this.forgetCouponChecks('none'); }}
                          style={{ color: '#38bdf8', cursor: 'pointer', textDecoration: 'underline' }}
                          title={`Forget the ${cstats.none} confirmed "no coupon" result(s) so the next run re-checks them. The ${cstats.has} confirmed holder(s) stay skipped — useful because P-Bandai issues coupons over time.`}>
                          Re-check the {cstats.none}
                        </span>
                      </>
                    )}
                    {' · '}
                    <span role="button" tabIndex={0} onClick={() => this.forgetCouponChecks()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') this.forgetCouponChecks(); }}
                      style={{ color: 'var(--muted)', cursor: 'pointer', textDecoration: 'underline' }}
                      title="Forget every recorded result, including the confirmed holders, and re-check all selected accounts from scratch.">
                      Clear all
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {anyRunning && (
            <div className="settings-section">
              <div className="settings-section-title">Accounts ({running.length})</div>
              {running.map(([id, inst]) => {
                const meta = STATUS_META[inst.state] || STATUS_META.starting;
                return (
                  <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--field-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0, boxShadow: `0 0 6px ${meta.color}` }} />
                      <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>{inst.tag}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.label}</span>
                      {inst.detail ? <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>· {inst.detail}</span> : null}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => this.copyCreds(id)} title="Copy this account's email:password to the clipboard">📋 Copy</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => this.rotateProxyInstance(id)} title="Rotate to a different proxy and relaunch this browser — fixes a white/blank screen or a stalled load">🔄 Proxy</button>
                      {['unconfirmed', 'auth'].includes(inst.state) && (
                        <button
                          className="btn btn-sm"
                          onClick={() => this.resumeInstance(id)}
                          style={{ borderColor: '#fbbf24', color: '#fbbf24' }}
                          title="Reload the page and continue this checkout from where it stalled. Check the window first — if the payment already went through, this can double-order."
                        >▶ Resume</button>
                      )}
                      <button className="btn btn-secondary btn-sm" onClick={() => this.stopInstance(id)}>Stop</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="settings-section" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span className="settings-section-title" style={{ margin: 0, padding: 0, border: 'none' }}>Live Log</span>
              {logs.length > 0 && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={this.copyLogs}>Copy</button>
                  <button className="btn btn-secondary btn-sm" onClick={this.clearLogs}>Clear</button>
                </div>
              )}
            </div>
            <div ref={this.logBox} style={{ overflowY: 'auto', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: 8, padding: 10, maxHeight: 300, minHeight: 120 }}>
              {logs.length === 0
                ? <div style={{ color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>No output yet.</div>
                : logs.map((l, i) => <div key={i} className="log-line">{l}</div>)}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({ profiles: s.profiles, pb: s.pbandai, lastOrders: s.lastOrders, proxies: s.proxies }))(Pbandai);
