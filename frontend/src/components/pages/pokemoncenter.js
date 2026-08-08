import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

// Mirrors P-Bandai's STATUS_META, scoped to what the monitor script actually reports right now
// (queue wait → queue passed → holding for a SKU). Add-to-cart/checkout states aren't wired yet.
const STATUS_META = {
  starting: { label: 'Starting…',     color: '#9aa0aa' },
  queue:    { label: 'In queue',      color: '#f5a623' },
  ready:    { label: 'Queue passed',  color: '#34d399' },
  error:    { label: 'Error',         color: '#ff5a5a' },
  stopped:  { label: 'Stopped',       color: '#9aa0aa' },
};

class PokemonCenter extends Component {
  logBox = createRef();

  componentDidMount() { this.scrollToBottom(); }

  getSnapshotBeforeUpdate(prev) {
    if (prev.pokemon.logs.length !== this.props.pokemon.logs.length && this.logBox.current) {
      const el = this.logBox.current;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    return null;
  }
  componentDidUpdate(prev, prevState, wasAtBottom) { if (wasAtBottom) this.scrollToBottom(); }

  scrollToBottom = () => { const el = this.logBox.current; if (el) el.scrollTop = el.scrollHeight; };

  set = (k, v) => this.props.dispatch({ type: 'pokemonSet', obj: { [k]: v } });

  start = () => {
    const { pokemon } = this.props;
    if (pokemon.instance) return;
    this.props.dispatch({ type: 'pokemonLaunch' });
    ipcRenderer.send('startPokemonCenter', {
      instanceId: 'default',
      proxyListName: pokemon.proxyListName,
      accountId: pokemon.accountId,
      queueUrl: pokemon.queueUrl || 'https://www.pokemoncenter.com/',
    });
  };

  stop = () => {
    ipcRenderer.sendSync('stopPokemonCenter', 'default');
    this.props.dispatch({ type: 'pokemonDone' });
  };

  setSku = () => {
    const sku = (this.props.pokemon.sku || '').trim();
    if (!sku) return;
    ipcRenderer.send('setPokemonSku', { instanceId: 'default', sku });
  };

  clearLogs = () => this.props.dispatch({ type: 'pokemonSet', obj: { logs: [] } });
  copyLogs = () => { navigator.clipboard.writeText(this.props.pokemon.logs.join('\n')).catch(() => {}); };

  render() {
    const { pokemon, accounts, proxies } = this.props;
    const { proxyListName, accountId, queueUrl, sku, instance, logs } = pokemon;
    const proxyLists = (proxies && proxies.lists) || [];
    const pcAccounts = (accounts || []).filter(a => (a.site || 'bandai') === 'pokemoncenter');
    const running = !!instance;
    const meta = instance ? (STATUS_META[instance.state] || STATUS_META.starting) : null;
    const queuePassed = instance && (instance.state === 'ready' || (instance.detail || '').includes('passed'));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Pokémon Center</div>
          <div className="page-actions">
            {running && (
              <button className="btn btn-secondary btn-sm" onClick={this.stop}>
                <i className="ion-md-square" style={{ fontSize: 11 }} /> Stop
              </button>
            )}
          </div>
        </div>

        <div className="page-content">
          <div className="settings-section">
            <div className="form-group">
              <label className="form-label">Queue / start URL</label>
              <input
                className="form-input"
                value={queueUrl}
                onChange={e => this.set('queueUrl', e.target.value)}
                placeholder="https://www.pokemoncenter.com/"
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Proxy</label>
                <select className="form-select" value={proxyListName} onChange={e => this.set('proxyListName', e.target.value)} disabled={running}>
                  <option value="">None (home IP)</option>
                  {proxyLists.map(l => (
                    <option key={proxyRef(l)} value={proxyRef(l)}>My Proxies: {proxyLabel(l)}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Account</label>
                <select className="form-select" value={accountId} onChange={e => this.set('accountId', e.target.value)} disabled={running}>
                  <option value="">None (manual login)</option>
                  {pcAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.email}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Opens one visible browser, joins the queue, and waits. Add-to-cart/checkout aren't
              wired up yet — once the queue passes, use the SKU field below.
            </div>
            <button
              className="btn btn-primary"
              onClick={this.start}
              disabled={running}
              style={{ width: '100%', marginTop: 12 }}
            >
              🚀 {running ? 'Already running' : 'Start Queue Monitor'}
            </button>
          </div>

          {running && (
            <div className="settings-section">
              <div className="settings-section-title">Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flexShrink: 0, boxShadow: `0 0 6px ${meta.color}` }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>{meta.label}</span>
                {instance.detail ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>· {instance.detail}</span> : null}
              </div>
              <div className="form-row" style={{ alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">SKU</label>
                  <input
                    className="form-input"
                    value={sku}
                    onChange={e => this.set('sku', e.target.value)}
                    placeholder="e.g. 851-XXXXX"
                    disabled={!queuePassed}
                  />
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={this.setSku}
                  disabled={!queuePassed || !sku.trim()}
                  style={{ marginBottom: 2 }}
                  title={queuePassed ? 'Send this SKU to the running browser' : 'Wait for the queue to pass first'}
                >
                  Set SKU
                </button>
              </div>
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

export default connect(s => ({ pokemon: s.pokemon, accounts: s.accounts, proxies: s.proxies }))(PokemonCenter);
