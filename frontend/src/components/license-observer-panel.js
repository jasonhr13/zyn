import React, { Component } from 'react';

const { ipcRenderer } = window.require('electron');

const IPC = {
  status: 'controlPlaneLicenseObservationStatus',
  login: 'controlPlaneLicenseObservationLogin',
  reset: 'controlPlaneLicenseObservationReset',
  refresh: 'controlPlaneLicenseObservationRefresh',
  logout: 'controlPlaneLicenseObservationLogout',
};

const EMPTY_STATUS = {
  mode: 'observe', enforcing: false, signedIn: false, valid: null, email: '',
  expiresAt: 0, checkedAt: 0, reason: 'Loading replacement license status…', storage: 'none',
  taskTypes: {}, proxyAccess: false, managedProxyCount: 0, requiresPasswordReset: false,
};

function dateTime(value) {
  const date = new Date(Number(value));
  return Number(value) > 0 && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not yet';
}

class LicenseObserverPanel extends Component {
  state = {
    status: EMPTY_STATUS,
    mode: 'login',
    email: '',
    password: '',
    newPassword: '',
    confirmPassword: '',
    acknowledged: false,
    busy: false,
    error: '',
  };

  componentDidMount() { this.loadStatus(); }

  applyStatus = (status) => {
    const next = status && typeof status === 'object' ? status : EMPTY_STATUS;
    this.setState(previous => ({
      status: next,
      email: next.email || previous.email,
      mode: next.requiresPasswordReset ? 'reset' : previous.mode,
      busy: false,
      error: '',
    }));
  };

  loadStatus = async () => {
    try {
      this.applyStatus(await ipcRenderer.invoke(IPC.status));
    } catch {
      this.setState({
        status: { ...EMPTY_STATUS, reason: 'Replacement license preview is unavailable in this build.' },
        busy: false,
      });
    }
  };

  signIn = async (event) => {
    event.preventDefault();
    const { email, password, acknowledged, busy } = this.state;
    if (busy || !email.trim() || !password || !acknowledged) return;
    this.setState({ busy: true, error: '' });
    try {
      const status = await ipcRenderer.invoke(IPC.login, { email: email.trim(), password });
      this.setState({ password: '' });
      this.applyStatus(status);
    } catch {
      this.setState({ busy: false, password: '', error: 'Unable to contact the replacement license service.' });
    }
  };

  resetPassword = async (event) => {
    event.preventDefault();
    const { newPassword, confirmPassword, busy } = this.state;
    if (busy) return;
    if (newPassword.length < 10) {
      this.setState({ error: 'Use a password of at least 10 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      this.setState({ error: 'The new passwords do not match.' });
      return;
    }
    this.setState({ busy: true, error: '' });
    try {
      const status = await ipcRenderer.invoke(IPC.reset, { newPassword });
      this.setState({ newPassword: '', confirmPassword: '' });
      this.applyStatus(status);
      if (!status.requiresPasswordReset) this.setState({ mode: 'login' });
    } catch {
      this.setState({ busy: false, newPassword: '', confirmPassword: '', error: 'Unable to reset the password.' });
    }
  };

  refresh = async () => {
    if (this.state.busy) return;
    this.setState({ busy: true, error: '' });
    try { this.applyStatus(await ipcRenderer.invoke(IPC.refresh)); }
    catch { this.setState({ busy: false, error: 'Unable to re-check the replacement license.' }); }
  };

  logout = async () => {
    if (this.state.busy) return;
    this.setState({ busy: true, error: '' });
    try {
      this.applyStatus(await ipcRenderer.invoke(IPC.logout));
      this.setState({ mode: 'login', password: '', newPassword: '', confirmPassword: '' });
    } catch { this.setState({ busy: false, error: 'Unable to sign out of the replacement license preview.' }); }
  };

  renderStatus() {
    const { status, busy } = this.state;
    const taskTypes = Object.entries(status.taskTypes || {});
    const validity = status.valid === true ? 'Validated' : status.valid === false ? 'Invalid' : status.signedIn ? 'Needs re-check' : 'Not signed in';
    const validityColor = status.valid === true ? 'var(--ok)' : status.valid === false ? 'var(--danger)' : 'var(--muted)';
    return (
      <div className="license-observer-status" data-license-state={status.valid === true ? 'valid' : status.valid === false ? 'invalid' : 'unknown'}>
        <div className="license-observer-status-row">
          <span className="license-observer-status-dot" style={{ background: validityColor }} />
          <div>
            <div style={{ color: 'var(--text)', fontSize: 12, fontWeight: 650 }}>{validity}</div>
            <div style={{ color: 'var(--muted)', fontSize: 10.5 }}>{status.email || 'No replacement account connected'}</div>
          </div>
          {status.signedIn && (
            <div className="license-observer-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={this.refresh} disabled={busy}>Re-check</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={this.logout} disabled={busy}>Sign out</button>
            </div>
          )}
        </div>
        <div className="license-observer-grid">
          <div><span>Last checked</span><strong>{dateTime(status.checkedAt)}</strong></div>
          <div><span>Expires</span><strong>{dateTime(status.expiresAt)}</strong></div>
          <div><span>Session storage</span><strong>{status.storage === 'encrypted' ? 'OS encrypted' : status.storage === 'memory' ? 'Memory only' : 'None'}</strong></div>
          <div><span>Managed proxies</span><strong>{status.proxyAccess ? `${status.managedProxyCount} available` : 'Not enabled'}</strong></div>
        </div>
        {taskTypes.length > 0 && (
          <div className="license-observer-entitlements">
            {taskTypes.map(([name, enabled]) => (
              <span key={name} className={enabled ? 'enabled' : ''}>{name}: {enabled ? 'enabled' : 'hidden'}</span>
            ))}
          </div>
        )}
        {status.reason && <div className="license-observer-reason">{status.reason}</div>}
      </div>
    );
  }

  renderLogin() {
    const { email, password, acknowledged, busy } = this.state;
    return (
      <form className="license-observer-form" onSubmit={this.signIn}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">rCart email</label>
            <input
              className="form-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={event => this.setState({ email: event.target.value, error: '' })}
              placeholder="account@example.com"
              disabled={busy}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={event => this.setState({ password: event.target.value, error: '' })}
              placeholder="Account password"
              disabled={busy}
            />
          </div>
        </div>
        <label className="license-observer-acknowledge">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={event => this.setState({ acknowledged: event.target.checked })}
            disabled={busy}
          />
          <span>I understand that signing in replaces this account&apos;s active device session on the live license service.</span>
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !email.trim() || !password || !acknowledged}>
          {busy ? 'Contacting service…' : 'Sign in for preview'}
        </button>
      </form>
    );
  }

  renderReset() {
    const { newPassword, confirmPassword, busy, status } = this.state;
    return (
      <form className="license-observer-form" onSubmit={this.resetPassword}>
        <div className="license-observer-reset-note">First sign-in for {status.email || 'this account'}: choose a permanent password.</div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">New password</label>
            <input className="form-input" type="password" autoComplete="new-password" value={newPassword}
              onChange={event => this.setState({ newPassword: event.target.value, error: '' })} disabled={busy} placeholder="10+ characters" />
          </div>
          <div className="form-group">
            <label className="form-label">Confirm password</label>
            <input className="form-input" type="password" autoComplete="new-password" value={confirmPassword}
              onChange={event => this.setState({ confirmPassword: event.target.value, error: '' })} disabled={busy} placeholder="Repeat new password" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !newPassword || !confirmPassword}>
            {busy ? 'Saving…' : 'Save password & connect'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => this.setState({ mode: 'login', newPassword: '', confirmPassword: '', error: '' })}>Back</button>
        </div>
      </form>
    );
  }

  render() {
    const { status, mode, error } = this.state;
    return (
      <div className="settings-section license-observer" data-control-plane-license="observe">
        <div className="license-observer-heading">
          <div>
            <div className="settings-section-title">Replacement License</div>
            <div className="license-observer-subtitle">Cloudflare integration from the Hope control plane</div>
          </div>
          <span className="license-observer-badge">R3 · OBSERVE ONLY</span>
        </div>
        <div className="license-observer-warning">
          Signing in contacts <strong>license.rcart.app</strong>, creates a device-bound session, and revokes this
          account&apos;s previous active session. In R3 this status is informational: it does not unlock or block the
          app, hide modules, affect task launches, or change the reporter identity.
        </div>
        {this.renderStatus()}
        {!status.signedIn && (mode === 'reset' ? this.renderReset() : this.renderLogin())}
        {error && <div className="license-observer-error">{error}</div>}
      </div>
    );
  }
}

export default LicenseObserverPanel;
