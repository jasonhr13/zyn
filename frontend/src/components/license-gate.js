import React, { Component } from 'react';
const { ipcRenderer } = window.require('electron');

// Shown instead of the app while the key is missing / deactivated / expired. This screen is only
// the friendly face of the gate — the real enforcement is in the main process, which refuses to
// spawn any bot without a valid key.
class LicenseGate extends Component {
  state = { key: '', busy: false, err: '' };

  activate = async () => {
    const key = this.state.key.trim();
    if (!key) return;
    this.setState({ busy: true, err: '' });
    const s = await ipcRenderer.invoke('activateLicense', key);
    if (s.ok) this.props.onActivated(s);
    else this.setState({ busy: false, err: s.reason || 'invalid key' });
  };

  render() {
    const { key, busy, err } = this.state;
    const status = this.props.status || {};
    // "no key entered" on first run isn't an error worth shouting about.
    const priorReason = status.reason && status.reason !== 'no key entered' && status.reason !== 'unchecked'
      ? status.reason : '';

    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 14, padding: 24,
      }}>
        <div className="table-empty-icon" style={{ fontSize: 34 }}><i className="ion-md-key" /></div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#d1d5db' }}>Enter your license key</div>
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center', maxWidth: 380 }}>
          This build is a private beta. Your key is checked against the license server on launch
          and periodically while running.
        </div>

        <div style={{ display: 'flex', gap: 8, width: 320 }}>
          <input
            className="form-input"
            style={{ flex: 1, textAlign: 'center', letterSpacing: 1 }}
            placeholder="LICENSE KEY"
            value={key}
            onChange={e => this.setState({ key: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') this.activate(); }}
            spellCheck={false}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={this.activate} disabled={busy || !key.trim()}>
            {busy ? 'Checking…' : 'Activate'}
          </button>
        </div>

        {(err || priorReason) && (
          <div style={{ fontSize: 11, color: '#f87171' }}>{err || priorReason}</div>
        )}
      </div>
    );
  }
}

export default LicenseGate;
