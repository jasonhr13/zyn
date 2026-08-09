import React, { Component } from 'react';
import { connect } from 'react-redux';
const { ipcRenderer } = window.require('electron');

const isTargetAccount = account => String((account && account.site) || '').trim().toLowerCase() === 'target';

// Accounts hold the site login (email + password) used for auto-login. Passwords are
// encrypted at rest by the main process and are NEVER sent here — each account only
// carries a `hasPassword` flag. An account checks out using the profile it's linked to,
// auto-matched on email — shown as a read-only label per row (no per-row assignment UI: with
// hundreds of accounts, rendering a populated <select> per row was the actual cause of the list
// lagging, reported live 2026-07-20 at 600 accounts).
class Accounts extends Component {
  state = { raw: '', adding: false, note: '' };

  refresh = () => {
    const accounts = ipcRenderer.sendSync('getAccounts');
    this.props.dispatch({ type: 'update', obj: { accounts } });
  };

  add = () => {
    const { raw } = this.state;
    if (!raw.trim()) return;
    const r = ipcRenderer.sendSync('addAccountsBulk', { raw, site: 'target' });
    this.refresh();
    const bits = [];
    if (r.added) bits.push(`${r.added} added`);
    if (r.updated) bits.push(`${r.updated} updated`);
    if (r.skipped) bits.push(`${r.skipped} skipped (bad format)`);
    this.setState({ raw: '', adding: false, note: bits.join(' · ') || 'nothing to add' });
  };

  remove = (id) => {
    ipcRenderer.sendSync('deleteAccount', id);
    this.refresh();
  };

  // Copies Target emails only. Real passwords are encrypted at rest and never sent to this renderer.
  copyAll = () => {
    const accounts = (this.props.accounts || []).filter(isTargetAccount);
    if (!accounts.length) return;
    navigator.clipboard.writeText(accounts.map(a => a.email).join('\n'))
      .then(() => this.setState({ note: `Copied ${accounts.length} email${accounts.length !== 1 ? 's' : ''}` }))
      .catch(e => this.setState({ note: `⚠ Copy failed: ${e.message}` }));
  };

  countLines = (raw) => (raw ? raw.split('\n').filter(l => l.trim()).length : 0);

  // "7/18/2026 1:36 AM" — no seconds, matches how the user described wanting it shown.
  formatWhen = (ts) => {
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };

  // Mirrors the main process: explicit link wins, else match on email.
  matchedProfile = (acct) => {
    const profiles = (this.props.profiles || [])
      .filter(profile => profile && profile.profileType !== 'pokemoncenter');
    if (acct.profileId) return profiles.find(p => p.id === acct.profileId) || null;
    return profiles.find(p => (p.email || '').toLowerCase() === (acct.email || '').toLowerCase()) || null;
  };

  render() {
    const { raw, adding, note } = this.state;
    const accounts = (this.props.accounts || []).filter(isTargetAccount);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title">
            <span className="page-title-dot" />
            Accounts
            {accounts.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>
                — {accounts.length} account{accounts.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="page-actions">
            {note && <span style={{ fontSize: 11, color: '#4ade80' }}>{note}</span>}
            <button
              className="btn btn-secondary btn-sm"
              disabled={accounts.length === 0}
              title="Copy all Target emails"
              onClick={this.copyAll}
            >
              <i className="ion-md-copy" style={{ fontSize: 13 }} /> Copy All
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => this.setState({ adding: !adding, note: '' })}>
              <i className="ion-md-add" style={{ fontSize: 13 }} /> Add Accounts
            </button>
          </div>
        </div>

        <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {adding && (
            <div className="table-wrap" style={{ marginBottom: 12, padding: 12 }}>
              <div className="form-group" style={{ maxWidth: 260 }}>
                <label className="form-label">Site</label>
                <select className="form-select" defaultValue="target" aria-label="Account site">
                  <option value="target">Target</option>
                </select>
              </div>
              <textarea
                className="proxy-editor-textarea"
                style={{ width: '100%', minHeight: 130 }}
                placeholder={'email:password\nemail:password\n...'}
                value={raw}
                onChange={e => this.setState({ raw: e.target.value })}
                spellCheck={false}
                autoFocus
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 10, color: '#4b5563', flex: 1 }}>
                  {this.countLines(raw)} line{this.countLines(raw) !== 1 ? 's' : ''} — one{' '}
                  <span className="monospace">email:password</span> per line. Re-pasting an email updates its
                  password. Passwords are encrypted on save and never shown again.
                </span>
                <button className="btn btn-primary btn-sm" onClick={this.add}>Add</button>
                <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ adding: false, raw: '' })}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="table-wrap" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {accounts.length === 0 ? (
              <div className="table-empty">
                <div className="table-empty-icon"><i className="ion-md-person" /></div>
                <div className="table-empty-text">No Target accounts yet</div>
                <div className="table-empty-sub">
                  Paste <span className="monospace">email:password</span> — each account auto-links to the
                  profile with the same email and logs in on its own.
                </div>
              </div>
            ) : (
              accounts.map(a => {
                const prof = this.matchedProfile(a);
                const auto = !a.profileId && prof;   // linked purely by email match
                return (
                  <div
                    key={a.id}
                    className="proxy-list-item"
                    style={{ cursor: 'default', display: 'flex', alignItems: 'center', gap: 10 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="proxy-list-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {a.email}
                      </div>
                      <div className="proxy-list-count">
                        {a.hasPassword
                          ? <span style={{ color: '#4ade80' }}>password saved (encrypted)</span>
                          : <span style={{ color: '#f87171' }}>no password — manual login</span>}
                        {prof ? ` · ${auto ? 'matched' : 'linked'} to ${prof.profileName || prof.email}` : ' · no profile'}
                      </div>
                      {a.createdAt && (
                        <div
                          title={new Date(a.createdAt).toLocaleString()}
                          style={{ fontSize: 10, marginTop: 2, color: a.source === 'generated' ? '#4ade80' : 'var(--muted)' }}
                        >
                          {a.source === 'generated' ? 'Genned' : 'Added'} at {this.formatWhen(a.createdAt)}
                        </div>
                      )}
                    </div>

                    <button
                      className="btn btn-sm btn-danger btn-icon"
                      title="Delete account"
                      onClick={() => this.remove(a.id)}
                    >
                      <i className="ion-md-trash" style={{ fontSize: 11 }} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({ accounts: s.accounts, profiles: s.profiles }))(Accounts);
