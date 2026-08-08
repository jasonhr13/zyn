import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import Icon from '../icon';
import { proxyLabel, proxyLabelForRef, proxyRef } from '../proxy-options';
import { sameTargetBank, targetBankMetrics } from '../target-bank-metrics.mjs';

const { ipcRenderer, clipboard } = window.require('electron');

const EMPTY_GROUP = Object.freeze({
  name: '',
  skus: '',
  qty: 2,
  proxyListName: '',
});

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const siteOf = account => String((account && account.site) || 'bandai').toLowerCase();
const normalizeCookieBankSize = value => String(value == null ? '' : value).replace(/\D/g, '').slice(0, 4);
const parseSkus = raw => String(raw || '').split(/[\n,]/).map(line => {
  const value = line.trim();
  if (!value) return '';
  const direct = (value.match(/^(\d{6,})/) || [])[1];
  if (direct) return direct;
  const marker = value.toUpperCase().lastIndexOf('A-');
  return ((marker >= 0 ? value.slice(marker + 2) : value).match(/^\d+/) || [])[0] || '';
}).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);

function statusKind(status) {
  if (!status) return 'idle';
  const text = `${status.state || ''} ${status.label || ''}`.toLowerCase();
  const color = String(status.color || '').toLowerCase();
  if (/error|fail|declin|cancel|blocked/.test(text) || color === '#fb5454' || color === '#ff5a5a') return 'error';
  if (/success|complete|ordered|checked out/.test(text)) return 'success';
  if (status.running === false || /idle|stopped/.test(text)) return 'idle';
  return 'running';
}

const STATUS_LABELS = {
  idle: 'Idle',
  running: 'Running',
  success: 'Success',
  error: 'Attention',
};

function StatusBadge({ status }) {
  const kind = statusKind(status);
  return (
    <span className={`group-status group-status-${kind}`}>
      <span className="group-status-dot" />
      {(status && (status.label || status.state)) || STATUS_LABELS[kind]}
    </span>
  );
}

class TaskGroups extends Component {
  engineLogBox = createRef();

  state = {
    loaded: false,
    groups: [],
    selectedGroupId: '',
    groupFilter: '',
    taskFilter: '',
    showGroupModal: false,
    editingGroupId: '',
    groupDraft: { ...EMPTY_GROUP },
    showTaskModal: false,
    selectedAccounts: [],
    taskProxy: '',
    copiedEngine: false,
    bank: null,
    cookieBankSize: '',
    harvestWorkers: '',
  };

  componentDidMount() {
    this.loadGroups();
    this.pollBank();
    this.bankTimer = setInterval(this.pollBank, 5000);
  }

  componentDidUpdate(prevProps) {
    const previous = ((prevProps.target && prevProps.target.logs) || []).length;
    const current = ((this.props.target && this.props.target.logs) || []).length;
    if (previous !== current && this.engineLogBox.current) {
      const element = this.engineLogBox.current;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 96) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }

  componentWillUnmount() {
    clearInterval(this.bankTimer);
  }

  loadGroups = () => {
    let groups = [];
    let cookieBankSize = '';
    let harvestWorkers = '';
    try { groups = ipcRenderer.sendSync('getTaskGroups') || []; } catch {}
    try {
      const settings = ipcRenderer.sendSync('getSettings') || {};
      cookieBankSize = normalizeCookieBankSize(settings.targetCookieBank);
      harvestWorkers = normalizeCookieBankSize(settings.targetHarvestWorkers);
    } catch {}
    this.setState(({ selectedGroupId }) => ({
      groups,
      loaded: true,
      cookieBankSize,
      harvestWorkers,
      selectedGroupId: groups.some(group => group.id === selectedGroupId) ? selectedGroupId : '',
    }));
  };

  pollBank = () => {
    ipcRenderer.invoke('targetCookieBank')
      .then(bank => this.setState(previous => sameTargetBank(previous.bank, bank) ? null : { bank }))
      .catch(() => this.setState(previous => previous.bank === null ? null : { bank: null }));
  };

  saveCookieBankSize = () => {
    const targetCookieBank = normalizeCookieBankSize(this.state.cookieBankSize);
    let settings = this.props.settings || {};
    try { settings = ipcRenderer.sendSync('getSettings') || settings; } catch {}
    if (String(settings.targetCookieBank == null ? '' : settings.targetCookieBank) === targetCookieBank) return;
    const next = { ...settings, targetCookieBank };
    try { ipcRenderer.sendSync('saveSettings', next); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings: next } });
    this.setState({ cookieBankSize: targetCookieBank });
  };

  profileList = () => {
    const value = this.props.profiles || [];
    return value.list || value.profiles || (Array.isArray(value) ? value : []);
  };

  targetAccounts = () => (this.props.accounts || []).filter(account => siteOf(account) === 'target');
  proxyLists = () => ((this.props.proxies && this.props.proxies.lists) || []);
  selectedGroup = () => this.state.groups.find(group => group.id === this.state.selectedGroupId);
  statusFor = task => (this.props.target.taskStatus || {})[task.id];
  accountFor = task => (this.props.accounts || []).find(account => String(account.id) === String(task.accountId));

  profileForAccount = (accountId) => {
    const account = (this.props.accounts || []).find(item => String(item.id) === String(accountId));
    const email = String((account && account.email) || '').trim().toLowerCase();
    if (!email) return null;
    return this.profileList().find(profile => String(profile.email || '').trim().toLowerCase() === email) || null;
  };

  persist = (groups, callback) => {
    let saved = groups;
    try { saved = ipcRenderer.sendSync('saveTaskGroups', groups) || groups; } catch {}
    this.setState({ groups: saved }, callback);
  };

  groupStats = (group) => {
    const stats = { total: (group.tasks || []).length, running: 0, success: 0, error: 0 };
    for (const task of (group.tasks || [])) {
      const kind = statusKind(this.statusFor(task));
      if (kind !== 'idle') stats[kind] += 1;
    }
    return stats;
  };

  allStats = () => this.state.groups.reduce((sum, group) => {
    const stats = this.groupStats(group);
    sum.tasks += stats.total;
    sum.running += stats.running;
    sum.attention += stats.error;
    return sum;
  }, { groups: this.state.groups.length, tasks: 0, running: 0, attention: 0 });

  openNewGroup = () => this.setState({
    showGroupModal: true,
    editingGroupId: '',
    groupDraft: { ...EMPTY_GROUP },
  });

  openEditGroup = group => this.setState({
    showGroupModal: true,
    editingGroupId: group.id,
    groupDraft: {
      name: group.name,
      skus: group.skus || '',
      qty: group.qty || 2,
      proxyListName: group.proxyListName || '',
    },
  });

  closeGroupModal = () => this.setState({ showGroupModal: false, editingGroupId: '' });

  saveGroup = () => {
    const draft = this.state.groupDraft;
    const name = String(draft.name || '').trim();
    if (!name) return;
    const now = Date.now();
    let selectedGroupId = this.state.editingGroupId;
    let groups;
    if (selectedGroupId) {
      groups = this.state.groups.map(group => group.id === selectedGroupId ? {
        ...group,
        name,
        skus: draft.skus,
        qty: draft.qty,
        proxyListName: draft.proxyListName,
        updatedAt: now,
      } : group);
    } else {
      selectedGroupId = uid('group');
      groups = [...this.state.groups, {
        id: selectedGroupId,
        name,
        site: 'target',
        skus: draft.skus,
        qty: draft.qty,
        proxyListName: draft.proxyListName,
        tasks: [],
        createdAt: now,
        updatedAt: now,
      }];
    }
    this.persist(groups, () => this.setState({
      selectedGroupId,
      showGroupModal: false,
      editingGroupId: '',
    }));
  };

  deleteGroup = (group) => {
    if (!window.confirm(`Delete “${group.name}” and its ${(group.tasks || []).length} task(s)?\n\nThe legacy Target workspace is not affected.`)) return;
    for (const task of (group.tasks || [])) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    }
    this.persist(this.state.groups.filter(item => item.id !== group.id), () => {
      if (this.state.selectedGroupId === group.id) this.setState({ selectedGroupId: '' });
    });
  };

  openTaskModal = group => this.setState({
    selectedGroupId: group.id,
    showTaskModal: true,
    selectedAccounts: [],
    taskProxy: group.proxyListName || '',
  });

  toggleAccount = (accountId) => this.setState(({ selectedAccounts }) => ({
    selectedAccounts: selectedAccounts.includes(accountId)
      ? selectedAccounts.filter(id => id !== accountId)
      : [...selectedAccounts, accountId],
  }));

  createTasks = () => {
    const group = this.selectedGroup();
    if (!group || !this.state.selectedAccounts.length) return;
    const used = new Set((group.tasks || []).map(task => String(task.accountId)));
    const now = Date.now();
    const tasks = this.state.selectedAccounts
      .filter(accountId => !used.has(String(accountId)))
      .map(accountId => ({
        id: uid('target'),
        accountId,
        profileId: '',
        proxyListName: this.state.taskProxy,
        cardId: '',
        createdAt: now,
      }));
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: [...(item.tasks || []), ...tasks],
      updatedAt: now,
    } : item);
    this.persist(groups, () => this.setState({
      showTaskModal: false,
      selectedAccounts: [],
    }));
  };

  updateTaskProxy = (group, task, proxyListName) => {
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.map(candidate => candidate.id === task.id ? { ...candidate, proxyListName } : candidate),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups);
    try { ipcRenderer.sendSync('setTargetTaskProxy', task.id, proxyListName); } catch {}
  };

  deleteTask = (group, task) => {
    if (!window.confirm(`Delete the task for “${this.accountLabel(task)}” from “${group.name}”?`)) return;
    try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.filter(candidate => candidate.id !== task.id),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups);
  };

  accountLabel = task => {
    const account = this.accountFor(task);
    return (account && (account.email || account.username || account.name)) || task.accountId || 'Unknown account';
  };

  runnableTasks = (group, tasks) => {
    const skus = parseSkus(group.skus);
    if (!skus.length) {
      window.alert('Add at least one Target SKU to this task group first.');
      return null;
    }
    const runnable = [];
    const missing = [];
    for (const task of tasks) {
      const profile = this.profileForAccount(task.accountId);
      if (!profile) {
        missing.push(this.accountLabel(task));
      } else {
        runnable.push({ ...task, profileId: profile.id });
      }
    }
    if (!runnable.length) {
      window.alert(missing.length
        ? 'No task has a profile whose email matches its Target account.'
        : 'There are no tasks to start.');
      return null;
    }
    if (missing.length) {
      window.alert(`Skipping ${missing.length} task(s) with no matching profile:\n${missing.slice(0, 8).join('\n')}`);
    }
    return { tasks: runnable, skus, qty: group.qty || 2 };
  };

  activeOtherGroup = group => this.state.groups.find(item => item.id !== group.id
    && (item.tasks || []).some(task => statusKind(this.statusFor(task)) === 'running'));

  startTasks = (group, tasks) => {
    const other = this.activeOtherGroup(group);
    if (other) {
      window.alert(`“${other.name}” is already running. The current Target engine has one shared monitor, so stop that group first.`);
      return;
    }
    const config = this.runnableTasks(group, tasks);
    if (config) ipcRenderer.send('startTarget', config);
  };

  stopTasks = (tasks) => {
    for (const task of tasks) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    }
  };

  copyEngineLogs = () => {
    const logs = (this.props.target && this.props.target.logs) || [];
    if (!logs.length) return;
    try { clipboard.writeText(logs.join('\n')); } catch {}
    this.setState({ copiedEngine: true }, () => {
      setTimeout(() => this.setState({ copiedEngine: false }), 1200);
    });
  };

  clearEngineLogs = () => {
    const logs = (this.props.target && this.props.target.logs) || [];
    if (!logs.length || !window.confirm('Clear the shared engine / monitor log?')) return;
    this.props.dispatch({ type: 'targetSet', obj: { logs: [] } });
  };

  renderSharedEngineLog() {
    const target = this.props.target || {};
    const logs = target.logs || [];
    const monitor = target.monitorStatus;
    return (
      <section className="panel task-log-panel engine-log-panel engine-log-panel-dashboard">
        <div className="detail-panel-heading engine-log-heading">
          <div className="engine-log-heading-left">
            <h3><Icon name="activity" size={13} /> Engine &amp; Monitor Log</h3>
            <span className="engine-log-meta">
              <span className="engine-log-line-count">
                {logs.length} line{logs.length === 1 ? '' : 's'}
              </span>
              {monitor && (
                <em className="engine-monitor-chip" style={{ color: monitor.color || 'var(--muted)' }}>
                  monitor: {monitor.label || monitor.state || 'idle'}
                </em>
              )}
            </span>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={this.copyEngineLogs} disabled={!logs.length}>
              <Icon name="copy" size={11} /> {this.state.copiedEngine ? 'Copied' : 'Copy'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={this.clearEngineLogs} disabled={!logs.length}>
              Clear
            </button>
          </div>
        </div>
        <div className="task-log-view engine-log-view" ref={this.engineLogBox}>
          {!logs.length ? (
            <div className="task-log-empty">
              <Icon name="activity" size={20} />
              <span>No shared engine output yet</span>
              <small>Shape farmer, stock monitor, Discord pings, and engine lifecycle output appear here for this Target workspace.</small>
            </div>
          ) : logs.map((line, index) => (
            <div key={index}><span>{String(index + 1).padStart(3, '0')}</span>{line}</div>
          ))}
        </div>
      </section>
    );
  }

  legacyActiveWorkerCount = () => {
    if (!this.state.bank) return 0;
    const logs = ((this.props.target && this.props.target.logs) || []).slice().reverse();
    for (const line of logs) {
      const text = String(line);
      if (/shape farmer exited|farmer disabled|harvester broker listening/i.test(text)) return 0;
      const match = text.match(/started\s+(\d+)\s+farmer worker/i);
      if (match) return Number(match[1]) || 0;
    }
    return 0;
  };

  renderCookieBank() {
    const bank = this.state.bank;
    const metrics = targetBankMetrics(bank);
    const legacyWorkers = this.legacyActiveWorkerCount();
    const configuredWorkers = Number(this.state.harvestWorkers) || 0;
    const activeWorkers = metrics.activeWorkers || legacyWorkers;
    const workerLimit = metrics.workerLimit || metrics.configuredWorkers || configuredWorkers;
    const workerValue = activeWorkers && workerLimit
      ? `${activeWorkers}/${workerLimit}`
      : activeWorkers || workerLimit || 'Auto';
    const working = metrics.inFlightAtc > 0 || activeWorkers > 0 || metrics.farmedAtc > 0;
    const state = !bank ? 'offline' : metrics.login > 0 || metrics.atc > 0 ? 'ready' : working ? 'working' : 'warming';
    const label = state === 'ready' ? 'Ready' : state === 'working' ? 'Farming live' : state === 'warming' ? 'Warming up' : 'Broker offline';
    const workerDescription = activeWorkers
      ? `${activeWorkers} active worker${activeWorkers === 1 ? '' : 's'}${workerLimit ? ` / ${workerLimit} configured` : ''}`
      : workerLimit
        ? `${workerLimit} configured worker${workerLimit === 1 ? '' : 's'}`
        : 'Automatic worker count (one per detected browser)';
    const description = bank
      ? `${metrics.login} login and ${metrics.atc} ATC cookies banked · ${workerDescription}.`
      : 'Start a Target task or harvester to bring the cookie broker online.';

    return (
      <section className={`cookie-bank cookie-bank-prominent cookie-bank-${state}`} title={description}>
        <span className="cookie-bank-icon"><Icon name="cookie" size={18} /></span>
        <span className="cookie-bank-copy">
          <small>Cookie Bank</small>
          <strong>{label}</strong>
          <em>{description}</em>
        </span>
        <span className="cookie-bank-counts">
          <span><strong>{metrics.login}</strong><small>Login</small></span>
          <span><strong>{metrics.atc}</strong><small>ATC</small></span>
          <span title={workerDescription}><strong>{workerValue}</strong><small>Workers</small></span>
        </span>
        <label
          className="cookie-bank-limit"
          title="Maximum cookies of each type to bank. Blank or 0 keeps this recovered engine uncapped. Changes apply on the next Start."
        >
          <span>Bank max</span>
          <input
            type="text"
            inputMode="numeric"
            value={this.state.cookieBankSize}
            placeholder="No limit"
            aria-label="Target cookie bank maximum size"
            onChange={event => this.setState({ cookieBankSize: normalizeCookieBankSize(event.target.value) })}
            onBlur={this.saveCookieBankSize}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          <small>Next start</small>
        </label>
        <span className="cookie-bank-live"><i />{state === 'offline' ? 'Offline' : 'Live'}</span>
      </section>
    );
  }

  renderMetrics() {
    const stats = this.allStats();
    const metrics = [
      ['layers', stats.groups, 'Task groups', ''],
      ['list', stats.tasks, 'Configured tasks', ''],
      ['activity', stats.running, 'Running', ' task-metric-running'],
      ['warning', stats.attention, 'Need attention', ' task-metric-error'],
    ];
    return (
      <div className="task-metrics-row">
        {metrics.map(([icon, value, label, modifier]) => (
          <div className={`task-metric${modifier}`} key={label}>
            <span className="task-metric-icon"><Icon name={icon} size={18} /></span>
            <span><strong>{value}</strong><small>{label}</small></span>
          </div>
        ))}
      </div>
    );
  }

  renderGroupRow(group) {
    const stats = this.groupStats(group);
    const skus = parseSkus(group.skus);
    const running = stats.running > 0;
    return (
      <article
        className="task-group-row task-group-r2-row"
        key={group.id}
        tabIndex="0"
        onClick={() => this.setState({ selectedGroupId: group.id })}
        onKeyDown={event => event.key === 'Enter' && this.setState({ selectedGroupId: group.id })}
      >
        <div className="task-group-row-identity">
          <span className="site-mark"><Icon name="target" size={19} /></span>
          <span><h3>{group.name}</h3><p>Target task group</p></span>
        </div>
        <div className="task-group-row-stats">
          <span><strong>{stats.total}</strong>Tasks</span>
          <span><strong>{stats.running}</strong>Running</span>
          <span><strong>{stats.error}</strong>Attention</span>
        </div>
        <div className="task-group-row-runtime">
          <div className="task-group-row-summary">
            <span className="task-group-row-summary-icon"><Icon name="list" size={15} /></span>
            <span><small>Watch list</small><strong>{skus.length} SKU{skus.length === 1 ? '' : 's'} · qty {group.qty || 2}</strong></span>
          </div>
        </div>
        <div className="task-group-row-actions" onClick={event => event.stopPropagation()}>
          {running ? (
            <button className="btn btn-danger btn-sm" onClick={() => this.stopTasks(group.tasks)}><Icon name="stop" size={12} /> Stop</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => this.startTasks(group, group.tasks)}><Icon name="play" size={12} /> Start</button>
          )}
          <button className="icon-action" title="Edit group" onClick={() => this.openEditGroup(group)}><Icon name="settings" size={13} /></button>
          <button className="icon-action icon-action-danger" title="Delete group" onClick={() => this.deleteGroup(group)}><Icon name="trash" size={13} /></button>
          <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selectedGroupId: group.id })}>Open</button>
        </div>
      </article>
    );
  }

  renderOverview() {
    const filter = this.state.groupFilter.trim().toLowerCase();
    const visible = this.state.groups.filter(group => !filter || group.name.toLowerCase().includes(filter));
    return (
      <div className="tasks-workspace">
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Task Groups</div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.props.history.push('/modules')}>All workspaces</button>
            <button className="btn btn-primary btn-sm" onClick={this.openNewGroup}><Icon name="plus" size={13} /> New Group</button>
          </div>
        </div>
        <div className="page-content task-groups-content">
          {this.renderMetrics()}
          <div className="workspace-section-heading">
            <div><h2>Target task groups</h2><p>Organize shared watch lists and account tasks without changing the checkout engine.</p></div>
            {this.state.groups.length > 0 && (
              <input className="form-input task-filter" placeholder="Filter groups…" value={this.state.groupFilter} onChange={event => this.setState({ groupFilter: event.target.value })} />
            )}
          </div>
          {this.state.groups.length === 0 ? (
            <div className="task-groups-empty panel">
              <span className="empty-orbit"><Icon name="layers" size={25} /></span>
              <h3>Create the first task group</h3>
              <p>Each group owns one Target watch list and the accounts that should act on it. Your legacy Target workspace remains available separately.</p>
              <button className="btn btn-primary" onClick={this.openNewGroup}><Icon name="plus" size={13} /> Create Task Group</button>
            </div>
          ) : visible.length ? (
            <div className="task-group-list">{visible.map(group => this.renderGroupRow(group))}</div>
          ) : (
            <div className="task-groups-filter-empty panel"><span><Icon name="search" size={19} /></span><h3>No matching groups</h3><p>Try a different group name.</p></div>
          )}
        </div>
        {this.renderGroupModal()}
      </div>
    );
  }

  renderTaskRow(group, task) {
    const account = this.accountFor(task);
    const profile = this.profileForAccount(task.accountId);
    const status = this.statusFor(task);
    const running = statusKind(status) === 'running';
    const initial = String((account && account.email) || '?').slice(0, 1).toUpperCase();
    return (
      <div className="group-task-row" key={task.id}>
        <span className="task-primary"><i className="task-avatar">{initial}</i><span><strong>{this.accountLabel(task)}</strong><small>{task.id}</small></span></span>
        <span className={profile ? 'text-success' : 'text-danger'}>{profile ? 'Ready' : 'Missing profile'}</span>
        <select className="form-select task-proxy-select" value={task.proxyListName || ''} onChange={event => this.updateTaskProxy(group, task, event.target.value)}>
          <option value="">Local</option>
          {this.proxyLists().map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
        </select>
        <StatusBadge status={status} />
        <span>{new Date(task.createdAt || group.createdAt).toLocaleDateString()}</span>
        <span className="task-row-actions">
          {running ? (
            <button className="icon-action icon-action-stop" title="Stop task" onClick={() => this.stopTasks([task])}><Icon name="stop" size={12} /></button>
          ) : (
            <button className="icon-action icon-action-start" title="Start task" onClick={() => this.startTasks(group, [task])}><Icon name="play" size={12} /></button>
          )}
          <button className="icon-action icon-action-danger" title="Delete task" onClick={() => this.deleteTask(group, task)}><Icon name="trash" size={12} /></button>
        </span>
      </div>
    );
  }

  renderGroup(group) {
    const stats = this.groupStats(group);
    const filter = this.state.taskFilter.trim().toLowerCase();
    const visibleTasks = (group.tasks || []).filter(task => !filter || this.accountLabel(task).toLowerCase().includes(filter));
    return (
      <div className="tasks-workspace">
        <div className="page-header task-view-header">
          <div>
            <button className="breadcrumb-back" onClick={() => this.setState({ selectedGroupId: '', taskFilter: '' })}><Icon name="chevronDown" size={11} /> Task Groups</button>
            <div className="page-title"><span className="page-title-dot" /> {group.name}</div>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.openEditGroup(group)}><Icon name="settings" size={12} /> Edit Group</button>
            {stats.running ? (
              <button className="btn btn-danger btn-sm" onClick={() => this.stopTasks(group.tasks)}><Icon name="stop" size={12} /> Stop All</button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => this.startTasks(group, group.tasks)}><Icon name="play" size={12} /> Start All</button>
            )}
          </div>
        </div>
        <div className="page-content task-group-dashboard">
          <div className="panel group-config-strip group-config-strip-r2">
            <div><span>Site</span><strong><Icon name="target" size={12} /> Target</strong></div>
            <div><span>Tasks</span><strong>{stats.total}</strong></div>
            <div><span>Watch list</span><strong>{parseSkus(group.skus).length} SKU{parseSkus(group.skus).length === 1 ? '' : 's'} · qty {group.qty || 2}</strong></div>
            <div><span>Default proxy</span><strong>{proxyLabelForRef(this.proxyLists(), group.proxyListName, 'Local')}</strong></div>
          </div>
          {this.renderCookieBank()}
          <div className="panel group-task-panel">
            <div className="group-task-toolbar">
              <div><h2>Account tasks</h2><p>A matching checkout profile is required for each Target account.</p></div>
              <div className="page-actions">
                {(group.tasks || []).length > 0 && <input className="form-input task-filter" placeholder="Filter tasks…" value={this.state.taskFilter} onChange={event => this.setState({ taskFilter: event.target.value })} />}
                <button className="btn btn-primary btn-sm" onClick={() => this.openTaskModal(group)}><Icon name="plus" size={12} /> Add Tasks</button>
              </div>
            </div>
            {(group.tasks || []).length === 0 ? (
              <div className="group-tasks-empty"><span><Icon name="user" size={19} /></span><h3>No account tasks yet</h3><p>Add Target accounts to this group. Their checkout profiles are matched automatically by email.</p><button className="btn btn-primary btn-sm" onClick={() => this.openTaskModal(group)}>Add Tasks</button></div>
            ) : (
              <div>
                <div className="group-task-row group-task-table-head"><span>Account</span><span>Profile</span><span>Proxy</span><span>Status</span><span>Created</span><span>Actions</span></div>
                {visibleTasks.map(task => this.renderTaskRow(group, task))}
                {!visibleTasks.length && <div className="table-empty" style={{ padding: 28 }}>No matching tasks.</div>}
              </div>
            )}
          </div>
          {this.renderSharedEngineLog()}
          <div className="task-group-r2-boundary"><Icon name="warning" size={14} /><span>R2 groups existing Target controls only. Scheduling remains disabled until its own release gate.</span></div>
        </div>
        {this.renderGroupModal()}
        {this.renderTaskModal(group)}
      </div>
    );
  }

  renderGroupModal() {
    if (!this.state.showGroupModal) return null;
    const draft = this.state.groupDraft;
    const editing = Boolean(this.state.editingGroupId);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeGroupModal()}>
        <div className="modal task-group-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header"><div><div className="modal-title">{editing ? 'Edit Target Group' : 'New Target Group'}</div><p>One shared watch list, with one checkout task per account.</p></div><button className="modal-close" onClick={this.closeGroupModal}>×</button></div>
          <div className="modal-body">
            <div className="form-group"><label className="form-label">Group name</label><input className="form-input" autoFocus value={draft.name} placeholder="Friday drop" onChange={event => this.setState({ groupDraft: { ...draft, name: event.target.value } })} /></div>
            <div className="form-group"><label className="form-label">Target SKUs or product URLs</label><textarea className="form-input group-sku-input" value={draft.skus} placeholder={'12345678\nhttps://www.target.com/p/example/-/A-87654321'} onChange={event => this.setState({ groupDraft: { ...draft, skus: event.target.value } })} /><div className="form-hint">One per line or comma-separated. The existing engine receives the same parsed TCIN list as the legacy Target page.</div></div>
            <div className="form-row">
              <div className="form-group"><label className="form-label">Quantity per SKU</label><input className="form-input" type="number" min="1" max="99" value={draft.qty} onChange={event => this.setState({ groupDraft: { ...draft, qty: event.target.value } })} /></div>
              <div className="form-group"><label className="form-label">Default proxy group</label><select className="form-select" value={draft.proxyListName} onChange={event => this.setState({ groupDraft: { ...draft, proxyListName: event.target.value } })}><option value="">Local</option>{this.proxyLists().map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}</select></div>
            </div>
          </div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={this.closeGroupModal}>Cancel</button><button className="btn btn-primary" disabled={!String(draft.name || '').trim()} onClick={this.saveGroup}><Icon name="check" size={12} /> {editing ? 'Save Changes' : 'Create Group'}</button></div>
        </div>
      </div>
    );
  }

  renderTaskModal(group) {
    if (!this.state.showTaskModal) return null;
    const used = new Set((group.tasks || []).map(task => String(task.accountId)));
    const accounts = this.targetAccounts();
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.setState({ showTaskModal: false })}>
        <div className="modal task-create-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header"><div><div className="modal-title">Add Account Tasks</div><p>Select one or more Target accounts for “{group.name}”.</p></div><button className="modal-close" onClick={() => this.setState({ showTaskModal: false })}>×</button></div>
          <div className="modal-body">
            <div className="task-create-summary"><span><Icon name="user" size={14} /> {this.state.selectedAccounts.length} selected</span><strong>{accounts.length} Target accounts</strong></div>
            <div className="form-group"><label className="form-label">Proxy group for new tasks</label><select className="form-select" value={this.state.taskProxy} onChange={event => this.setState({ taskProxy: event.target.value })}><option value="">Local</option>{this.proxyLists().map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}</select></div>
            <div className="form-label">Accounts</div>
            <div className="task-account-picker">
              {!accounts.length && <div className="task-account-empty">No accounts are tagged Target. Add them from Accounts first.</div>}
              {accounts.map(account => {
                const selected = this.state.selectedAccounts.includes(account.id);
                const alreadyUsed = used.has(String(account.id));
                const profile = this.profileForAccount(account.id);
                return (
                  <button type="button" className={selected ? 'selected' : ''} disabled={alreadyUsed} key={account.id} onClick={() => this.toggleAccount(account.id)}>
                    <input type="checkbox" readOnly checked={selected} disabled={alreadyUsed} />
                    <span><strong>{account.email || account.username || account.id}</strong><small className={profile ? '' : 'text-danger'}>{alreadyUsed ? 'Already in this group' : profile ? 'Matching profile ready' : 'Missing matching profile'}</small></span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="modal-footer"><button className="btn btn-secondary" onClick={() => this.setState({ showTaskModal: false })}>Cancel</button><button className="btn btn-primary" disabled={!this.state.selectedAccounts.length} onClick={this.createTasks}><Icon name="plus" size={12} /> Add {this.state.selectedAccounts.length || ''} Task{this.state.selectedAccounts.length === 1 ? '' : 's'}</button></div>
        </div>
      </div>
    );
  }

  render() {
    if (!this.state.loaded) return <div className="task-workspace-loading"><Icon name="activity" size={20} /> Loading task groups…</div>;
    const group = this.selectedGroup();
    return group ? this.renderGroup(group) : this.renderOverview();
  }
}

export default connect(state => ({
  accounts: state.accounts,
  profiles: state.profiles,
  proxies: state.proxies,
  settings: state.settings,
  target: state.target,
}))(TaskGroups);
