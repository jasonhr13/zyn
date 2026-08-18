import React, { Component } from 'react';
import { connect } from 'react-redux';
import TargetAccountGenerator from './target-account-generator';
import { ACCOUNTS_WORKSPACE_KEY, readWorkspaceSelection, writeWorkspaceSelection } from '../workspace-selection';

const { ipcRenderer } = window.require('electron');

const ALL_ACCOUNTS = '__all_accounts__';
const UNGROUPED_ACCOUNTS = '__ungrouped_accounts__';
const isTargetAccount = account => String((account && account.site) || '').trim().toLowerCase() === 'target';

function accountGroups(account) {
  const groups = [
    ...(Array.isArray(account && account.groups) ? account.groups : []),
    account && account.group,
  ].map(value => String(value || '').trim()).filter(Boolean);
  return [...new Set(groups)];
}

function uniqueGroups(groups) {
  const seen = new Set();
  return (Array.isArray(groups) ? groups : []).map(value => String(value || '').trim()).filter(group => {
    const key = group.toLowerCase();
    if (!group || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.localeCompare(right));
}

function inAccountGroup(account, group) {
  const key = String(group || '').toLowerCase();
  return accountGroups(account).some(value => value.toLowerCase() === key);
}

// Accounts hold the site login used for auto-login. Passwords remain encrypted and are never sent
// to this renderer; group operations work only with opaque account IDs supplied by the main process.
class Accounts extends Component {
  state = (() => {
    const saved = readWorkspaceSelection(ACCOUNTS_WORKSPACE_KEY);
    return {
      raw: '',
      adding: false,
      note: '',
      editingId: '',
      editEmail: '',
      editPassword: '',
      editError: '',
      groups: [],
      activeGroup: saved.activeGroup || ALL_ACCOUNTS,
      selected: saved.selected,
      query: saved.query,
      creatingGroup: false,
      newGroupName: '',
      renamingGroup: false,
      renameGroupName: '',
      generating: false,
    };
  })();

  componentDidMount() {
    this.refreshGroups();
  }

  componentDidUpdate(previousProps, previousState) {
    if (previousProps.accounts !== this.props.accounts) {
      const ids = new Set(this.targetAccounts().map(account => String(account.id)));
      const selected = this.state.selected.filter(id => ids.has(String(id)));
      if (selected.length !== this.state.selected.length) {
        this.setState({ selected });
        return;
      }
    }
    if (previousState.activeGroup === this.state.activeGroup
        && previousState.query === this.state.query
        && previousState.selected === this.state.selected) return;
    writeWorkspaceSelection(ACCOUNTS_WORKSPACE_KEY, this.state);
  }

  targetAccounts = () => (this.props.accounts || []).filter(isTargetAccount);
  isCustomGroup = (group = this.state.activeGroup) => Boolean(group
    && group !== ALL_ACCOUNTS && group !== UNGROUPED_ACCOUNTS);

  refresh = () => {
    const accounts = ipcRenderer.sendSync('getAccounts') || [];
    this.props.dispatch({ type: 'update', obj: { accounts } });
    return accounts;
  };

  refreshGroups = (preferred = '') => {
    let groups = [];
    try { groups = ipcRenderer.sendSync('getAccountGroups') || []; } catch {}
    if (!groups.length) groups = this.targetAccounts().flatMap(accountGroups);
    groups = uniqueGroups(groups);
    this.setState(previous => {
      let activeGroup = preferred || previous.activeGroup || ALL_ACCOUNTS;
      const system = activeGroup === ALL_ACCOUNTS || activeGroup === UNGROUPED_ACCOUNTS;
      if (!system && !groups.includes(activeGroup)) activeGroup = ALL_ACCOUNTS;
      return { groups, activeGroup };
    });
  };

  selectGroup = activeGroup => this.setState({
    activeGroup, selected: [], query: '', renamingGroup: false, renameGroupName: '', note: '',
  });

  createGroup = () => {
    const name = this.state.newGroupName.trim();
    if (!name) return;
    const result = ipcRenderer.sendSync('createAccountGroup', name) || {};
    if (!result.ok) { this.setState({ note: result.error || 'Could not create account group.' }); return; }
    this.setState({ creatingGroup: false, newGroupName: '', note: `Created “${result.group}”.` },
      () => this.refreshGroups(result.group));
  };

  startRenameGroup = () => {
    if (!this.isCustomGroup()) return;
    this.setState({ renamingGroup: true, renameGroupName: this.state.activeGroup, note: '' });
  };

  renameGroup = () => {
    if (!this.isCustomGroup()) return;
    const to = this.state.renameGroupName.trim();
    if (!to) return;
    const result = ipcRenderer.sendSync('renameAccountGroup', { from: this.state.activeGroup, to }) || {};
    if (!result.ok) { this.setState({ note: result.error || 'Could not rename account group.' }); return; }
    const accounts = this.refresh();
    this.setState({ renamingGroup: false, renameGroupName: '', note: `Renamed group to “${result.group}”.` },
      () => { this.refreshGroups(result.group); return accounts; });
  };

  deleteGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group)) return;
    if (!window.confirm(`Delete account group “${group}”? Accounts will stay saved and move to Ungrouped if they have no other group.`)) return;
    const result = ipcRenderer.sendSync('deleteAccountGroup', group) || {};
    if (!result.ok) { this.setState({ note: result.error || 'Could not delete account group.' }); return; }
    this.refresh();
    this.setState({ selected: [], note: `Deleted “${group}”. Account credentials were not changed.` },
      () => this.refreshGroups(ALL_ACCOUNTS));
  };

  add = () => {
    const { raw } = this.state;
    if (!raw.trim()) return;
    const result = ipcRenderer.sendSync('addAccountsBulk', { raw, site: 'target' }) || {};
    let accounts = this.refresh();
    if (this.isCustomGroup()) {
      const emails = new Set(raw.split('\n').map(line => String(line || '').trim().split(':')[0].trim().toLowerCase()).filter(Boolean));
      const ids = accounts.filter(account => isTargetAccount(account)
        && emails.has(String(account.email || '').trim().toLowerCase())).map(account => account.id);
      if (ids.length) ipcRenderer.sendSync('addAccountsToGroup', { ids, group: this.state.activeGroup });
      accounts = this.refresh();
    }
    const bits = [];
    if (result.added) bits.push(`${result.added} added`);
    if (result.updated) bits.push(`${result.updated} updated`);
    if (result.skipped) bits.push(`${result.skipped} skipped (bad format)`);
    this.setState({ raw: '', adding: false, note: bits.join(' · ') || 'Nothing to add' }, () => this.refreshGroups());
    return accounts;
  };

  remove = (id) => {
    ipcRenderer.sendSync('deleteAccount', id);
    this.refresh();
    this.setState(state => ({ selected: state.selected.filter(value => value !== id), note: 'Account deleted.' }),
      () => this.refreshGroups());
  };

  deleteSelected = () => {
    const ids = this.state.selected;
    if (!ids.length || !window.confirm(`Delete ${ids.length} selected Target account${ids.length === 1 ? '' : 's'}? Tasks using them will need another account.`)) return;
    ids.forEach(id => ipcRenderer.sendSync('deleteAccount', id));
    this.refresh();
    this.setState({ selected: [], note: `Deleted ${ids.length} account${ids.length === 1 ? '' : 's'}.` },
      () => this.refreshGroups());
  };

  openEdit = account => this.setState({
    editingId: account.id,
    editEmail: account.email || '',
    // Blank means keep the saved password; credentials never return to the renderer.
    editPassword: '',
    editError: '',
    note: '',
  });

  closeEdit = () => this.setState({ editingId: '', editEmail: '', editPassword: '', editError: '' });

  saveEdit = () => {
    const { editingId, editPassword } = this.state;
    const email = String(this.state.editEmail || '').trim();
    const accounts = this.targetAccounts();
    const current = accounts.find(account => account.id === editingId);
    if (!current || !email || !email.includes('@')) {
      this.setState({ editError: 'Enter a valid email address.' });
      return;
    }
    if (accounts.some(account => account.id !== editingId
      && String(account.email || '').trim().toLowerCase() === email.toLowerCase())) {
      this.setState({ editError: 'That Target account already exists.' });
      return;
    }

    const emailChanged = String(current.email || '').trim().toLowerCase() !== email.toLowerCase();
    const passwordChanged = editPassword.length > 0;
    const data = { email };
    if (passwordChanged) data.password = editPassword;
    if (emailChanged) {
      const matchingProfile = (this.props.profiles || [])
        .filter(profile => profile && profile.profileType !== 'pokemoncenter')
        .find(profile => String(profile.email || '').trim().toLowerCase() === email.toLowerCase());
      data.profileId = matchingProfile ? matchingProfile.id : null;
    }
    if (emailChanged || passwordChanged) data.cookie = '';

    ipcRenderer.sendSync('updateAccount', { id: editingId, data });
    this.refresh();
    this.setState({
      editingId: '', editEmail: '', editPassword: '', editError: '', note: 'Account updated.',
    });
  };

  copyAll = () => {
    const accounts = this.targetAccounts();
    if (!accounts.length) return;
    navigator.clipboard.writeText(accounts.map(account => account.email).join('\n'))
      .then(() => this.setState({ note: `Copied ${accounts.length} email${accounts.length === 1 ? '' : 's'}.` }))
      .catch(error => this.setState({ note: `Copy failed: ${error.message}` }));
  };

  toggleSelected = id => this.setState(state => ({
    selected: state.selected.includes(id)
      ? state.selected.filter(value => value !== id) : [...state.selected, id],
  }));

  selectShown = shown => this.setState(state => {
    const ids = shown.map(account => account.id);
    const allSelected = ids.length > 0 && ids.every(id => state.selected.includes(id));
    return { selected: allSelected
      ? state.selected.filter(id => !ids.includes(id))
      : [...new Set([...state.selected, ...ids])] };
  });

  addSelectedToGroup = event => {
    const group = event.target.value;
    event.target.value = '';
    if (!group || !this.state.selected.length) return;
    const result = ipcRenderer.sendSync('addAccountsToGroup', { ids: this.state.selected, group }) || {};
    if (!result.ok) { this.setState({ note: result.error || 'Could not update account groups.' }); return; }
    this.refresh();
    this.setState({ selected: [], note: `Added selected accounts to “${group}”.` }, () => this.refreshGroups());
  };

  removeSelectedFromGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group) || !this.state.selected.length) return;
    const result = ipcRenderer.sendSync('removeAccountsFromGroup', { ids: this.state.selected, group }) || {};
    if (!result.ok) { this.setState({ note: result.error || 'Could not update account groups.' }); return; }
    this.refresh();
    this.setState({ selected: [], note: `Removed selected accounts from “${group}”.` }, () => this.refreshGroups(group));
  };

  countLines = raw => (raw ? raw.split('\n').filter(line => line.trim()).length : 0);

  formatWhen = timestamp => {
    const date = new Date(timestamp);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  };

  matchedProfile = account => {
    const profiles = (this.props.profiles || []).filter(profile => profile && profile.profileType !== 'pokemoncenter');
    if (account.profileId) return profiles.find(profile => profile.id === account.profileId) || null;
    return profiles.find(profile => String(profile.email || '').toLowerCase() === String(account.email || '').toLowerCase()) || null;
  };

  renderGroupItem = (group, count, icon = 'folder') => {
    const active = this.state.activeGroup === group;
    const label = group === ALL_ACCOUNTS ? 'All Accounts'
      : group === UNGROUPED_ACCOUNTS ? 'Ungrouped' : group;
    return (
      <button type="button" key={group} className={`profile-group-item${active ? ' active' : ''}`} onClick={() => this.selectGroup(group)}>
        <i className={`ion-md-${icon}`} /><span>{label}</span><em>{count}</em>
      </button>
    );
  };

  renderAddModal() {
    if (!this.state.adding) return null;
    const count = this.countLines(this.state.raw);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.setState({ adding: false, raw: '' })}>
        <div className="modal account-add-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">Add Target Accounts</div><p>Paste one email and password per line. Saved credentials are encrypted immediately.</p></div>
            <button className="modal-close" onClick={() => this.setState({ adding: false, raw: '' })}>×</button>
          </div>
          <div className="modal-body account-add-modal-body">
            <div className="form-group">
              <label className="form-label">Site</label>
              <select className="form-select" value="target" disabled aria-label="Account site"><option value="target">Target</option></select>
            </div>
            <div className="form-group">
              <label className="form-label">Accounts</label>
              <textarea className="proxy-editor-textarea account-add-textarea" autoFocus spellCheck={false}
                placeholder={'email:password\nemail:password\n…'} value={this.state.raw}
                onChange={event => this.setState({ raw: event.target.value })} />
              <div className="form-hint">{count} line{count === 1 ? '' : 's'} · re-pasting an email updates its password without exposing the saved value.</div>
              {this.isCustomGroup() && <div className="form-hint text-success">Matching accounts will be added to “{this.state.activeGroup}”.</div>}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => this.setState({ adding: false, raw: '' })}>Cancel</button>
            <button className="btn btn-primary" disabled={!this.state.raw.trim()} onClick={this.add}>Add Accounts</button>
          </div>
        </div>
      </div>
    );
  }

  renderEditModal() {
    const { editingId, editEmail, editPassword, editError } = this.state;
    if (!editingId) return null;
    const valid = editEmail.trim().includes('@');
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeEdit()}>
        <div className="modal" style={{ maxWidth: 480 }} onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">Edit Target Account</div><p>Update the login without deleting tasks that use this account.</p></div>
            <button className="modal-close" onClick={this.closeEdit}>×</button>
          </div>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" autoFocus value={editEmail}
                onChange={event => this.setState({ editEmail: event.target.value, editError: '' })}
                onKeyDown={event => event.key === 'Enter' && valid && this.saveEdit()} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">New password</label>
              <input className="form-input" type="password" placeholder="Leave blank to keep the saved password"
                value={editPassword} onChange={event => this.setState({ editPassword: event.target.value, editError: '' })}
                onKeyDown={event => event.key === 'Enter' && valid && this.saveEdit()} />
              <div className="form-hint">Saved passwords remain encrypted and are never displayed.</div>
              {editError && <div className="form-hint text-danger">{editError}</div>}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={this.closeEdit}>Cancel</button>
            <button className="btn btn-primary" disabled={!valid} onClick={this.saveEdit}>Save Changes</button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const { groups, activeGroup, selected, query } = this.state;
    const accounts = this.targetAccounts();
    const scoped = activeGroup === ALL_ACCOUNTS
      ? accounts
      : activeGroup === UNGROUPED_ACCOUNTS
        ? accounts.filter(account => accountGroups(account).length === 0)
        : accounts.filter(account => inAccountGroup(account, activeGroup));
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.length ? scoped.filter(account => {
      const profile = this.matchedProfile(account);
      return terms.every(term => [
        account.email, account.hasPassword ? 'password encrypted' : 'manual login', account.source,
        profile && (profile.profileName || profile.email), ...accountGroups(account),
      ].join(' ').toLowerCase().includes(term));
    }) : scoped;
    const allShownSelected = shown.length > 0 && shown.every(account => selected.includes(account.id));
    const ungroupedCount = accounts.filter(account => accountGroups(account).length === 0).length;
    const activeLabel = activeGroup === ALL_ACCOUNTS ? 'All Accounts'
      : activeGroup === UNGROUPED_ACCOUNTS ? 'Ungrouped' : activeGroup;
    const description = this.isCustomGroup() ? `${scoped.length} Target account${scoped.length === 1 ? '' : 's'} in this group`
      : activeGroup === ALL_ACCOUNTS ? 'Every saved Target login' : 'Target accounts waiting to be organized';

    return (
      <div className="profiles-workspace accounts-workspace">
        <div className="page-header profiles-page-header">
          <div className="page-title"><span className="page-title-dot" /> Accounts <span className="profiles-total-count">— {accounts.length}</span></div>
        </div>

        {this.state.note && (
          <div className="profiles-notice"><span>{this.state.note}</span><button type="button" onClick={() => this.setState({ note: '' })}>Dismiss</button></div>
        )}

        <div className="profiles-shell accounts-shell">
          <aside className="profile-groups-sidebar">
            <div className="profile-groups-sidebar-head">
              <div><span>Account groups</span><small>{groups.length} custom group{groups.length === 1 ? '' : 's'}</small></div>
              <button type="button" title="Create account group" aria-label="Create account group"
                onClick={() => this.setState(previous => ({ creatingGroup: !previous.creatingGroup, newGroupName: '' }))}>
                <i className="ion-md-add" />
              </button>
            </div>

            {this.state.creatingGroup && (
              <div className="profile-group-create">
                <input className="form-input" autoFocus value={this.state.newGroupName} placeholder="Group name"
                  onChange={event => this.setState({ newGroupName: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') this.createGroup();
                    if (event.key === 'Escape') this.setState({ creatingGroup: false, newGroupName: '' });
                  }} />
                <button className="btn btn-primary btn-sm" disabled={!this.state.newGroupName.trim()} onClick={this.createGroup}>Create</button>
              </div>
            )}

            <nav className="profile-group-nav" aria-label="Account groups">
              {this.renderGroupItem(ALL_ACCOUNTS, accounts.length, 'people')}
              <div className="profile-group-nav-label">Groups</div>
              {groups.length ? groups.map(group => this.renderGroupItem(group, accounts.filter(account => inAccountGroup(account, group)).length)) : (
                <div className="profile-group-sidebar-empty"><i className="ion-md-folder-open" /><span>No groups yet</span><small>Create one to organize Target logins.</small></div>
              )}
              <div className="profile-group-nav-label profile-group-nav-label-secondary">Needs organization</div>
              {this.renderGroupItem(UNGROUPED_ACCOUNTS, ungroupedCount, 'person')}
            </nav>
          </aside>

          <main className="profiles-main">
            <div className="profiles-main-toolbar">
              <div className="profiles-context-copy">
                {this.state.renamingGroup ? (
                  <div className="profile-group-rename">
                    <input className="form-input" autoFocus value={this.state.renameGroupName}
                      onChange={event => this.setState({ renameGroupName: event.target.value })}
                      onKeyDown={event => {
                        if (event.key === 'Enter') this.renameGroup();
                        if (event.key === 'Escape') this.setState({ renamingGroup: false, renameGroupName: '' });
                      }} />
                    <button className="btn btn-primary btn-sm" onClick={this.renameGroup}>Save</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ renamingGroup: false, renameGroupName: '' })}>Cancel</button>
                  </div>
                ) : (
                  <><div className="profiles-context-title"><h2>{activeLabel}</h2><span>{scoped.length}</span></div><p>{description}</p></>
                )}
              </div>
              <div className="profiles-context-actions">
                {this.isCustomGroup() && !this.state.renamingGroup && (
                  <><button className="profile-context-icon" title="Rename group" onClick={this.startRenameGroup}><i className="ion-md-create" /></button>
                    <button className="profile-context-icon danger" title="Delete group" onClick={this.deleteGroup}><i className="ion-md-trash" /></button></>
                )}
                <div className="profile-search-field"><i className="ion-md-search" /><input className="form-input" value={query}
                  placeholder={`Search ${activeLabel.toLowerCase()}…`} onChange={event => this.setState({ query: event.target.value })} /></div>
                <button className="btn btn-secondary btn-sm" disabled={!accounts.length} title="Copy every Target email" onClick={this.copyAll}>
                  <i className="ion-md-copy" /> Copy All
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ generating: true, note: '' })}>
                  <i className="ion-md-flash" /> Generate
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => this.setState({ adding: true, note: '' })}>
                  <i className="ion-md-add" /> Add Accounts
                </button>
              </div>
            </div>

            {!!selected.length && (
              <div className="profile-bulk-toolbar">
                <strong>{selected.length} selected</strong>
                <select className="form-select" defaultValue="" onChange={this.addSelectedToGroup}>
                  <option value="" disabled>Add to group…</option>
                  {groups.map(group => <option key={group} value={group}>{group}</option>)}
                </select>
                {this.isCustomGroup() && <button className="btn btn-secondary btn-sm" onClick={this.removeSelectedFromGroup}>Remove from {activeGroup}</button>}
                <button className="btn btn-danger btn-sm" onClick={this.deleteSelected}><i className="ion-md-trash" /> Delete</button>
                <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selected: [] })}>Clear</button>
              </div>
            )}

            <div className="profile-table-wrap account-table-wrap">
              <div className="profile-table-head account-list-table-head">
                <label className="profile-row-check" title={allShownSelected ? 'Deselect shown accounts' : 'Select shown accounts'}>
                  <input type="checkbox" checked={allShownSelected} disabled={!shown.length} onChange={() => this.selectShown(shown)} />
                </label>
                <span>Account</span><span>Password</span><span>Profile</span><span>Added</span><span>Actions</span>
              </div>
              <div className="profile-table-body account-list-table-body">
                {shown.length ? shown.map(account => {
                  const profile = this.matchedProfile(account);
                  const automatic = !account.profileId && profile;
                  const isSelected = selected.includes(account.id);
                  const memberships = accountGroups(account);
                  return (
                    <div className={`profile-row account-list-row${isSelected ? ' selected' : ''}`} key={account.id}
                      onClick={() => this.toggleSelected(account.id)}>
                      <label className="profile-row-check" onClick={event => event.stopPropagation()}>
                        <input type="checkbox" checked={isSelected} onChange={() => this.toggleSelected(account.id)} />
                      </label>
                      <div className="profile-row-cell account-row-identity"><strong>{account.email}</strong><small>{memberships.length ? memberships.join(' · ') : 'Target · ungrouped'}</small></div>
                      <div className={`profile-row-cell account-row-password${account.hasPassword ? ' configured' : ''}`}>
                        <strong><i className={account.hasPassword ? 'ion-md-lock' : 'ion-md-warning'} /> {account.hasPassword ? 'Encrypted' : 'Manual login'}</strong>
                        <small>{account.hasPassword ? 'Password saved' : 'No saved password'}</small>
                      </div>
                      <div className={`profile-row-cell account-row-profile${profile ? ' configured' : ''}`}>
                        <strong>{profile ? profile.profileName || profile.email : 'No matching profile'}</strong>
                        <small>{profile ? `${automatic ? 'Matched' : 'Linked'} by ${automatic ? 'email' : 'account'}` : 'Checkout profile required'}</small>
                      </div>
                      <div className="profile-row-cell account-row-created">
                        <strong>{account.source === 'generated' ? 'Generated' : 'Added'}</strong>
                        <small title={account.createdAt ? new Date(account.createdAt).toLocaleString() : ''}>{account.createdAt ? this.formatWhen(account.createdAt) : 'Date unavailable'}</small>
                      </div>
                      <div className="profile-row-actions">
                        <button className="profile-row-action" title="Edit account" onClick={event => { event.stopPropagation(); this.openEdit(account); }}><i className="ion-md-create" /></button>
                        <button className="profile-row-action danger" title="Delete account" onClick={event => { event.stopPropagation(); this.remove(account.id); }}><i className="ion-md-trash" /></button>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="profile-table-empty"><span><i className={terms.length ? 'ion-md-search' : 'ion-md-person'} /></span>
                    <h3>{terms.length ? 'No matching accounts' : this.isCustomGroup() ? `${activeGroup} is empty` : 'No Target accounts here'}</h3>
                    <p>{terms.length ? 'Try a different email, profile, or group.' : this.isCustomGroup()
                      ? 'Add accounts here or select saved accounts and assign them to this group.'
                      : 'Paste email:password accounts to add Target logins.'}</p>
                    {!terms.length && <div className="account-empty-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => this.setState({ generating: true })}><i className="ion-md-flash" /> Generate Accounts</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ adding: true })}><i className="ion-md-add" /> Add Existing</button>
                    </div>}
                  </div>
                )}
              </div>
            </div>
          </main>
        </div>

        {this.renderAddModal()}
        {this.renderEditModal()}
        {this.state.generating && <TargetAccountGenerator
          accountGroup={this.isCustomGroup() ? activeGroup : ''}
          onClose={() => this.setState({ generating: false })}
          onAccountsChanged={() => { this.refresh(); this.refreshGroups(activeGroup); }}
        />}
      </div>
    );
  }
}

export default connect(state => ({ accounts: state.accounts, profiles: state.profiles }))(Accounts);
