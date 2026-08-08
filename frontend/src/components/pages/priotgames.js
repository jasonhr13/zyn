import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

const STATUS_META = {
  starting:    { label: 'Starting…',        color: '#9aa0aa' },
  login:       { label: 'Login needed',      color: '#f5a623' },
  lostsession: { label: 'Re-login needed',   color: '#ff5a5a' },
  monitoring:  { label: 'Monitoring',        color: '#2dd4bf' },
  registering: { label: 'Registering',       color: '#a78bfa' },
  blocked:     { label: 'IP blocked',        color: '#ff8c42' },
  rotating:    { label: 'Switching IP…',     color: '#38bdf8' },
  success:     { label: 'Success ✓',         color: '#34d399' },
  declined:    { label: 'Declined',          color: '#ff5a5a' },
  error:       { label: 'Error',             color: '#ff5a5a' },
};

class RiotGames extends Component {
  logBox = createRef();

  componentDidMount() { this.scrollToBottom(); }

  getSnapshotBeforeUpdate(prev) {
    if (prev.rg.logs.length !== this.props.rg.logs.length && this.logBox.current) {
      const el = this.logBox.current;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    return null;
  }
  componentDidUpdate(prev, prevState, wasAtBottom) { if (wasAtBottom) this.scrollToBottom(); }

  scrollToBottom = () => { const el = this.logBox.current; if (el) el.scrollTop = el.scrollHeight; };

  set = (k, v) => this.props.dispatch({ type: 'riotgamesSet', obj: { [k]: v } });
  setWatchlist = (v) => {
    this.set('watchlist', v);
    try { ipcRenderer.send('saveWatchlist', v); } catch {}
  };

  currentInstance = () => {
    const sel = this.selectedProfiles();
    const p = sel[0] || this.props.profiles[0];
    return { id: (p && p.id) || 'default', tag: (p && (p.profileName || p.email)) || 'default' };
  };

  connPayload = () => {
    const c = this.props.rg.connection || 'inhouse1';
    if (c === 'none') return { useVpn: false, inHousePool: '1', proxyListName: '' };
    if (c.startsWith('list:')) return { useVpn: false, inHousePool: '1', proxyListName: c.slice(5) };
    return { useVpn: true, inHousePool: c.replace('inhouse', '') || '1', proxyListName: '' };
  };

  codesFromWatchlist = () => this.props.rg.watchlist.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

  launch = (id, tag, profileId) => {
    const rg = this.props.rg;
    if (rg.instances[id]) return false;
    const codes = this.codesFromWatchlist();
    if (!codes.length) return false;
    this.props.dispatch({ type: 'riotgamesLaunch', id, tag });
    ipcRenderer.send('startRiotGames', {
      instanceId: id, mode: 'monitor', codes,
      interval: Math.max(1, parseInt(rg.interval) || 15),
      qty: Math.max(1, parseInt(rg.qty) || 1),
      profileId, ...this.connPayload(),
    });
    return true;
  };

  selectedProfiles = () => {
    const { profiles, rg } = this.props;
    if (!rg.selected) return profiles;
    return profiles.filter(p => rg.selected[p.id]);
  };

  isSelected = (id) => !this.props.rg.selected || !!this.props.rg.selected[id];

  toggleProfile = (id) => {
    const { profiles, rg } = this.props;
    const base = rg.selected || Object.fromEntries(profiles.map(p => [p.id, true]));
    const selected = { ...base };
    if (selected[id]) delete selected[id]; else selected[id] = true;
    this.set('selected', selected);
  };

  selectAll  = () => this.set('selected', Object.fromEntries(this.props.profiles.map(p => [p.id, true])));
  selectNone = () => this.set('selected', {});

  launchAll = () => {
    this.selectedProfiles().forEach(p => this.launch(p.id, p.profileName || p.email, p.id));
  };

  dropInstance = (id) => {
    const instances = { ...this.props.rg.instances };
    delete instances[id];
    this.props.dispatch({ type: 'riotgamesSet', obj: { instances } });
  };

  copyCreds = (id) => {
    try {
      const r = ipcRenderer.sendSync('copyAccountCreds', id) || {};
      window.alert(r.ok ? `Copied to clipboard:\n${r.email} + password` : (r.msg || 'Could not copy credentials.'));
    } catch {}
  };

  rotateProxyInstance = (id) => { try { ipcRenderer.send('rotateRiotGamesProxy', id); } catch {} };

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
    const instances = { ...this.props.rg.instances };
    for (const p of targets) {
      try { ipcRenderer.send('resetRiotGamesSession', p.id); } catch {}
      delete instances[p.id];
    }
    this.props.dispatch({ type: 'riotgamesSet', obj: { instances } });
  };

  resetLabel = () => {
    const sel = this.selectedProfiles();
    if (sel.length > 1) return `${sel.length} accounts`;
    const p = sel[0] || this.props.profiles[0];
    return (p && (p.profileName || p.email)) || 'default';
  };

  stopInstance = (id) => {
    ipcRenderer.sendSync('stopRiotGames', id);
    this.dropInstance(id);
  };

  stopAll = () => {
    ipcRenderer.sendSync('stopAllRiotGames');
    this.props.dispatch({ type: 'riotgamesSet', obj: { instances: {} } });
  };

  clearLogs = () => this.props.dispatch({ type: 'riotgamesSet', obj: { logs: [] } });
  copyLogs = () => { navigator.clipboard.writeText(this.props.rg.logs.join('\n')).catch(() => {}); };

  render() {
    const { profiles, rg } = this.props;
    const { qty, watchlist, interval, instances, logs, connection } = rg;
    const { proxies } = this.props;
    const proxyLists = (proxies && proxies.lists) || [];
    const running = Object.entries(instances);
    const anyRunning = running.length > 0;
    const cur = this.currentInstance();
    const launchList = this.selectedProfiles();
    const launchable = launchList.filter(p => !instances[p.id]);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Riot Games</div>
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
              <label className="form-label">Watchlist <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(event codes or SKUs, one per line)</span></label>
              <textarea
                className="form-textarea"
                style={{ minHeight: 70 }}
                placeholder={'riftbound-event-1\nriftbound-event-2'}
                value={watchlist}
                onChange={e => this.setWatchlist(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Connection</label>
              <select
                className="form-select"
                value={connection || 'inhouse1'}
                onChange={e => this.set('connection', e.target.value)}
              >
                <option value="inhouse1">In-House Proxy 1</option>
                <option value="inhouse2">In-House Proxy 2</option>
                <option value="inhouse3">In-House Proxy 3</option>
                <option value="inhousemix">In-House Proxy Mix (all 3)</option>
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
            {profiles.length > 1 && (
              <div style={{ marginTop: 12, border: '1px solid var(--field-border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: '7px 10px', background: 'var(--field)', borderBottom: '1px solid var(--field-border)' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3 }}>
                    Launch accounts <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({launchList.length} of {profiles.length})</span>
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={this.selectAll} disabled={launchList.length === profiles.length}>All</button>
                    <button className="btn btn-secondary btn-sm" onClick={this.selectNone} disabled={!launchList.length}>None</button>
                  </div>
                </div>
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {profiles.map(p => {
                    const on = this.isSelected(p.id);
                    const isRunning = !!instances[p.id];
                    return (
                      <label
                        key={p.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer',
                                 background: on ? 'rgba(45,212,191,0.06)' : 'transparent' }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => this.toggleProfile(p.id)}
                          style={{ accentColor: '#2dd4bf', width: 14, height: 14, flexShrink: 0 }}
                        />
                        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {p.profileName || p.email}
                          </span>
                        </span>
                        {isRunning && <span style={{ fontSize: 10, color: '#2dd4bf', fontWeight: 700, flexShrink: 0 }}>running</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              className="btn btn-primary"
              onClick={this.launchAll}
              disabled={!watchlist.trim() || !launchable.length}
              style={{ width: '100%', marginTop: 12 }}
              title="Start a monitor for each selected account. Accounts already running are skipped."
            >
              🚀{' '}
              {launchable.length
                ? `Launch ${launchable.length} Account${launchable.length > 1 ? 's' : ''}`
                : (launchList.length ? 'Selected accounts already running' : 'No accounts selected')}
            </button>
            <button
              className="btn btn-secondary"
              onClick={this.resetSession}
              style={{ width: '100%', marginTop: 8 }}
              title="Wipes the browser session of EVERY selected account for a clean identity."
            >
              🧹 Reset Session · {this.resetLabel()} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(relogin)</span>
            </button>
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
                      <button className="btn btn-secondary btn-sm" onClick={() => this.rotateProxyInstance(id)} title="Rotate to a different proxy and relaunch this browser">🔄 Proxy</button>
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

export default connect(s => ({ profiles: s.profiles, rg: s.riotgames, proxies: s.proxies }))(RiotGames);
