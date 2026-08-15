import React, { Component, createRef } from 'react';
import { proxyLabel, proxyRef } from '../proxy-options';
import { timestampLogLine } from '../log-timestamp';
const { ipcRenderer } = window.require('electron');

// Round1 / ShortStack registration — N signups racing one form.
//
// Its own profile list, not the checkout profiles. A Round1 entry needs a name, an email and a pickup
// store; it has no card, no address and no site account. The browser extension already models it that
// way, so matching the shape makes export/import a copy rather than a translation.
//
// The store list is the 59 options read off the live Phase 2 form on 2026-07-17. Round1 flipped the
// format between phases ("Name ST" -> "ST Name"), and the engine's matcher is word-order- and
// whitespace-insensitive, so a profile saved under either format still matches whatever the live
// dropdown offers. Importing from the extension brings its self-updating list along with it.
const STORES = [
  'AZ Arrowhead Town Center', 'AZ Chandler Fashion Center', 'AZ Park Place Mall',
  'CA Burbank Town Center', 'CA Eastridge Shopping Center', 'CA Lakewood Mall', 'CA Main Place Mall',
  'CA Mission Viejo', 'CA Moreno Valley Mall', 'CA Northridge Mall', 'CA Plaza Bonita',
  'CA Puente Hills Mall', 'CA Roseville Mall', 'CA Southland Mall', 'CA Stonestown Galleria',
  'CA Sunvalley Mall', 'CA Temecula Mall', 'CO Southwest Plaza', 'CT Danbury Fair',
  'FL Pembroke Lakes Mall', 'GA Cumberland Mall', 'IL Fox Valley Mall', 'IL Gurnee Mills',
  'IL North Riverside Mall', 'KS Towne East Square', 'MA Holyoke Mall', 'MD Towson Town Center',
  'ME Maine Mall', 'MI Great Lakes Crossing', 'NC Four Seasons', 'NE Gateway Mall',
  'NJ Deptford Mall', 'NJ Jersey Gardens', 'NJ Menlo Park Mall', 'NM Coronado Mall',
  'NV Las Vegas South Premium Outlets', 'NV Meadowood Mall', 'NV Meadows Mall', 'NY Broadway Mall',
  'NY Crystal Run', 'OH Fairfield Commons', 'OH Great Lakes Mall', 'OK Quail Springs Mall',
  'OR Valley River', 'PA Exton Square Mall', 'PA Fashion District', 'PA Millcreek Mall',
  'PA Park City Center', 'TX Arlington Parks Mall', 'TX Deerbrook Mall', 'TX Grapevine Mills Mall',
  'TX North Star Mall', 'TX Willowbrook Mall', 'UT South Town Mall', 'VA Potomac Mills Mall',
  'WA South Center Mall', 'WA South Hill Mall', 'WA Vancouver Mall', 'WI Southridge Mall',
];

// store starts EMPTY on purpose. Defaulting it meant a profile you never touched still carried a
// real pickup location, so a signup could quietly go to the wrong mall. Blank forces a choice.
const BLANK = { id: '', first: '', last: '', email: '', store: '', marketing: false };

export default class Round1 extends Component {
  logBox = createRef();
  state = {
    profiles: [], selected: {}, editing: null, url: '',
    statuses: {}, logs: [], running: false, msg: '',
    // 'list:<name>' selects a saved list; 'none' uses the home IP.
    connection: 'none', proxyLists: [], showBrowsers: false, storeOpen: false,
    staggerMs: 400, maxConcurrent: 8,
    // Request mode: no browser at all, Turnstile handed to a captcha service. Off by default -- the
    // submit call is the one step never verified against a live form.
    requestMode: false, solverProvider: 'capsolver', solverKey: '',
  };

  componentDidMount() {
    this.load();
    this._onLog = (_e, p) => this.setState((s) => ({
      logs: [...s.logs, timestampLogLine(`[${p.tag}] ${p.line}`)].slice(-500),
    }));
    // MERGE, do not replace. Cloudflare state arrives on its own channel and lands on the same
    // object; rebuilding it here dropped `cf` on every status line, so the chip appeared during
    // "solving" and then vanished the moment the task moved on — including on success, which is
    // exactly when you want to see that Cloudflare was cleared.
    this._onStatus = (_e, p) => this.setState((s) => ({
      statuses: (() => {
        const prev = s.statuses[p.instanceId] || {};
        // Keep a trail of the stages a task went through, not just the latest one.
        //
        // A request-mode run finishes in about three seconds, so every stage between "loading" and
        // "success" flashed past faster than anyone could read: the row only ever appeared to say
        // loading, then success. The trail makes the run legible after the fact, which is the whole
        // point of showing progress on a task that is over before you look at it.
        //
        // Consecutive duplicates are dropped so a repeated heartbeat does not pad the trail, and it
        // is capped so a long-running retry loop cannot grow the row without bound.
        const stages = (prev.stages || []).slice();
        if (p.detail && stages[stages.length - 1] !== p.detail) stages.push(p.detail);
        return { ...s.statuses, [p.instanceId]: { ...prev, tag: p.tag, state: p.state, detail: p.detail, stages: stages.slice(-6) } };
      })(),
    }));
    this._onDone = (_e, p) => this.setState((s) => {
      const st = { ...s.statuses };
      // Never overwrite a terminal verdict with "exited" — that verdict is the only thing worth reading.
      // "rotate" is not terminal either: the child DID exit, but only so the main process can respawn
      // it on another proxy line. Showing "exited" there would also flip `live` false and re-enable
      // Start for the half-second before the replacement launches.
      if (st[p.instanceId] && !['success', 'soldout', 'closed', 'maxattempts', 'rotate'].includes(st[p.instanceId].state)) {
        st[p.instanceId] = { ...st[p.instanceId], state: 'exited', detail: `code ${p.code}` };
      }
      const live = Object.values(st).some((x) => !['success', 'soldout', 'closed', 'exited', 'maxattempts', 'error'].includes(x.state));
      return { statuses: st, running: live };
    });
    this._onCf = (_e, p) => this.setState((s) => ({
      statuses: { ...s.statuses, [p.instanceId]: { ...(s.statuses[p.instanceId] || { tag: p.tag, state: '', detail: '' }), cf: p.cf, cfDetail: p.detail } },
    }));
    ipcRenderer.on('round1Cf', this._onCf);
    ipcRenderer.on('round1Log', this._onLog);
    ipcRenderer.on('round1Status', this._onStatus);
    ipcRenderer.on('round1Done', this._onDone);
    try {
      const s = ipcRenderer.sendSync('getSettings') || {};
      const px = ipcRenderer.sendSync('getProxies') || {};
      this.setState({
        url: s.round1Url || '',
        proxyLists: px.lists || [],
        // Remembered per install: the right pool for Round1 is not the right pool for Target, and
        // re-picking it on every launch is how you end up racing a drop on the home IP by accident.
        connection: String(s.round1Connection || '').startsWith('list:') ? s.round1Connection : 'none',
        showBrowsers: !!s.round1ShowBrowsers,
        staggerMs: s.round1StaggerMs == null ? 400 : s.round1StaggerMs,
        maxConcurrent: s.round1MaxConcurrent == null ? 8 : s.round1MaxConcurrent,
        requestMode: !!s.round1RequestMode,
        solverProvider: s.round1SolverProvider || 'capsolver',
        solverKey: s.round1SolverKey || '',
      });
    } catch {}
  }

  componentWillUnmount() {
    try {
      ipcRenderer.removeListener('round1Log', this._onLog);
      ipcRenderer.removeListener('round1Status', this._onStatus);
      ipcRenderer.removeListener('round1Done', this._onDone);
      ipcRenderer.removeListener('round1Cf', this._onCf);
    } catch {}
  }

  componentDidUpdate(_p, prev) {
    if (prev.logs !== this.state.logs && this.logBox.current) {
      const el = this.logBox.current;
      el.scrollTop = el.scrollHeight;
    }
  }

  load = () => { try { this.setState({ profiles: ipcRenderer.sendSync('getRound1Profiles') || [] }); } catch {} };
  persist = (list) => { try { this.setState({ profiles: ipcRenderer.sendSync('saveRound1Profiles', list) || [] }); } catch {} };

  chosen = () => this.state.profiles.filter((p) => this.state.selected[p.id]);

  // Emails shared by more than one SELECTED profile. ShortStack keys entries on email — the list id
  // is the same across phases — so duplicates are near-certainly deduped server-side. Running them
  // spends a browser, a proxy IP and a slot in the concurrency budget to produce a rejected entry,
  // and nothing in the log would say so: each task reports its own success independently.
  dupeEmails = () => {
    const byEmail = {};
    for (const p of this.chosen()) {
      const k = (p.email || '').trim().toLowerCase();
      if (k) (byEmail[k] = byEmail[k] || []).push(p);
    }
    return Object.entries(byEmail).filter(([, v]) => v.length > 1);
  };

  saveEditing = () => {
    const e = this.state.editing;
    if (!e || !e.first.trim() || !e.email.trim() || !e.store) return;
    const list = [...this.state.profiles];
    const i = list.findIndex((p) => p.id === e.id);
    if (i >= 0) list[i] = e; else list.push({ ...e, id: `r1_${Date.now()}` });
    this.persist(list);
    this.setState({ editing: null });
  };

  remove = (id) => {
    if (!window.confirm('Delete this signup profile?')) return;
    this.persist(this.state.profiles.filter((p) => p.id !== id));
  };

  // Copy a signup and open it for editing rather than saving it straight away.
  //
  // Everything about a Round1 entry repeats except the email: same name, same store, same marketing
  // choice. Retyping all of that per entry is the slow part of preparing for a drop.
  //
  // The copy deliberately does NOT keep:
  //   id            — a fresh one, or persist() would treat this as an edit of the original
  //   email         — cleared, because it MUST differ (one entry per person) and a silent duplicate
  //                   is the one mistake this screen should never help you make
  //   registeredAt  — the original may already have an entry; the copy has not.
  duplicate = (src) => {
    const { id, email, registeredAt, ...rest } = src;
    this.setState({
      editing: { ...BLANK, ...rest, id: '', email: '', profileName: `${src.profileName || src.first || 'signup'} copy` },
    });
  };

  exportProfiles = async () => {
    try {
      const r = await ipcRenderer.invoke('exportRound1Profiles');
      if (r.canceled) return;
      this.setState({ msg: r.ok ? `Exported ${r.count} profile(s) to ${r.filePath}` : `Export failed: ${r.error}` });
    } catch (err) { this.setState({ msg: `Export failed: ${err.message}` }); }
  };

  importProfiles = async (replace) => {
    try {
      const r = await ipcRenderer.invoke('importRound1Profiles', { replace });
      if (r.canceled) return;
      if (!r.ok) { this.setState({ msg: `Import failed: ${r.error}` }); return; }
      this.load();
      this.setState({ msg: replace ? `Replaced with ${r.profiles.length} profile(s)` : `Imported — ${r.added} new, ${r.updated} updated` });
    } catch (err) { this.setState({ msg: `Import failed: ${err.message}` }); }
  };

  // Mirrors pbandai's connPayload so the same selection means the same thing in both tabs.
  connPayload = () => {
    const c = this.state.connection || 'none';
    if (c.startsWith('list:')) return { useVpn: false, inHousePool: '1', proxyListName: c.slice(5) };
    return { useVpn: false, inHousePool: '1', proxyListName: '' };
  };

  start = () => {
    const ids = this.chosen().map((p) => p.id);
    const url = this.state.url.trim();
    if (!ids.length || !url) return;
    const dupes = this.dupeEmails();
    if (dupes.length) {
      const lines = dupes.map(([e, v]) => `  ${e} — ${v.length} profiles`).join('\n');
      if (!window.confirm(
        `${dupes.length} email address(es) are used by more than one selected profile:\n\n${lines}\n\n` +
        'Round1 keys entries on email, so only one per address will count. The rest will spend a ' +
        'browser and a proxy IP on an entry that gets rejected.\n\nStart anyway?')) return;
    }
    // Persist both: the campaign URL changes once a phase, the pool rarely — and retyping either
    // under time pressure is exactly when a mistake costs the drop.
    try {
      const next = { ...(ipcRenderer.sendSync('getSettings') || {}), round1Url: url, round1Connection: this.state.connection, round1ShowBrowsers: this.state.showBrowsers, round1StaggerMs: this.state.staggerMs, round1MaxConcurrent: this.state.maxConcurrent,
        round1RequestMode: this.state.requestMode, round1SolverProvider: this.state.solverProvider,
        round1SolverKey: this.state.solverKey };
      ipcRenderer.sendSync('saveSettings', next);
    } catch {}
    this.setState({ running: true, statuses: {}, logs: [], msg: '' });
    ipcRenderer.sendSync('startRound1', {
      profileIds: ids, url, ...this.connPayload(),
      offscreen: !this.state.showBrowsers,
      stagger: parseInt(this.state.staggerMs, 10) || 0,
      maxConcurrent: parseInt(this.state.maxConcurrent, 10) || 0,
      requestMode: this.state.requestMode,
      solverProvider: this.state.solverProvider,
      solverKey: this.state.solverKey,
    });
  };

  stop = () => { try { ipcRenderer.sendSync('stopAllRound1'); } catch {} this.setState({ running: false }); };


  // Cloudflare is reported separately because it is a different question from what the task is doing:
  // a task can be "watching" with Cloudflare solved, or "watching" with it still solving, and those
  // need different reactions from the operator.
  cfChip(cf) {
    if (!cf) return null;
    const map = {
      solving: ['#e0b050', 'CF solving'],
      solved: ['#4ade80', 'CF solved'],
      failed: ['#f87171', 'CF failed'],
      unknown: ['var(--muted)', 'CF unknown'],
    };
    const [col, label] = map[cf] || ['var(--muted)', `CF ${cf}`];
    return <span style={{ color: col, fontSize: 11, whiteSpace: 'nowrap' }}>{label}</span>;
  }

  colour(state) {
    if (state === 'success') return '#4ade80';
    if (['error', 'soldout', 'closed', 'maxattempts'].includes(state)) return '#f87171';
    if (state === 'challenge') return '#e0b050';
    if (['filling', 'submitting'].includes(state)) return '#38bdf8';
    return 'var(--muted)';
  }

  renderEditor() {
    const e = this.state.editing;
    const { storeOpen } = this.state;
    if (!e) return null;
    return (
      // Lifted above the panels that follow it. Sibling settings cards paint in DOM order, so
      // the Signups card below can cover this dropdown no matter how high the list's own
      // z-index is (that only competes INSIDE this card). Raising the card itself is what
      // actually works. 10 clears sibling sections while staying far below the titlebar (100)
      // and modals (1000).
      <div className="settings-section" style={{ position: 'relative', zIndex: 10 }}>
        <div className="settings-section-title">{e.id ? 'Edit signup' : 'New signup'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">First name</label>
            <input className="form-input" value={e.first} onChange={(ev) => this.setState({ editing: { ...e, first: ev.target.value } })} />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Last name</label>
            <input className="form-input" value={e.last} onChange={(ev) => this.setState({ editing: { ...e, last: ev.target.value } })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input monospace" value={e.email} onChange={(ev) => this.setState({ editing: { ...e, email: ev.target.value } })} />
        </div>
        <div className="form-group" style={{ position: 'relative' }}>
          <label className="form-label">Pickup store</label>
          {/* Free text with suggestions rather than a locked <select>: Round1 renames its stores
              between phases, and a hard list would make a newly-added location unreachable.
              Hand-rolled rather than a <datalist>: Chromium's native datalist popup gave no usable
              scrollbar here, so 59 stores were unreachable past the first handful. */}
          <input className="form-input" value={e.store} placeholder="Type to filter, or enter a new store"
            autoComplete="off"
            onFocus={() => this.setState({ storeOpen: true })}
            // A click on an option is a blur first, so closing immediately would cancel the pick.
            onBlur={() => setTimeout(() => this.setState({ storeOpen: false }), 150)}
            onChange={(ev) => this.setState({ editing: { ...e, store: ev.target.value }, storeOpen: true })} />
          {storeOpen && (() => {
            const q = (e.store || '').trim().toLowerCase();
            // Match on any word, so "willow", "tx" and "mall willow" all find TX Willowbrook Mall.
            const hits = q ? STORES.filter((s) => q.split(/\s+/).every((w) => s.toLowerCase().includes(w))) : STORES;
            if (!hits.length) return null;
            return (
              /* --panel-solid, not --panel: --panel is translucent and let the form behind
                 the list show straight through it. Mac adds blur through .glass-surface. */
              <div className="glass-surface" style={{
                position: 'absolute', zIndex: 30, left: 0, right: 0, top: '100%', marginTop: 2,
                maxHeight: 220, overflowY: 'auto',
                border: '1px solid var(--panel-border)', borderRadius: 6,
                boxShadow: '0 8px 20px rgba(0,0,0,.45)',
              }}>
                {hits.map((s) => (
                  <div key={s} title={s}
                    onMouseDown={() => this.setState({ editing: { ...e, store: s }, storeOpen: false })}
                    style={{
                      padding: '7px 10px', fontSize: 12, cursor: 'pointer',
                      background: s === e.store ? 'var(--panel-hover)' : 'transparent',
                    }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--panel-hover)'; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = s === e.store ? 'var(--panel-hover)' : 'transparent'; }}>
                    {s}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={e.marketing} onChange={(ev) => this.setState({ editing: { ...e, marketing: ev.target.checked } })} />
          Tick the marketing / offers box
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-primary btn-sm" onClick={this.saveEditing}>Save</button>
          <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ editing: null })}>Cancel</button>
        </div>
      </div>
    );
  }

  render() {
    const { profiles, url, statuses, logs, running, msg, selected, connection, proxyLists, showBrowsers } = this.state;
    const chosen = this.chosen();
    const rows = Object.entries(statuses);
    const wins = rows.filter(([, s]) => s.state === 'success').length;

    return (
      // Explicit flex column with height:100% — .page-content only scrolls inside a constrained
      // parent, and without this the log ran off the bottom of the window with no scrollbar.
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Round1</div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ editing: { ...BLANK } })}>+ New signup</button>
            <button className="btn btn-secondary btn-sm" onClick={this.exportProfiles}>Export</button>
            <button className="btn btn-secondary btn-sm" onClick={() => this.importProfiles(false)}>Import</button>
          </div>
        </div>

        <div className="page-content">
          {msg && <div style={{ fontSize: 12, color: '#4ade80', marginBottom: 10 }}>{msg}</div>}

          <div className="settings-section">
            <div className="settings-section-title">Campaign</div>
            <input className="form-input monospace" placeholder="https://round1usa.cmpgn.page/XXXXXX"
              value={url} onChange={(ev) => this.setState({ url: ev.target.value })} />
            <div className="form-group" style={{ marginTop: 10, marginBottom: 0 }}>
              <label className="form-label">Proxies</label>
              <select className="form-select" value={connection}
                onChange={(ev) => this.setState({ connection: ev.target.value })}>
                {proxyLists.map((l) => (
                  <option key={proxyRef(l)} value={`list:${proxyRef(l)}`}>My Proxies: {proxyLabel(l)}</option>
                ))}
                <option value="none">None (home IP)</option>
              </select>
            </div>
            {/* Concurrency cap and start spacing are fixed at the measured-good values (see the
                defaults in state and R1 notes in electron.js) rather than exposed — they are tuning,
                not a decision to make per run. Change the defaults to change them. */}
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={showBrowsers}
                onChange={(ev) => this.setState({ showBrowsers: ev.target.checked })} />
              Show browser windows
            </label>
            {connection === 'none' && (
              <div style={{ fontSize: 11, color: '#e0b050', marginTop: 6 }}>
                Every selected signup will share your home IP — fine for one, not for several.
              </div>
            )}
          </div>

          {this.renderEditor()}

          <div className="settings-section">
            <div className="settings-section-title">Signups ({chosen.length} of {profiles.length} selected)</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selected: Object.fromEntries(profiles.map((p) => [p.id, true])) })}>All</button>
              <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selected: {} })}>None</button>
              <span style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" onClick={() => this.importProfiles(true)}>Import (replace)</button>
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {profiles.length === 0 && (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>
                  No signup profiles yet. Add one, or Import a file exported from the browser extension.
                </div>
              )}
              {profiles.map((p) => {
                const st = statuses[`r1-${p.id}`];
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 12 }}>
                    <input type="checkbox" checked={!!selected[p.id]}
                      onChange={() => this.setState((s) => ({ selected: { ...s.selected, [p.id]: !s.selected[p.id] } }))} />
                    <span style={{ flex: 1 }}>{p.first} {p.last} <span style={{ color: 'var(--muted)' }}>{p.email}</span></span>
                    <span style={{ color: 'var(--muted)', width: 190 }}>{p.store || <span style={{ color: '#e0b050' }}>no store</span>}</span>
                    {st && <span style={{ color: this.colour(st.state), width: 84 }}>{st.state}</span>}
                    {st && <span style={{ width: 78 }}>{this.cfChip(st.cf)}</span>}
                    <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ editing: { ...BLANK, ...p } })}>Edit</button>
                    <button className="btn btn-secondary btn-sm" title="Duplicate — copies everything except the email"
                      onClick={() => this.duplicate(p)}>Duplicate</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => this.remove(p.id)}>✕</button>
                  </div>
                );
              })}
            </div>
            {this.dupeEmails().length > 0 && (
              <div style={{ fontSize: 11, color: '#e0b050', marginTop: 8 }}>
                ⚠ {this.dupeEmails().length} email(s) used by more than one selected profile — Round1 counts one entry per address.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <div className="form-group" style={{ width: '100%', marginBottom: 10 }}>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={this.state.requestMode}
                    onChange={(e) => this.setState({ requestMode: e.target.checked })} />
                  Request mode — no browser, solver-based
                </label>
                {this.state.requestMode && (
                  <div className="form-row" style={{ marginTop: 8 }}>
                    <select className="form-select" value={this.state.solverProvider}
                      onChange={(e) => this.setState({ solverProvider: e.target.value })}>
                      <option value="capsolver">CapSolver</option>
                      <option value="anticaptcha">Anti-Captcha</option>
                      <option value="capmonster">CapMonster</option>
                      <option value="twocaptcha">2Captcha</option>
                    </select>
                    <input className="form-input monospace" type="password" placeholder="solver API key"
                      value={this.state.solverKey}
                      onChange={(e) => this.setState({ solverKey: e.target.value })} />
                  </div>
                )}
                {this.state.requestMode && !this.state.solverKey.trim() && (
                  <div className="form-hint" style={{ color: 'var(--warn, #d89b2c)' }}>
                    No key — tasks will fall back to the browser engine.
                  </div>
                )}
              </div>
              <button className="btn btn-primary" style={{ flex: 1 }} disabled={running || !chosen.length || !url.trim()} onClick={this.start}>
                ▶ Start {chosen.length || ''} signup{chosen.length === 1 ? '' : 's'}
              </button>
              <button className="btn btn-secondary" disabled={!running} onClick={this.stop}>⏹ Stop all</button>
            </div>
          </div>

          {rows.length > 0 && (
            <div className="settings-section">
              <div className="settings-section-title">Running ({rows.length}){wins ? ` · ${wins} registered` : ''}</div>
              {rows.map(([iid, s]) => (
                <div key={iid} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '3px 0' }}>
                  <span style={{ flex: 1 }}>{s.tag}</span>
                  <span style={{ color: this.colour(s.state), width: 70 }}>{s.state}</span>
                  <span style={{ width: 80 }}>{this.cfChip(s.cf)}</span>
                  <span style={{ color: 'var(--text)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={(s.stages || []).join('  →  ')}>
                    {s.cf === 'solving' ? (s.cfDetail || s.detail) : s.detail}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="settings-section">
            <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>Log{logs.length ? ` (${logs.length} lines)` : ''}</span>
              <button className="btn btn-secondary btn-sm" disabled={!logs.length}
                onClick={() => {
                  try {
                    // clipboard.writeText, not navigator.clipboard: this renderer has nodeIntegration
                    // and no secure-context/focus requirements, and it works while the window is not
                    // focused — which it often will not be, since the browsers run off-screen.
                    window.require('electron').clipboard.writeText(logs.join('\n'));
                    this.setState({ msg: `Copied ${logs.length} log line(s)` });
                  } catch (e) { this.setState({ msg: `Copy failed: ${e.message}` }); }
                }}>Copy</button>
              <button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} disabled={!logs.length}
                onClick={() => this.setState({ logs: [] })}>Clear</button>
            </div>
            <div ref={this.logBox} className="monospace"
              style={{ height: 240, overflowY: 'auto', fontSize: 11, background: '#0b0d10',
                       border: '1px solid var(--border)', borderRadius: 6, padding: 8, whiteSpace: 'pre-wrap' }}>
              {logs.length === 0 ? <span style={{ color: 'var(--muted)' }}>Nothing yet.</span> : logs.join('\n')}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
