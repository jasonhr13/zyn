import React, { Component } from 'react';
import { connect } from 'react-redux';
import CreateModal from './profiles-components/create-modal';
import EditModal from './profiles-components/edit-modal';
import Groups from './profiles-components/groups';
const { ipcRenderer } = window.require('electron');

function maskCard(num) {
  if (!num) return '—';
  const n = num.replace(/\s/g, '');
  return '•••• ' + n.slice(-4);
}

// Flatten a stored profile into the flat shape the Create/Edit modal expects.
function flatten(p) {
  const knownImapHosts = new Set(['imap.gmail.com', 'outlook.office365.com', 'imap.mail.yahoo.com', 'imap.mail.me.com']);
  const imapHost = p.imap?.host || '';
  return {
    profileName: p.profileName || '',
    email: p.email || '',
    phone: p.phone || '',
    imapProvider: imapHost ? (knownImapHosts.has(imapHost) ? imapHost : 'custom') : '',
    imapHostCustom: imapHost && !knownImapHosts.has(imapHost) ? imapHost : '',
    imapUser: p.imap?.user || '',
    imapPass: p.imap?.password || '',
    firstName: p.shipping?.firstName || p.firstName || '',
    lastName: p.shipping?.lastName || p.lastName || '',
    address: p.shipping?.address || p.address || '',
    address2: p.shipping?.address2 || p.address2 || '',
    city: p.shipping?.city || p.city || '',
    state: p.shipping?.state || p.state || '',
    zipcode: p.shipping?.zipcode || p.zipcode || '',
    country: p.shipping?.country || p.country || 'US',
    cardName: p.payment?.cardName || p.cardName || '',
    cardNumber: p.payment?.cardNumber || p.cardNumber || '',
    cardMonth: p.payment?.cardMonth || p.cardMonth || '',
    cardYear: p.payment?.cardYear || p.cardYear || '',
    cardCvv: p.payment?.cardCvv || p.cardCvv || '',
  };
}

class Profiles extends Component {
  state = { showCreate: false, editProfile: null, duplicateInitial: null, selected: [], tab: 'profiles', msg: '', query: '' };

  // ── AYCD import / export ───────────────────────────────────────────────────
  // AYCD's format is the lingua franca between bots — their Profile Builder speaks it to 200+
  // programs — so this is how profiles get in from anywhere and out again.
  importAycd = async () => {
    const r = await ipcRenderer.invoke('importAycdProfiles');
    if (r.canceled) return;
    if (!r.ok) { this.setState({ msg: `Import failed: ${r.error}` }); return; }
    // Says what was skipped, not just what landed. "Imported 0" on a re-run looks broken unless it
    // also says the 200 were already here.
    const bits = [`Imported ${r.added} profile(s)`];
    if (r.skipped) bits.push(`${r.skipped} already existed (matched by name)`);
    // Same refresh the page uses after a delete: re-read from main, push into the store.
    const profiles = ipcRenderer.sendSync('getProfiles') || [];
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.setState({ msg: bits.join(' — '), selected: [] });
  };

  exportAycd = async () => {
    const ids = this.state.selected || [];
    if (!window.confirm(
      `Export ${ids.length ? `${ids.length} selected profile(s)` : 'ALL profiles'} in AYCD format?

`
      + 'The file holds full card numbers, CVVs and addresses in plain text — that is what makes it '
      + 'importable elsewhere. Keep it somewhere safe and do not share it.')) return;
    const r = await ipcRenderer.invoke('exportAycdProfiles', ids);
    if (r.canceled) return;
    if (!r.ok) { this.setState({ msg: `Export failed: ${r.error}` }); return; }
    // AYCD allows ONE group per profile; anything beyond the first is lost. Better said than silent.
    const warn = r.multiGroup
      ? ` — ${r.multiGroup} profile(s) are in several groups; AYCD keeps only the first`
      : '';
    this.setState({ msg: `Exported ${r.count} profile(s) to ${r.filePath}${warn}` });
  };

  openCreate = () => this.setState({ showCreate: true, editProfile: null, duplicateInitial: null });
  openEdit = (p) => this.setState({ editProfile: p, showCreate: false, duplicateInitial: null });
  // Duplicate = open the create modal pre-filled from an existing profile so you tweak fields
  // and save a brand-new one (my usual flow instead of typing a fresh profile from scratch).
  openDuplicate = (p) => this.setState({ duplicateInitial: { ...flatten(p), profileName: `${p.profileName || 'Profile'} copy` }, showCreate: false, editProfile: null });
  closeAll = () => this.setState({ showCreate: false, editProfile: null, duplicateInitial: null });

  handleCreate = (data) => {
    const profile = ipcRenderer.sendSync('createProfile', data);
    this.props.dispatch({ type: 'update', obj: { profiles: [...this.props.profiles, profile] } });
    this.closeAll();
  };

  // Clone this profile once per account: same card/shipping, but email = the account email and
  // profile name = the email's local part (lindseyfisher1948@gmail.com → "lindseyfisher1948").
  // Idempotent: accounts that ALREADY have a profile (matched by email) are skipped, so re-running
  // after adding more accounts only creates the new ones.
  createForAccounts = (base) => {
    const accounts = this.props.accounts || [];
    if (!accounts.length) { window.alert('No accounts yet — add them on the Accounts page first.'); return; }
    const existing = new Set(this.props.profiles.map(p => (p.email || '').trim().toLowerCase()).filter(Boolean));
    const toCreate = [];
    for (const a of accounts) {
      const email = (a.email || '').trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (existing.has(key)) continue;          // already has a profile — don't duplicate it
      existing.add(key);                        // also guards against duplicate emails within the batch
      // Clone the whole base profile (card + shipping); the bulk IPC strips the source id and assigns
      // a fresh one to each clone.
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
    const profiles = this.props.profiles.map(p => p.id === id ? { ...p, ...data } : p);
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.closeAll();
  };

  handleDelete = (id) => {
    ipcRenderer.sendSync('deleteProfile', id);
    const profiles = this.props.profiles.filter(p => p.id !== id);
    this.props.dispatch({ type: 'update', obj: { profiles } });
  };

  handleDeleteSelected = () => {
    this.state.selected.forEach(id => {
      ipcRenderer.sendSync('deleteProfile', id);
    });
    const profiles = this.props.profiles.filter(p => !this.state.selected.includes(p.id));
    this.props.dispatch({ type: 'update', obj: { profiles } });
    this.setState({ selected: [] });
  };

  toggleSelect = (id) => {
    this.setState(prev => ({
      selected: prev.selected.includes(id)
        ? prev.selected.filter(x => x !== id)
        : [...prev.selected, id],
    }));
  };

  selectAll = () => {
    this.setState({ selected: this.props.profiles.map(p => p.id) });
  };

  clearSelect = () => this.setState({ selected: [] });

  render() {
    const { profiles, targetTasks } = this.props;
    // Profiles currently attached to a Target task. Read from the store rather than tracked on the
    // profile itself, so deleting a task frees its profile with no bookkeeping to get out of sync.
    const usedProfileIds = new Set((targetTasks || []).map(t => String(t.profileId || '')).filter(Boolean));
    const { showCreate, editProfile, duplicateInitial, selected, tab, query } = this.state;

    // One search box over everything you might remember a profile by. Matching on the JOINED
    // haystack rather than field-by-field means "houston jimmy" finds a Houston profile named Jimmy
    // without the terms having to be in one field or in order.
    const q = String(query || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const shownProfiles = !terms.length ? profiles : profiles.filter((p) => {
      const sh = p.shipping || {};
      const hay = [
        p.profileName, p.email, p.phone,
        sh.firstName || p.firstName, sh.lastName || p.lastName,
        sh.address || p.address, sh.city, sh.state, sh.zipcode,
        ...(p.groups || []), p.group,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });

    const allSelected = profiles.length > 0 && selected.length === profiles.length;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title">
            <span className="page-title-dot" />
            Profiles
            {profiles.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>
                — {profiles.length}
              </span>
            )}
            <span style={{ display: 'inline-flex', gap: 4, marginLeft: 14 }}>
              {['profiles', 'groups'].map(t => (
                <button
                  key={t}
                  className="btn btn-sm"
                  onClick={() => this.setState({ tab: t, selected: [] })}
                  style={{
                    background: tab === t ? 'var(--accent-fill)' : 'transparent',
                    color: tab === t ? '#fff' : 'var(--muted)',
                    border: '1px solid var(--field-border)', textTransform: 'capitalize',
                  }}
                >
                  {t}
                </button>
              ))}
            </span>
          </div>
          {tab === 'profiles' && (
          <div className="page-actions">
            {selected.length > 0 && (
              <>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{selected.length} selected</span>
                <button className="btn btn-danger btn-sm" onClick={this.handleDeleteSelected}>
                  <i className="ion-md-trash" style={{ fontSize: 12 }} /> Delete
                </button>
                <button className="btn btn-secondary btn-sm" onClick={this.clearSelect}>Clear</button>
              </>
            )}
            {profiles.length > 0 && selected.length === 0 && (
              <button className="btn btn-secondary btn-sm" onClick={allSelected ? this.clearSelect : this.selectAll}>
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={this.importAycd} title="Import profiles in AYCD format">
              Import
            </button>
            <button className="btn btn-secondary btn-sm" onClick={this.exportAycd}
              title="Export in AYCD format — exports the selection, or everything if nothing is selected">
              Export
            </button>
            <button className="btn btn-primary btn-sm" onClick={this.openCreate}>
              <i className="ion-md-add" style={{ fontSize: 13 }} /> New Profile
            </button>
          </div>
          )}
        </div>

        {this.state.msg && (
          <div className="form-hint" style={{ padding: '6px 16px', color: 'var(--text)' }}>
            {this.state.msg}
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 10 }}
              onClick={() => this.setState({ msg: '' })}>dismiss</button>
          </div>
        )}

        {tab !== 'groups' && (
          <div style={{ padding: '0 16px 8px' }}>
            <input
              className="form-input"
              placeholder="Search name, email, city, group…"
              value={this.state.query}
              onChange={(e) => this.setState({ query: e.target.value })}
              style={{ width: '100%', maxWidth: 420 }}
            />
            {this.state.query && (
              <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--muted)' }}>
                {shownProfiles.length} of {profiles.length}
              </span>
            )}
          </div>
        )}

        <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
         <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tab === 'groups' ? (
            <Groups profiles={profiles} dispatch={this.props.dispatch} />
          ) : shownProfiles.length === 0 ? (
            <div className="table-wrap">
              <div className="table-empty">
                <div className="table-empty-icon"><i className="ion-md-person" /></div>
                <div className="table-empty-text">
                  {profiles.length ? 'No profiles match that search' : 'No profiles yet'}
                </div>
                <div className="table-empty-sub">
                  {profiles.length ? 'Try a name, email, city or group' : 'Add shipping + payment details to get started'}
                </div>
              </div>
            </div>
          ) : (
            <div className="profile-grid">
              {shownProfiles.map(p => {
                const name = p.shipping?.firstName || p.firstName || '';
                const last = p.shipping?.lastName || p.lastName || '';
                const addr = p.shipping?.address || p.address || '';
                const city = p.shipping?.city || p.city || '';
                const state = p.shipping?.state || p.state || '';
                const cardNum = p.payment?.cardNumber || p.cardNumber || '';
                const isSelected = selected.includes(p.id);

                return (
                  <div
                    key={p.id}
                    className={`profile-card${isSelected ? ' selected' : ''}`}
                    onClick={() => this.toggleSelect(p.id)}
                  >
                    <div className="profile-card-name">
                      {p.profileName || `${name} ${last}`}
                      {/* A profile attached to a Target task is spent — deleting or editing it under a
                          running task changes what that task will charge. Say so on the card rather
                          than making someone cross-reference the Target page. */}
                      {usedProfileIds.has(String(p.id)) && (
                        <span
                          title="Attached to a Target task"
                          style={{
                            marginLeft: 6, fontSize: 10, fontWeight: 600, letterSpacing: .3,
                            padding: '1px 6px', borderRadius: 999,
                            color: 'var(--ok)', border: '1px solid var(--ok)',
                          }}
                        >IN USE</span>
                      )}
                    </div>
                    <div className="profile-card-detail">
                      {p.email}<br />
                      {addr}{city ? `, ${city}` : ''}{state ? `, ${state}` : ''}
                    </div>
                    <div className="profile-card-card">{maskCard(cardNum)}</div>
                    <div style={{ fontSize: 10, color: p.imap?.user ? 'var(--ok)' : 'var(--muted)', marginTop: 4 }}>
                      <i className="ion-md-mail" style={{ marginRight: 5 }} />
                      {p.imap?.user ? `OTP: ${p.imap.user}` : 'OTP mailbox not configured'}
                    </div>
                    <div className="profile-card-actions">
                      <button
                        className="btn btn-sm btn-secondary btn-icon"
                        title="Edit"
                        onClick={e => { e.stopPropagation(); this.openEdit(p); }}
                      >
                        <i className="ion-md-create" style={{ fontSize: 12 }} />
                      </button>
                      <button
                        className="btn btn-sm btn-secondary btn-icon"
                        title="Duplicate"
                        onClick={e => { e.stopPropagation(); this.openDuplicate(p); }}
                      >
                        <i className="ion-md-copy" style={{ fontSize: 12 }} />
                      </button>
                      <button
                        className="btn btn-sm btn-icon"
                        title="Create a profile for every account email under this profile (copies card + address; skips accounts that already have one)"
                        onClick={e => { e.stopPropagation(); this.createForAccounts(p); }}
                        style={{ background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}
                      >
                        <i className="ion-md-copy" style={{ fontSize: 12 }} />
                        <i className="ion-md-key" style={{ fontSize: 10, marginLeft: 2 }} />
                      </button>
                      <button
                        className="btn btn-sm btn-danger btn-icon"
                        title="Delete"
                        onClick={e => { e.stopPropagation(); this.handleDelete(p.id); }}
                      >
                        <i className="ion-md-trash" style={{ fontSize: 12 }} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
         </div>
        </div>

        {showCreate && !editProfile && (
          <CreateModal onSave={this.handleCreate} onClose={this.closeAll} />
        )}

        {editProfile && (
          <EditModal profile={editProfile} onSave={this.handleEdit} onClose={this.closeAll} />
        )}

        {duplicateInitial && (
          <CreateModal initial={duplicateInitial} title="Duplicate Profile" onSave={this.handleCreate} onClose={this.closeAll} />
        )}
      </div>
    );
  }
}

export default connect(s => ({ profiles: s.profiles, accounts: s.accounts, targetTasks: (s.target && s.target.tasks) || [] }))(Profiles);
