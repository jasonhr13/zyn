import React, { Component } from 'react';
const { ipcRenderer } = window.require('electron');

// Profiles → Groups manager. A "group" is a free-text tag stored on each profile
// (`profiles[].groups: string[]`). Writes go through batch IPC, then we re-fetch the authoritative
// profiles list so Redux and disk cannot drift.
const inputStyle = {
  width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '6px 9px',
  border: '1px solid var(--field-border)', borderRadius: 6, background: 'var(--bg)', color: 'inherit', outline: 'none',
};

class Groups extends Component {
  state = { selected: '', draftGroups: [], newName: '', search: '' };

  // Every group tag in use, plus any freshly-created (still-empty) name so it's visible + selectable.
  allGroups = () => {
    const set = new Set(this.props.profiles.flatMap(p => p.groups || []));
    this.state.draftGroups.forEach(g => set.add(g));
    return [...set].sort((a, b) => a.localeCompare(b));
  };

  count = (g) => this.props.profiles.filter(p => (p.groups || []).includes(g)).length;

  // After any write, re-pull the authoritative profiles list and push it into Redux.
  refresh = () => {
    const profiles = ipcRenderer.sendSync('getProfiles') || [];
    this.props.dispatch({ type: 'update', obj: { profiles } });
  };

  createGroup = () => {
    const name = this.state.newName.trim();
    if (!name) return;
    // A group only truly exists once a profile carries it — keep it as a draft so it shows (0) and is
    // selectable until you add members.
    this.setState(s => ({ newName: '', selected: name, search: '', draftGroups: [...new Set([...s.draftGroups, name])] }));
  };

  deleteGroup = (g) => {
    const n = this.count(g);
    if (n && !window.confirm(`Remove the group “${g}” from ${n} profile(s)? (The profiles themselves are kept.)`)) return;
    const ids = this.props.profiles.filter(p => (p.groups || []).includes(g)).map(p => p.id);
    if (ids.length) ipcRenderer.sendSync('removeProfilesFromGroup', { ids, group: g });
    this.setState(
      s => ({ draftGroups: s.draftGroups.filter(x => x !== g), selected: s.selected === g ? '' : s.selected }),
      this.refresh,
    );
  };

  // Raw write for a SINGLE checkbox toggle (no confirm — one profile at a time is low-risk).
  writeMembers = (ids, on) => {
    const g = this.state.selected;
    if (!g || !ids.length) return;
    ipcRenderer.sendSync(on ? 'addProfilesToGroup' : 'removeProfilesFromGroup', { ids, group: g });
    // Adding members to a draft group makes it real — drop it from the draft list.
    this.setState(s => ({ draftGroups: s.draftGroups.filter(x => x !== g) }), this.refresh);
  };

  // Bulk add/remove always confirms because a whole-group rewrite is intentionally high impact.
  bulkSet = (ids, on) => {
    const g = this.state.selected;
    if (!g || !ids.length) return;
    if (!window.confirm(`${on ? 'Add' : 'Remove'} ${ids.length} profile(s) ${on ? 'to' : 'from'} the group “${g}”?`)) return;
    this.writeMembers(ids, on);
  };

  render() {
    const { profiles } = this.props;
    const { selected, search } = this.state;
    const groups = this.allGroups();
    const q = search.trim().toLowerCase();
    const shown = !selected ? [] : profiles.filter(p =>
      !q || (p.profileName || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q));
    const inGroup = (p) => (p.groups || []).includes(selected);
    const shownOut = shown.filter(p => !inGroup(p));
    const shownIn = shown.filter(inGroup);

    return (
      <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
        {/* ── Left: group list + create ── */}
        <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              value={this.state.newName}
              onChange={e => this.setState({ newName: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') this.createGroup(); }}
              placeholder="New group name…"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={this.createGroup}>Add</button>
          </div>
          <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
            {groups.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 4px' }}>No groups yet — name one above.</div>
            )}
            {groups.map(g => (
              <div
                key={g}
                onClick={() => this.setState({ selected: g, search: '' })}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '7px 10px', marginBottom: 4, borderRadius: 8, cursor: 'pointer',
                  background: selected === g ? 'var(--accent-fill)' : 'transparent',
                  color: selected === g ? '#fff' : 'inherit',
                  border: '1px solid var(--field-border)',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>{this.count(g)}</span>
                  <span
                    title={`Delete group “${g}”`}
                    onClick={e => { e.stopPropagation(); this.deleteGroup(g); }}
                    style={{ fontSize: 12, opacity: 0.7, cursor: 'pointer', lineHeight: 1 }}
                  >✕</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: member assignment ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!selected ? null : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <input
                  value={search}
                  onChange={e => this.setState({ search: e.target.value })}
                  placeholder="Search profiles by name or email…"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button className="btn btn-secondary btn-sm" disabled={!shownOut.length} onClick={() => this.bulkSet(shownOut.map(p => p.id), true)}>
                  + Add {q ? 'shown' : 'all'} ({shownOut.length})
                </button>
                <button className="btn btn-secondary btn-sm" disabled={!shownIn.length} onClick={() => this.bulkSet(shownIn.map(p => p.id), false)}>
                  − Remove {q ? 'shown' : 'all'} ({shownIn.length})
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                “{selected}” — {this.count(selected)} profile(s) in group
              </div>
              <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
                {shown.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: 10 }}>No profiles match{q ? ` “${search.trim()}”` : ''}.</div>
                ) : shown.map(p => {
                  const on = inGroup(p);
                  return (
                    <label
                      key={p.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', marginBottom: 3,
                        borderRadius: 8, cursor: 'pointer', border: '1px solid var(--field-border)',
                        background: on ? 'var(--accent-soft)' : 'transparent',
                      }}
                    >
                      <input type="checkbox" checked={on} onChange={e => this.writeMembers([p.id], e.target.checked)} />
                      <span style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.profileName || '(unnamed)'}</span>
                        <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.email || ''}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
}

export default Groups;
