import React, { Component } from 'react';
import { connect } from 'react-redux';
import CreateModal from './profiles-components/create-modal';
import EditModal from './profiles-components/edit-modal';
import { PROFILES_WORKSPACE_KEY, readWorkspaceSelection, writeWorkspaceSelection } from '../workspace-selection';

const { ipcRenderer } = window.require('electron');

const ALL_PROFILES = '__all_profiles__';
const UNGROUPED_PROFILES = '__ungrouped_profiles__';

function maskCard(num) {
  if (!num) return '—';
  const n = num.replace(/\s/g, '');
  return `•••• ${n.slice(-4)}`;
}

function profileGroups(profile) {
  const groups = [
    ...(Array.isArray(profile && profile.groups) ? profile.groups : []),
    profile && profile.group,
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

function inProfileGroup(profile, group) {
  const key = String(group || '').toLowerCase();
  return profileGroups(profile).some(value => value.toLowerCase() === key);
}

function activeTaskProfileIds(tasks, statuses) {
  return (Array.isArray(tasks) ? tasks : []).filter(task => {
    const status = statuses && statuses[task.id];
    return status && status.running === true;
  }).map(task => String(task.profileId || '')).filter(Boolean);
}

// Flatten a stored profile into the flat shape the Create/Edit modal expects.
function flatten(profile) {
  const knownImapHosts = new Set(['imap.gmail.com', 'outlook.office365.com', 'imap.mail.yahoo.com', 'imap.mail.me.com']);
  const imapHost = profile.imap?.host || '';
  const shipping = profile.shipping || {};
  const billing = profile.billing || shipping;
  const fields = ['firstName', 'lastName', 'address', 'address2', 'city', 'state', 'zipcode', 'country'];
  const billingSameShipping = typeof profile.billingSameShipping === 'boolean'
    ? profile.billingSameShipping
    : fields.every(field => String(billing[field] || '') === String(shipping[field] || ''));
  return {
    profileType: profile.profileType || 'target',
    profileName: profile.profileName || '',
    email: profile.email || '',
    phone: profile.phone || '',
    imapProvider: imapHost ? (knownImapHosts.has(imapHost) ? imapHost : 'custom') : '',
    imapHostCustom: imapHost && !knownImapHosts.has(imapHost) ? imapHost : '',
    imapUser: profile.imap?.user || '',
    imapPass: profile.imap?.password || '',
    firstName: shipping.firstName || profile.firstName || '',
    lastName: shipping.lastName || profile.lastName || '',
    address: shipping.address || profile.address || '',
    address2: shipping.address2 || profile.address2 || '',
    city: shipping.city || profile.city || '',
    state: shipping.state || profile.state || '',
    zipcode: shipping.zipcode || profile.zipcode || '',
    country: shipping.country || profile.country || 'US',
    billingSameShipping,
    billingFirstName: billing.firstName || '',
    billingLastName: billing.lastName || '',
    billingAddress: billing.address || '',
    billingAddress2: billing.address2 || '',
    billingCity: billing.city || '',
    billingState: billing.state || '',
    billingZipcode: billing.zipcode || billing.zip || '',
    billingCountry: billing.country || 'US',
    cardName: profile.payment?.cardName || profile.cardName || '',
    cardNumber: profile.payment?.cardNumber || profile.cardNumber || '',
    cardMonth: profile.payment?.cardMonth || profile.cardMonth || '',
    cardYear: profile.payment?.cardYear || profile.cardYear || '',
    cardCvv: profile.payment?.cardCvv || profile.cardCvv || '',
  };
}

class Profiles extends Component {
  state = (() => {
    const saved = readWorkspaceSelection(PROFILES_WORKSPACE_KEY);
    return {
      showCreate: false,
      editProfile: null,
      duplicateInitial: null,
      selected: saved.selected,
      msg: '',
      query: saved.query,
      groups: [],
      activeGroup: saved.activeGroup,
      creatingGroup: false,
      newGroupName: '',
      renamingGroup: false,
      renameGroupName: '',
    };
  })();

  componentDidMount() {
    this.refreshGroups();
  }

  componentDidUpdate(previousProps, previousState) {
    const ids = new Set((this.props.profiles || []).map(profile => String(profile && profile.id || '')));
    const selected = this.state.selected.filter(id => ids.has(String(id)));
    if (selected.length !== this.state.selected.length) {
      this.setState({ selected });
      return;
    }
    if (previousState.activeGroup === this.state.activeGroup
        && previousState.query === this.state.query
        && previousState.selected === this.state.selected) return;
    writeWorkspaceSelection(PROFILES_WORKSPACE_KEY, this.state);
  }

  refreshGroups = (preferred = '') => {
    let groups = [];
    try { groups = ipcRenderer.sendSync('getGroups') || []; } catch {}
    if (!groups.length) groups = this.props.profiles.flatMap(profileGroups);
    groups = uniqueGroups(groups);
    this.setState(previous => {
      let activeGroup = preferred || previous.activeGroup;
      const systemView = activeGroup === ALL_PROFILES || activeGroup === UNGROUPED_PROFILES;
      if (!activeGroup || (!systemView && !groups.includes(activeGroup))) {
        activeGroup = groups[0] || UNGROUPED_PROFILES;
      }
      return { groups, activeGroup };
    });
  };

  refreshProfiles = () => {
    let profiles = this.props.profiles;
    try { profiles = ipcRenderer.sendSync('getProfiles') || []; } catch {}
    this.props.dispatch({ type: 'update', obj: { profiles } });
    return profiles;
  };

  importAycd = async () => {
    const result = await ipcRenderer.invoke('importAycdProfiles');
    if (result.canceled) return;
    if (!result.ok) { this.setState({ msg: `Import failed: ${result.error}` }); return; }
    const bits = [`Imported ${result.added} profile(s)`];
    if (result.skipped) bits.push(`${result.skipped} already existed (matched by name)`);
    this.refreshProfiles();
    this.setState({ msg: bits.join(' — '), selected: [] }, this.refreshGroups);
  };

  exportAycd = async () => {
    const ids = this.state.selected || [];
    if (!window.confirm(
      `Export ${ids.length ? `${ids.length} selected profile(s)` : 'ALL profiles'} in AYCD format?\n\n`
      + 'The file holds full card numbers, CVVs and addresses in plain text — that is what makes it '
      + 'importable elsewhere. Keep it somewhere safe and do not share it.')) return;
    const result = await ipcRenderer.invoke('exportAycdProfiles', ids);
    if (result.canceled) return;
    if (!result.ok) { this.setState({ msg: `Export failed: ${result.error}` }); return; }
    const warning = result.multiGroup
      ? ` — ${result.multiGroup} profile(s) are in several groups; AYCD keeps only the first`
      : '';
    this.setState({ msg: `Exported ${result.count} profile(s) to ${result.filePath}${warning}` });
  };

  isCustomGroup = (group = this.state.activeGroup) => Boolean(group
    && group !== ALL_PROFILES && group !== UNGROUPED_PROFILES);

  openCreate = () => {
    if (!this.isCustomGroup()) {
      this.setState({ msg: 'Choose or create a profile group first. New profiles are created inside the selected group.' });
      return;
    }
    this.setState({ showCreate: true, editProfile: null, duplicateInitial: null });
  };

  openEdit = profile => this.setState({ editProfile: profile, showCreate: false, duplicateInitial: null });

  openDuplicate = profile => {
    if (!this.isCustomGroup()) {
      this.setState({ msg: 'Choose a destination group before duplicating this profile.' });
      return;
    }
    this.setState({
      duplicateInitial: { ...flatten(profile), profileName: `${profile.profileName || 'Profile'} copy` },
      showCreate: false,
      editProfile: null,
    });
  };

  closeAll = () => this.setState({ showCreate: false, editProfile: null, duplicateInitial: null });

  handleCreate = data => {
    const group = this.state.activeGroup;
    const payload = { ...data, groups: this.isCustomGroup(group) ? [group] : [] };
    const profile = ipcRenderer.sendSync('createProfile', payload);
    this.props.dispatch({ type: 'update', obj: { profiles: [...this.props.profiles, profile] } });
    this.closeAll();
    this.refreshGroups(group);
  };

  createForAccounts = base => {
    const accounts = this.props.accounts || [];
    if (!accounts.length) { window.alert('No accounts yet — add them on the Accounts page first.'); return; }
    const existing = new Set(this.props.profiles
      .filter(profile => profile && profile.profileType !== 'pokemoncenter')
      .map(profile => (profile.email || '').trim().toLowerCase()).filter(Boolean));
    const toCreate = [];
    for (const account of accounts) {
      const email = (account.email || '').trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      toCreate.push({ ...base, email, profileName: email.split('@')[0] });
    }
    if (!toCreate.length) { window.alert('Every account already has a profile — nothing new to create.'); return; }
    if (!window.confirm(`Create ${toCreate.length} new profile(s) from "${base.profileName || 'this profile'}" — one per account, using its email (card + address copied)? Accounts that already have a profile are skipped.`)) return;
    const created = ipcRenderer.sendSync('createProfilesBulk', toCreate) || [];
    this.props.dispatch({ type: 'update', obj: { profiles: [...this.props.profiles, ...created] } });
    window.alert(`Created ${created.length} profile(s).`);
  };

  handleEdit = (id, data) => {
    ipcRenderer.sendSync('updateProfile', { id, data });
    const profiles = this.props.profiles.map(profile => profile.id === id ? { ...profile, ...data } : profile);
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.closeAll();
  };

  handleDelete = id => {
    ipcRenderer.sendSync('deleteProfile', id);
    const profiles = this.props.profiles.filter(profile => profile.id !== id);
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.setState(previous => ({ selected: previous.selected.filter(selectedId => selectedId !== id) }));
  };

  handleDeleteSelected = () => {
    this.state.selected.forEach(id => ipcRenderer.sendSync('deleteProfile', id));
    const profiles = this.props.profiles.filter(profile => !this.state.selected.includes(profile.id));
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.setState({ selected: [] });
  };

  toggleSelect = id => {
    this.setState(previous => ({
      selected: previous.selected.includes(id)
        ? previous.selected.filter(value => value !== id)
        : [...previous.selected, id],
    }));
  };

  selectShown = profiles => {
    const ids = profiles.map(profile => profile.id);
    this.setState(previous => {
      const allSelected = ids.length > 0 && ids.every(id => previous.selected.includes(id));
      return {
        selected: allSelected
          ? previous.selected.filter(id => !ids.includes(id))
          : [...new Set([...previous.selected, ...ids])],
      };
    });
  };

  clearSelect = () => this.setState({ selected: [] });

  selectGroup = activeGroup => this.setState({
    activeGroup,
    selected: [],
    query: '',
    renamingGroup: false,
    renameGroupName: '',
  });

  createGroup = () => {
    const requested = this.state.newGroupName.trim();
    if (!requested) return;
    let result = null;
    try { result = ipcRenderer.sendSync('createProfileGroup', requested); } catch {}
    if (result && result.ok === false) {
      this.setState({ msg: `Could not create group: ${result.error || 'unknown error'}` });
      return;
    }
    const group = String((result && result.group) || requested).trim();
    this.setState(previous => ({
      groups: uniqueGroups([...previous.groups, group]),
      activeGroup: group,
      creatingGroup: false,
      newGroupName: '',
      selected: [],
      query: '',
      msg: `Created “${group}”. New profiles will be added here.`,
    }));
  };

  startRenameGroup = () => this.setState({
    renamingGroup: true,
    renameGroupName: this.state.activeGroup,
  });

  renameGroup = () => {
    const from = this.state.activeGroup;
    const to = this.state.renameGroupName.trim();
    if (!this.isCustomGroup(from) || !to) return;
    let result = null;
    try { result = ipcRenderer.sendSync('renameProfileGroup', { from, to }); } catch {}
    if (result && result.ok === false) {
      this.setState({ msg: `Could not rename group: ${result.error || 'unknown error'}` });
      return;
    }
    const group = String((result && result.group) || to).trim();
    if (!result) {
      const ids = this.props.profiles.filter(profile => inProfileGroup(profile, from)).map(profile => profile.id);
      if (ids.length) {
        ipcRenderer.sendSync('addProfilesToGroup', { ids, group });
        ipcRenderer.sendSync('removeProfilesFromGroup', { ids, group: from });
      }
    }
    this.refreshProfiles();
    this.setState(previous => ({
      groups: uniqueGroups([...previous.groups.filter(value => value !== from), group]),
      activeGroup: group,
      renamingGroup: false,
      renameGroupName: '',
      msg: `Renamed “${from}” to “${group}”.`,
    }));
  };

  deleteGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group)) return;
    const count = this.props.profiles.filter(profile => inProfileGroup(profile, group)).length;
    if (!window.confirm(`Delete the group “${group}”? ${count} profile${count === 1 ? '' : 's'} will be kept and moved to Ungrouped unless they belong to another group.`)) return;
    let result = null;
    try { result = ipcRenderer.sendSync('deleteProfileGroup', group); } catch {}
    if (result && result.ok === false) {
      this.setState({ msg: `Could not delete group: ${result.error || 'unknown error'}` });
      return;
    }
    if (!result) {
      const ids = this.props.profiles.filter(profile => inProfileGroup(profile, group)).map(profile => profile.id);
      if (ids.length) ipcRenderer.sendSync('removeProfilesFromGroup', { ids, group });
    }
    this.refreshProfiles();
    this.setState(previous => ({
      groups: previous.groups.filter(value => value !== group),
      activeGroup: UNGROUPED_PROFILES,
      selected: [],
      msg: `Deleted “${group}”. Profiles were kept.`,
    }));
  };

  addSelectedToGroup = event => {
    const group = event.target.value;
    event.target.value = '';
    if (!group || !this.state.selected.length) return;
    ipcRenderer.sendSync('addProfilesToGroup', { ids: this.state.selected, group });
    this.refreshProfiles();
    this.setState({ selected: [], msg: `Added selected profiles to “${group}”.` }, () => this.refreshGroups(group));
  };

  removeSelectedFromGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group) || !this.state.selected.length) return;
    ipcRenderer.sendSync('removeProfilesFromGroup', { ids: this.state.selected, group });
    this.refreshProfiles();
    this.setState({ selected: [], msg: `Removed selected profiles from “${group}”.` });
  };

  renderGroupItem = (group, count, icon = 'folder') => {
    const active = this.state.activeGroup === group;
    return (
      <button
        type="button"
        key={group}
        className={`profile-group-item${active ? ' active' : ''}`}
        onClick={() => this.selectGroup(group)}
      >
        <i className={`ion-md-${icon}`} />
        <span>{group === ALL_PROFILES ? 'All Profiles' : group === UNGROUPED_PROFILES ? 'Ungrouped' : group}</span>
        <em>{count}</em>
      </button>
    );
  };

  render() {
    const { profiles, targetTasks, targetTaskStatus, pokemonTaskStatus } = this.props;
    const {
      showCreate, editProfile, duplicateInitial, selected, query, groups, activeGroup,
    } = this.state;
    const usedProfileIds = new Set([
      ...activeTaskProfileIds(targetTasks, targetTaskStatus),
      ...activeTaskProfileIds(this.props.pokemonTasks, pokemonTaskStatus),
    ]);

    const scopedProfiles = activeGroup === ALL_PROFILES
      ? profiles
      : activeGroup === UNGROUPED_PROFILES || !activeGroup
        ? profiles.filter(profile => profileGroups(profile).length === 0)
        : profiles.filter(profile => inProfileGroup(profile, activeGroup));
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shownProfiles = !terms.length ? scopedProfiles : scopedProfiles.filter(profile => {
      const shipping = profile.shipping || {};
      const haystack = [
        profile.profileName, profile.email, profile.phone,
        shipping.firstName || profile.firstName, shipping.lastName || profile.lastName,
        shipping.address || profile.address, shipping.city, shipping.state, shipping.zipcode,
        profile.profileType || 'target', ...profileGroups(profile),
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
    const allShownSelected = shownProfiles.length > 0
      && shownProfiles.every(profile => selected.includes(profile.id));
    const ungroupedCount = profiles.filter(profile => profileGroups(profile).length === 0).length;
    const activeLabel = activeGroup === ALL_PROFILES
      ? 'All Profiles'
      : activeGroup === UNGROUPED_PROFILES || !activeGroup ? 'Ungrouped' : activeGroup;
    const activeDescription = this.isCustomGroup()
      ? `${scopedProfiles.length} profile${scopedProfiles.length === 1 ? '' : 's'} in this group`
      : activeGroup === ALL_PROFILES
        ? 'Every profile across all groups'
        : 'Profiles waiting to be assigned to a group';

    return (
      <div className="profiles-workspace">
        <div className="page-header profiles-page-header">
          <div className="page-title">
            <span className="page-title-dot" />
            Profiles
            <span className="profiles-total-count">— {profiles.length}</span>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={this.importAycd} title="Import profiles in AYCD format">
              <i className="ion-md-open" /> Import
            </button>
            <button className="btn btn-secondary btn-sm" onClick={this.exportAycd}
              title="Export in AYCD format — exports the selection, or everything if nothing is selected">
              <i className="ion-md-download" /> Export
            </button>
          </div>
        </div>

        {this.state.msg && (
          <div className="profiles-notice">
            <span>{this.state.msg}</span>
            <button type="button" onClick={() => this.setState({ msg: '' })}>Dismiss</button>
          </div>
        )}

        <div className="profiles-shell">
          <aside className="profile-groups-sidebar">
            <div className="profile-groups-sidebar-head">
              <div>
                <span>Profile groups</span>
                <small>{groups.length} group{groups.length === 1 ? '' : 's'}</small>
              </div>
              <button type="button" title="Create profile group" aria-label="Create profile group"
                onClick={() => this.setState(previous => ({ creatingGroup: !previous.creatingGroup, newGroupName: '' }))}>
                <i className="ion-md-add" />
              </button>
            </div>

            {this.state.creatingGroup && (
              <div className="profile-group-create">
                <input
                  className="form-input"
                  autoFocus
                  value={this.state.newGroupName}
                  placeholder="Group name"
                  onChange={event => this.setState({ newGroupName: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') this.createGroup();
                    if (event.key === 'Escape') this.setState({ creatingGroup: false, newGroupName: '' });
                  }}
                />
                <button className="btn btn-primary btn-sm" type="button" disabled={!this.state.newGroupName.trim()} onClick={this.createGroup}>Create</button>
              </div>
            )}

            <nav className="profile-group-nav" aria-label="Profile groups">
              {this.renderGroupItem(ALL_PROFILES, profiles.length, 'albums')}
              <div className="profile-group-nav-label">Groups</div>
              {groups.length ? groups.map(group => this.renderGroupItem(
                group,
                profiles.filter(profile => inProfileGroup(profile, group)).length,
              )) : (
                <div className="profile-group-sidebar-empty">
                  <i className="ion-md-folder-open" />
                  <span>No groups yet</span>
                  <small>Create one, then add profiles inside it.</small>
                </div>
              )}
              <div className="profile-group-nav-label profile-group-nav-label-secondary">Needs organization</div>
              {this.renderGroupItem(UNGROUPED_PROFILES, ungroupedCount, 'file')}
            </nav>
          </aside>

          <main className="profiles-main">
            <div className="profiles-main-toolbar">
              <div className="profiles-context-copy">
                {this.state.renamingGroup ? (
                  <div className="profile-group-rename">
                    <input
                      className="form-input"
                      autoFocus
                      value={this.state.renameGroupName}
                      onChange={event => this.setState({ renameGroupName: event.target.value })}
                      onKeyDown={event => {
                        if (event.key === 'Enter') this.renameGroup();
                        if (event.key === 'Escape') this.setState({ renamingGroup: false, renameGroupName: '' });
                      }}
                    />
                    <button className="btn btn-primary btn-sm" type="button" onClick={this.renameGroup}>Save</button>
                    <button className="btn btn-secondary btn-sm" type="button"
                      onClick={() => this.setState({ renamingGroup: false, renameGroupName: '' })}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <div className="profiles-context-title">
                      <h2>{activeLabel}</h2>
                      <span>{scopedProfiles.length}</span>
                    </div>
                    <p>{activeDescription}</p>
                  </>
                )}
              </div>
              <div className="profiles-context-actions">
                {this.isCustomGroup() && !this.state.renamingGroup && (
                  <>
                    <button className="profile-context-icon" type="button" title="Rename group" onClick={this.startRenameGroup}>
                      <i className="ion-md-create" />
                    </button>
                    <button className="profile-context-icon danger" type="button" title="Delete group" onClick={this.deleteGroup}>
                      <i className="ion-md-trash" />
                    </button>
                  </>
                )}
                <div className="profile-search-field">
                  <i className="ion-md-search" />
                  <input
                    className="form-input"
                    value={query}
                    placeholder={`Search ${activeLabel.toLowerCase()}…`}
                    onChange={event => this.setState({ query: event.target.value })}
                  />
                </div>
                <button className="btn btn-primary btn-sm" onClick={this.openCreate} disabled={!this.isCustomGroup()}
                  title={this.isCustomGroup() ? `Create a profile in ${activeGroup}` : 'Select or create a group first'}>
                  <i className="ion-md-add" /> New Profile
                </button>
              </div>
            </div>

            {selected.length > 0 && (
              <div className="profile-bulk-toolbar">
                <strong>{selected.length} selected</strong>
                <select className="form-select" defaultValue="" onChange={this.addSelectedToGroup}>
                  <option value="" disabled>Add to group…</option>
                  {groups.map(group => <option value={group} key={group}>{group}</option>)}
                </select>
                {this.isCustomGroup() && (
                  <button className="btn btn-secondary btn-sm" onClick={this.removeSelectedFromGroup}>Remove from {activeGroup}</button>
                )}
                <button className="btn btn-danger btn-sm" onClick={this.handleDeleteSelected}>
                  <i className="ion-md-trash" /> Delete
                </button>
                <button className="btn btn-secondary btn-sm" onClick={this.clearSelect}>Clear</button>
              </div>
            )}

            <div className="profile-table-wrap">
              <div className="profile-table-head" role="row">
                <label className="profile-row-check" title={allShownSelected ? 'Deselect shown profiles' : 'Select shown profiles'}>
                  <input type="checkbox" checked={allShownSelected} onChange={() => this.selectShown(shownProfiles)} />
                </label>
                <span>Profile</span>
                <span>Contact</span>
                <span>Shipping</span>
                <span>Payment</span>
                <span>Mailbox</span>
                <span aria-label="Actions" />
              </div>

              <div className="profile-table-body">
                {shownProfiles.length === 0 ? (
                  <div className="profile-table-empty">
                    <span><i className={terms.length ? 'ion-md-search' : 'ion-md-person'} /></span>
                    <h3>{terms.length ? 'No matching profiles' : this.isCustomGroup() ? `${activeGroup} is empty` : 'No profiles here'}</h3>
                    <p>{terms.length
                      ? 'Try a different name, email, city, or group.'
                      : this.isCustomGroup()
                        ? 'Create the first profile in this group, or select ungrouped profiles and add them here.'
                        : groups.length
                          ? 'Choose a group from the sidebar to create profiles inside it.'
                          : 'Create your first group from the sidebar, then add profiles inside it.'}</p>
                    {!terms.length && this.isCustomGroup() && (
                      <button className="btn btn-primary btn-sm" onClick={this.openCreate}><i className="ion-md-add" /> New Profile</button>
                    )}
                    {!terms.length && !groups.length && (
                      <button className="btn btn-primary btn-sm" onClick={() => this.setState({ creatingGroup: true })}><i className="ion-md-add" /> New Group</button>
                    )}
                  </div>
                ) : shownProfiles.map(profile => {
                  const shipping = profile.shipping || {};
                  const name = shipping.firstName || profile.firstName || '';
                  const last = shipping.lastName || profile.lastName || '';
                  const address = shipping.address || profile.address || '';
                  const city = shipping.city || profile.city || '';
                  const state = shipping.state || profile.state || '';
                  const zipcode = shipping.zipcode || profile.zipcode || '';
                  const cardNumber = profile.payment?.cardNumber || profile.cardNumber || '';
                  const isSelected = selected.includes(profile.id);
                  const pokemonCenter = profile.profileType === 'pokemoncenter';
                  return (
                    <div
                      className={`profile-row${isSelected ? ' selected' : ''}`}
                      key={profile.id}
                      role="row"
                      onClick={() => this.toggleSelect(profile.id)}
                    >
                      <label className="profile-row-check" onClick={event => event.stopPropagation()}>
                        <input type="checkbox" checked={isSelected} onChange={() => this.toggleSelect(profile.id)} />
                      </label>
                      <div className="profile-row-cell profile-row-identity">
                        <div>
                          <strong>{profile.profileName || `${name} ${last}` || '(unnamed)'}</strong>
                          <span className={`profile-site-badge${pokemonCenter ? ' pokemon' : ''}`}>
                            {pokemonCenter ? 'POKÉMON CENTER' : 'TARGET'}
                          </span>
                          {usedProfileIds.has(String(profile.id)) && <span className="profile-use-badge">IN USE</span>}
                        </div>
                      </div>
                      <div className="profile-row-cell">
                        <strong>{profile.email || 'No email'}</strong>
                        <small>{profile.phone || 'No phone'}</small>
                      </div>
                      <div className="profile-row-cell profile-row-shipping">
                        <strong>{address || 'No address'}</strong>
                        <small>{[city, state, zipcode].filter(Boolean).join(', ') || 'Shipping not configured'}</small>
                      </div>
                      <div className="profile-row-cell profile-row-payment">
                        <strong>{maskCard(cardNumber)}</strong>
                        <small>{profile.payment?.cardName || `${name} ${last}`.trim() || 'Cardholder'}</small>
                      </div>
                      <div className={`profile-row-cell profile-row-mailbox${!pokemonCenter && profile.imap?.user ? ' configured' : ''}`}>
                        <strong><i className={pokemonCenter ? 'ion-md-cart' : 'ion-md-mail'} /> {pokemonCenter ? 'Guest checkout' : profile.imap?.user ? 'OTP ready' : 'Not configured'}</strong>
                        <small>{pokemonCenter ? 'No mailbox needed' : profile.imap?.user || 'Add an OTP mailbox'}</small>
                      </div>
                      <div className="profile-row-actions">
                        <button className="profile-row-action" title="Edit profile"
                          onClick={event => { event.stopPropagation(); this.openEdit(profile); }}>
                          <i className="ion-md-create" />
                        </button>
                        <button className="profile-row-action" title="Duplicate into the selected group"
                          onClick={event => { event.stopPropagation(); this.openDuplicate(profile); }}>
                          <i className="ion-md-copy" />
                        </button>
                        {!pokemonCenter && (
                          <button className="profile-row-action success" title="Create one profile per account email"
                            onClick={event => { event.stopPropagation(); this.createForAccounts(profile); }}>
                            <i className="ion-md-people" />
                          </button>
                        )}
                        <button className="profile-row-action danger" title="Delete profile"
                          onClick={event => { event.stopPropagation(); this.handleDelete(profile.id); }}>
                          <i className="ion-md-trash" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </main>
        </div>

        {showCreate && !editProfile && (
          <CreateModal mailboxProfiles={profiles} onSave={this.handleCreate} onClose={this.closeAll} />
        )}
        {editProfile && (
          <EditModal profile={editProfile} mailboxProfiles={profiles} onSave={this.handleEdit} onClose={this.closeAll} />
        )}
        {duplicateInitial && (
          <CreateModal
            initial={duplicateInitial}
            title="Duplicate Profile"
            mailboxProfiles={profiles}
            onSave={this.handleCreate}
            onClose={this.closeAll}
          />
        )}
      </div>
    );
  }
}

export default connect(state => ({
  profiles: state.profiles,
  accounts: state.accounts,
  targetTasks: (state.target && state.target.tasks) || [],
  targetTaskStatus: (state.target && state.target.taskStatus) || {},
  pokemonTasks: (state.pokemon && state.pokemon.tasks) || [],
  pokemonTaskStatus: (state.pokemon && state.pokemon.taskStatus) || {},
}))(Profiles);
