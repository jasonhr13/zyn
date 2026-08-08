import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import { proxyCount, proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

const STATUS_META = {
  starting: { label: 'Starting…', color: '#9aa0aa' },
  'get-session': { label: 'Getting Session', color: '#38bdf8' },
  'solve-px': { label: 'Solving PerimeterX', color: '#f5a623' },
  'logging-in': { label: 'Logging In', color: '#38bdf8' },
  carted: { label: 'Carted', color: '#34d399' },
  'submit-order': { label: 'Submitting Order', color: '#f5a623' },
  'checked-out': { label: 'Checked Out', color: '#34d399' },
  declined: { label: 'Payment Declined', color: '#ff5a5a' },
  error: { label: 'Error', color: '#ff5a5a' },
  stopped: { label: 'Stopped', color: '#9aa0aa' },
};

class Walmart extends Component {
  logBox = createRef();

  componentDidMount() {
    this.scrollToBottom();
  }

  getSnapshotBeforeUpdate(prev) {
    if (prev.walmart && prev.walmart.logs && this.props.walmart && this.props.walmart.logs &&
        prev.walmart.logs.length !== this.props.walmart.logs.length && this.logBox.current) {
      const el = this.logBox.current;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    return null;
  }

  componentDidUpdate(prev, prevState, wasAtBottom) {
    if (wasAtBottom) this.scrollToBottom();
  }

  scrollToBottom = () => {
    const el = this.logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  set = (k, v) => this.props.dispatch({ type: 'walmartSet', obj: { [k]: v } });

  start = () => {
    const { walmart } = this.props;
    if (walmart.instance) return;

    const config = {
      instanceId: 'default',
      proxyListName: walmart.proxyListName,
      accountId: walmart.accountId,
      profileId: walmart.profileId,
      input: (walmart.input || '').trim(),
      quantity: walmart.quantity || '1',
      maxPrice: (walmart.maxPrice || '').trim(),
      endless: walmart.endless,
    };

    if (!config.proxyListName) {
      alert('Please select a proxy group');
      return;
    }
    if (!config.accountId) {
      alert('Please select an account');
      return;
    }
    if (!config.profileId) {
      alert('Please select a profile');
      return;
    }
    if (!config.input) {
      alert('Please enter a Walmart product URL, PID, or offer ID');
      return;
    }

    this.props.dispatch({ type: 'walmartLaunch' });
    ipcRenderer.send('startWalmart', config);
  };

  stop = () => {
    ipcRenderer.sendSync('stopWalmart', 'default');
    this.props.dispatch({ type: 'walmartDone' });
  };

  clearLogs = () => this.props.dispatch({ type: 'walmartSet', obj: { logs: [] } });
  copyLogs = () => {
    const { walmart } = this.props;
    navigator.clipboard.writeText((walmart && walmart.logs && walmart.logs.join('\n')) || '').catch(() => {});
  };

  render() {
    const { walmart = {}, accounts = [], proxies = {}, profiles = {} } = this.props;
    const { proxyListName, accountId, profileId, input, quantity, maxPrice, endless, instance, logs = [] } = walmart;

    const proxyLists = (proxies && proxies.lists) || [];
    // Only accounts explicitly tagged for Walmart (matches the Accounts page's Walmart site tab).
    const walmartAccounts = (accounts || []).filter(a => a.site === 'walmart');
    // s.profiles is a plain array (same as the Profiles page consumes), not an object with .list.
    const profileList = Array.isArray(profiles) ? profiles : [];

    const running = !!instance;
    // The engine reports free-form status strings with their own color, so fall back to whatever
    // it sent rather than a fixed STATUS_META code.
    const meta = instance
      ? (STATUS_META[instance.state] || { label: instance.label || instance.state || 'Running', color: instance.color || '#6DACFF' })
      : null;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Walmart</div>
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
            <div className="settings-section-title">Configuration</div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Proxy Group</label>
                <select
                  className="form-select"
                  value={proxyListName}
                  onChange={e => this.set('proxyListName', e.target.value)}
                  disabled={running}
                >
                  <option value="">None (home IP)</option>
                  {proxyLists.map(l => (
                    <option key={proxyRef(l)} value={proxyRef(l)}>
                      {proxyLabel(l)} ({proxyCount(l)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Account</label>
                <select
                  className="form-select"
                  value={accountId}
                  onChange={e => this.set('accountId', e.target.value)}
                  disabled={running}
                >
                  <option value="">Select account...</option>
                  {walmartAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Profile</label>
                <select
                  className="form-select"
                  value={profileId}
                  onChange={e => this.set('profileId', e.target.value)}
                  disabled={running}
                >
                  <option value="">Select profile...</option>
                  {profileList.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.profileName || p.email || p.id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Product (URL / PID / Offer ID)</label>
                <input
                  className="form-input"
                  value={input}
                  onChange={e => this.set('input', e.target.value)}
                  placeholder="e.g. https://www.walmart.com/ip/1234567890"
                  disabled={running}
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 0.5 }}>
                <label className="form-label">Quantity</label>
                <input
                  className="form-input"
                  value={quantity}
                  onChange={e => this.set('quantity', e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="1"
                  disabled={running}
                />
              </div>

              <div className="form-group" style={{ flex: 0.5 }}>
                <label className="form-label">Max Price (optional)</label>
                <input
                  className="form-input"
                  value={maxPrice}
                  onChange={e => this.set('maxPrice', e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="no limit"
                  disabled={running}
                />
              </div>

              <div className="form-group" style={{ flex: 0.5 }}>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={endless}
                    onChange={e => this.set('endless', e.target.checked)}
                    disabled={running}
                  />
                  <span>Endless</span>
                </label>
              </div>
            </div>

            <button
              className="btn btn-primary"
              onClick={this.start}
              disabled={running}
              style={{ width: '100%', marginTop: 12 }}
            >
              🛒 {running ? 'Running...' : 'Start Checkout'}
            </button>
          </div>

          {running && (
            <div className="settings-section">
              <div className="settings-section-title">Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: meta.color,
                    flexShrink: 0,
                    boxShadow: `0 0 6px ${meta.color}`,
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>{meta.label}</span>
                {instance.detail ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>· {instance.detail}</span> : null}
              </div>
            </div>
          )}

          <div className="settings-section" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span className="settings-section-title" style={{ margin: 0, padding: 0, border: 'none' }}>
                Live Log
              </span>
              {logs.length > 0 && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={this.copyLogs}>
                    Copy
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={this.clearLogs}>
                    Clear
                  </button>
                </div>
              )}
            </div>
            <div
              ref={this.logBox}
              style={{
                overflowY: 'auto',
                background: 'var(--field)',
                border: '1px solid var(--field-border)',
                borderRadius: 8,
                padding: 10,
                flex: 1,
                minHeight: 150,
              }}
            >
              {logs.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>No output yet.</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="log-line">
                    {l}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({
  walmart: s.walmart,
  accounts: s.accounts,
  proxies: s.proxies,
  profiles: s.profiles,
}))(Walmart);
