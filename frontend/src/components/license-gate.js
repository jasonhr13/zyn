import React, { Component } from 'react';
import Icon from './icon';
const { ipcRenderer } = window.require('electron');

function normalizeSessionKind(value) {
  return String(value || '').trim().toLowerCase() === 'harvester' ? 'harvester' : 'engine';
}

// Main owns the bearer/reset tokens and every checkout spawn is enforced there; this component
// only handles credentials and renderer-safe status.
class LicenseGate extends Component {
  state = {
    mode: 'login',
    sessionKind: 'engine',
    email: '',
    password: '',
    newPassword: '',
    confirmPassword: '',
    busy: false,
    err: '',
  };

  componentDidMount() {
    ipcRenderer.invoke('getPreferredSessionKind').then((kind) => {
      this.setState({ sessionKind: normalizeSessionKind(kind) });
    }).catch(() => {});
  }

  signIn = async (event) => {
    if (event) event.preventDefault();
    const email = this.state.email.trim();
    const password = this.state.password;
    const sessionKind = normalizeSessionKind(this.state.sessionKind);
    if (!email || !password || this.state.busy) return;
    this.setState({ busy: true, err: '' });
    try {
      const status = await ipcRenderer.invoke('loginLicense', { email, password, sessionKind });
      if (status.ok) {
        this.setState({ password: '' });
        this.props.onActivated(status);
        return;
      }
      if (status.requiresPasswordReset) {
        this.setState({
          mode: 'reset',
          email: status.email || email,
          password: '',
          busy: false,
          err: '',
        });
        return;
      }
      this.setState({ busy: false, password: '', err: status.reason || 'Unable to sign in.' });
    } catch {
      this.setState({ busy: false, password: '', err: 'Unable to sign in. Try again.' });
    }
  };

  resetPassword = async (event) => {
    if (event) event.preventDefault();
    const { newPassword, confirmPassword, busy, sessionKind } = this.state;
    if (busy) return;
    if (newPassword.length < 10) {
      this.setState({ err: 'Use a password of at least 10 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      this.setState({ err: 'The new passwords do not match.' });
      return;
    }
    this.setState({ busy: true, err: '' });
    try {
      const status = await ipcRenderer.invoke('resetLicensePassword', {
        newPassword,
        sessionKind: normalizeSessionKind(sessionKind),
      });
      if (status.ok) {
        this.setState({ newPassword: '', confirmPassword: '' });
        this.props.onActivated(status);
        return;
      }
      this.setState({ busy: false, newPassword: '', confirmPassword: '', err: status.reason || 'Unable to reset password.' });
    } catch {
      this.setState({ busy: false, err: 'Unable to reset password. Try signing in again.' });
    }
  };

  backToLogin = () => this.setState({
    mode: 'login',
    password: '',
    newPassword: '',
    confirmPassword: '',
    busy: false,
    err: '',
  });

  render() {
    const { mode, sessionKind, email, password, newPassword, confirmPassword, busy, err } = this.state;
    const priorReason = this.props.status?.reason;
    const displayError = err || (priorReason && priorReason !== 'Sign in to continue.' ? priorReason : '');
    const inputStyle = { width: '100%' };
    const harvest = sessionKind === 'harvester';

    return (
      <div className="license-gate-r4">
        <form onSubmit={mode === 'login' ? this.signIn : this.resetPassword} className="license-gate-card">
          <div className="license-gate-mark"><Icon name="key" size={24} /></div>
          <div className="license-gate-badge">ZYN<span className="aio-mark">AIO</span></div>
          <div className="license-gate-title">{mode === 'login' ? 'Sign in to ZynAIO' : 'Choose a new password'}</div>
          <div className="license-gate-copy">
            {mode === 'login'
              ? 'Use the credentials provided with your Zyn account. Choose how this machine will run.'
              : `This is the first sign-in for ${email}. Replace the temporary password to continue.`}
          </div>

          {mode === 'login' && (
            <div className="license-gate-modes" role="radiogroup" aria-label="Session mode">
              <button
                type="button"
                role="radio"
                aria-checked={!harvest}
                className={`license-gate-mode${!harvest ? ' selected' : ''}`}
                disabled={busy}
                onClick={() => this.setState({ sessionKind: 'engine' })}
              >
                <strong>Full Engine</strong>
                <span>Run checkout tasks. Uses your assigned active-device limit.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={harvest}
                className={`license-gate-mode${harvest ? ' selected' : ''}`}
                disabled={busy}
                onClick={() => this.setState({ sessionKind: 'harvester' })}
              >
                <strong>Harvester only</strong>
                <span>Farm Shape cookies for your Full Engine Zyn. Does not use a device seat.</span>
              </button>
            </div>
          )}

          {mode === 'login' ? (
            <>
              <input className="form-input" style={inputStyle} type="email" autoComplete="username"
                placeholder="Email" aria-label="Email" value={email} onChange={event => this.setState({ email: event.target.value })}
                disabled={busy} autoFocus />
              <input className="form-input" style={inputStyle} type="password" autoComplete="current-password"
                placeholder="Password" aria-label="Password" value={password} onChange={event => this.setState({ password: event.target.value })}
                disabled={busy} />
            </>
          ) : (
            <>
              <input className="form-input" style={inputStyle} type="password" autoComplete="new-password"
                placeholder="New password (10+ characters)" aria-label="New password" value={newPassword}
                onChange={event => this.setState({ newPassword: event.target.value })} disabled={busy} autoFocus />
              <input className="form-input" style={inputStyle} type="password" autoComplete="new-password"
                placeholder="Confirm new password" aria-label="Confirm new password" value={confirmPassword}
                onChange={event => this.setState({ confirmPassword: event.target.value })} disabled={busy} />
            </>
          )}

          {displayError && <div className="license-gate-error">{displayError}</div>}
          <button type="submit" className="btn btn-primary"
            disabled={busy || (mode === 'login' ? !email.trim() || !password : !newPassword || !confirmPassword)}>
            {busy ? 'Please wait…' : mode === 'login'
              ? (harvest ? 'Sign in as harvester' : 'Sign in')
              : 'Save password & continue'}
          </button>
          {mode === 'reset' && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={this.backToLogin} disabled={busy}>Back to sign in</button>
          )}
          <div className="license-gate-footnote">
            Your account has an assigned active-device limit for Full Engine sign-ins. When it is full, signing in as Full Engine on another device replaces the least recently active session. Harvester only does not use a device seat. Zyn identifies revocation or account disablement separately.
          </div>
        </form>
      </div>
    );
  }
}

export default LicenseGate;
