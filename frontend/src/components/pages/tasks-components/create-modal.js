import React, { Component } from 'react';
import { connect } from 'react-redux';

class CreateTaskModal extends Component {
  constructor(props) {
    super(props);
    const init = props.initialData || {};
    this.isEdit = !!props.initialData;
    const pid = init.profileId || (init.profileIds && init.profileIds[0]) || '';
    this.state = {
      name: init.name || '',
      productUrl: init.productUrl || '',
      variant: init.variant || '',
      qty: init.qty || props.settings.defaultQty || 1,
      proxyList: init.proxyList || '',
      target: pid ? 'p:' + pid : '',
      browserMode: init.browserMode || 'headless',
      taskCount: 1,
    };
  }

  handleChange = (field, value) => this.setState({ [field]: value });

  // Reads BOTH shapes. Groups moved to a `groups` ARRAY when a profile became able to be in several
  // at once ("Coupon" and "Invites"); this still read the legacy single `group` string, which is ""
  // on every profile now. So the dropdown had no groups in it at all and offered only individual
  // profiles -- the group feature looked missing when it was simply being read from the wrong field.
  static inGroup(p, g) {
    return (p.groups || []).includes(g) || (p.group || '') === g;
  }

  get groups() {
    const set = new Set();
    (this.props.profiles || []).forEach((p) => {
      (p.groups || []).forEach((g) => { if (g) set.add(String(g)); });
      if (p.group) set.add(String(p.group));
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // How many tasks the current selection will create
  get totalTasks() {
    if (this.isEdit) return 1;
    const { target, taskCount } = this.state;
    const count = Math.max(1, Math.min(50, parseInt(taskCount) || 1));
    if (target.startsWith('g:')) {
      const g = target.slice(2);
      const n = (this.props.profiles || []).filter(p => CreateTaskModal.inGroup(p, g)).length || 1;
      return n * count;
    }
    return count;
  }

  handleSubmit = () => {
    const { name, productUrl, variant, qty, proxyList, target, browserMode, taskCount } = this.state;
    if (!name.trim()) return;
    const base = {
      productUrl: productUrl.trim(),
      variant: variant.trim(),
      qty: Math.max(1, parseInt(qty) || 1),
      proxyList,
      browserMode,
    };

    // Edit = single task
    if (this.isEdit) {
      const pid = target.startsWith('p:') ? target.slice(2) : '';
      this.props.onCreate({ ...base, name: name.trim(), profileId: pid, profileIds: pid ? [pid] : [] });
      return;
    }

    // Resolve target profile ids (a group expands to all its profiles)
    const profiles = this.props.profiles || [];
    let pids;
    if (target.startsWith('g:')) {
      const g = target.slice(2);
      pids = profiles.filter(p => CreateTaskModal.inGroup(p, g)).map(p => p.id);
    } else if (target.startsWith('p:')) {
      pids = [target.slice(2)];
    } else {
      pids = [''];
    }
    const count = Math.max(1, Math.min(50, parseInt(taskCount) || 1));

    const tasks = [];
    pids.forEach(pid => {
      const prof = profiles.find(p => p.id === pid);
      for (let i = 0; i < count; i++) {
        let label = name.trim();
        if (pids.length > 1 && prof) label += ` — ${prof.profileName || prof.email}`;
        if (count > 1) label += ` #${i + 1}`;
        tasks.push({ ...base, name: label, profileId: pid, profileIds: pid ? [pid] : [] });
      }
    });
    this.props.onCreate(tasks);
  };

  render() {
    const { profiles, proxies, onClose } = this.props;
    const { name, productUrl, variant, qty, proxyList, target, browserMode, taskCount } = this.state;
    const groups = this.groups;
    const isEdit = this.isEdit;
    const total = this.totalTasks;

    return (
      <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-header">
            <span className="modal-title">{isEdit ? 'Edit Task' : 'New Task'}</span>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>

          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Task Name *</label>
              <input
                className="form-input"
                placeholder="e.g. Garfield Foil"
                value={name}
                onChange={e => this.handleChange('name', e.target.value)}
                autoFocus
              />
            </div>

            <div className="form-group">
              <label className="form-label">Profile{!isEdit ? ' or Group' : ''}</label>
              {profiles.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--muted)', padding: '8px 0' }}>
                  No profiles yet — add some in the Profiles tab
                </div>
              ) : (
                <select
                  className="form-select"
                  value={target}
                  onChange={e => this.handleChange('target', e.target.value)}
                >
                  <option value="">— Select {isEdit ? 'a profile' : 'profile or group'} —</option>
                  {!isEdit && groups.length > 0 && (
                    <optgroup label="Groups">
                      {groups.map(g => {
                        const c = profiles.filter(p => CreateTaskModal.inGroup(p, g)).length;
                        return <option key={'g:' + g} value={'g:' + g}>{g} ({c} profile{c !== 1 ? 's' : ''})</option>;
                      })}
                    </optgroup>
                  )}
                  <optgroup label="Profiles">
                    {profiles.map(p => (
                      <option key={p.id} value={'p:' + p.id}>
                        {/* Show every group the profile is in, not just the legacy single one — a
                            profile in Coupon AND Invites read as ungrouped here. */}
                        {p.profileName || p.email}
                        {(p.groups || []).length ? ` · ${(p.groups || []).join(', ')}` : (p.group ? ` · ${p.group}` : '')}
                      </option>
                    ))}
                  </optgroup>
                </select>
              )}
              <span className="form-hint">
                {isEdit ? '1 task = 1 profile.' : 'Pick a group to make a task for every profile in it.'}
              </span>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Units / order</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="10"
                  value={qty}
                  onChange={e => this.handleChange('qty', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Proxy List</label>
                <select
                  className="form-select"
                  value={proxyList}
                  onChange={e => this.handleChange('proxyList', e.target.value)}
                >
                  <option value="">None</option>
                  {proxies.lists.map(l => (
                    <option key={l.name} value={l.name}>{l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Product URL <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(optional)</span></label>
              <input
                className="form-input monospace"
                placeholder="https://secretlair.wizards.com/us/..."
                value={productUrl}
                onChange={e => this.handleChange('productUrl', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Variant <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(optional)</span></label>
              <input
                className="form-input"
                placeholder="e.g. FOIL"
                value={variant}
                onChange={e => this.handleChange('variant', e.target.value)}
              />
            </div>

            <div className="form-group" style={{ marginTop: 8 }}>
              <label className="form-label">Browser Mode</label>
              <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                {[
                  { value: 'headless', label: 'Headless', desc: 'Invisible, fast' },
                  { value: 'headed',   label: 'Browser',  desc: 'Visible Chrome' },
                ].map(opt => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="browserMode"
                      value={opt.value}
                      checked={browserMode === opt.value}
                      onChange={() => this.handleChange('browserMode', opt.value)}
                    />
                    <span style={{ fontSize: 12 }}>
                      <strong>{opt.label}</strong>
                      <span style={{ color: 'var(--muted)', marginLeft: 4 }}>— {opt.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="form-hint" style={{ marginTop: 4 }}>
              Cart URL is pulled automatically from Discord — no need to set it here.
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            {!isEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>Tasks</span>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="50"
                  value={taskCount}
                  onChange={e => this.handleChange('taskCount', e.target.value)}
                  style={{ width: 58 }}
                />
              </div>
            )}
            <button className="btn btn-primary" onClick={this.handleSubmit} disabled={!name.trim()}>
              {isEdit ? 'Save Task' : (total > 1 ? `Create ${total} Tasks` : 'Create Task')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const mapStateToProps = s => ({ profiles: s.profiles, proxies: s.proxies, settings: s.settings });
export default connect(mapStateToProps)(CreateTaskModal);
