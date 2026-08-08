import React, { Component } from 'react';
const { ipcRenderer } = window.require('electron');

// Ported from the Hope repository's replacement license gate. Main owns the bearer/reset tokens
// and every checkout spawn is enforced there; this component only handles credentials and status.
class LicenseGate extends Component {
  state = {
    mode: 'login',
    email: '',
    password: '',
    newPassword: '',
    confirmPassword: '',
    acknowledged: false,
    busy: false,
    err: '',
  };

  signIn = async (event) => {
    if (event) event.preventDefault();
    const email = this.state.email.trim();
    const password = this.state.password;
    if (!email || !password || !this.state.acknowledged || this.state.busy) return;
    this.setState({ busy: true, err: '' });
    try {
      const status = await ipcRenderer.invoke('loginLicense', { email, password });
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
    const { newPassword, confirmPassword, busy } = this.state;
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
      const status = await ipcRenderer.invoke('resetLicensePassword', { newPassword });
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
    const { mode, email, password, newPassword, confirmPassword, acknowledged, busy, err } = this.state;
    const priorReason = this.props.status?.reason;
    const displayError = err || (priorReason && priorReason !== 'Sign in to continue.' ? priorReason : '');
    const inputStyle = { width: '100%' };

    return (
      <div className="license-gate-r4">
        <form onSubmit={mode === 'login' ? this.signIn : this.resetPassword} className="license-gate-card">
          <div className="license-gate-mark"><i className={mode === 'login' ? 'ion-md-lock' : 'ion-md-key'} /></div>
          <div className="license-gate-badge">CONTROL PLANE R7</div>
          <div className="license-gate-title">{mode === 'login' ? 'Sign in to rCart' : 'Choose a new password'}</div>
          <div className="license-gate-copy">
            {mode === 'login'
              ? 'Use the credentials provided with your rCart account.'
              : `This is the first sign-in for ${email}. Replace the temporary password to continue.`}
          </div>

          {mode === 'login' ? (
            <>
              <input className="form-input" style={inputStyle} type="email" autoComplete="username"
                placeholder="Email" value={email} onChange={event => this.setState({ email: event.target.value })}
                disabled={busy} autoFocus />
              <input className="form-input" style={inputStyle} type="password" autoComplete="current-password"
                placeholder="Password" value={password} onChange={event => this.setState({ password: event.target.value })}
                disabled={busy} />
              <label className="license-gate-acknowledge">
                <input type="checkbox" checked={acknowledged}
                  onChange={event => this.setState({ acknowledged: event.target.checked })} disabled={busy} />
                <span>I understand that signing in replaces this account&apos;s active device session.</span>
              </label>
            </>
          ) : (
            <>
              <input className="form-input" style={inputStyle} type="password" autoComplete="new-password"
                placeholder="New password (10+ characters)" value={newPassword}
                onChange={event => this.setState({ newPassword: event.target.value })} disabled={busy} autoFocus />
              <input className="form-input" style={inputStyle} type="password" autoComplete="new-password"
                placeholder="Confirm new password" value={confirmPassword}
                onChange={event => this.setState({ confirmPassword: event.target.value })} disabled={busy} />
            </>
          )}

          {displayError && <div className="license-gate-error">{displayError}</div>}
          <button type="submit" className="btn btn-primary"
            disabled={busy || (mode === 'login' ? !email.trim() || !password || !acknowledged : !newPassword || !confirmPassword)}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Save password & continue'}
          </button>
          {mode === 'reset' && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={this.backToLogin} disabled={busy}>Back to sign in</button>
          )}
          <div className="license-gate-footnote">
            rCart validates every five minutes. A revoked or disabled session stops running tasks and returns here.
          </div>
        </form>
      </div>
    );
  }
}

export default LicenseGate;
