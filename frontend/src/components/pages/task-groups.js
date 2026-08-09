import React, { Component, createRef } from 'react';
import { connect } from 'react-redux';
import Icon from '../icon';
import { proxyLabel, proxyLabelForRef, proxyRef } from '../proxy-options';
import { sameTargetBank, targetBankPresentation } from '../target-bank-metrics.mjs';
import {
  buildScheduleFromDraft,
  draftFromSchedule,
  emptyScheduleDraft,
  formatLocalTime,
  normalizeSchedule,
  scheduleDetailLine,
  scheduleSummary,
} from '../task-group-schedule.mjs';

const { ipcRenderer, clipboard } = window.require('electron');

const EMPTY_GROUP = Object.freeze({
  name: '',
  skus: '',
  qty: 2,
  proxyListName: '',
});

const EMPTY_HARVESTER = Object.freeze({
  name: '',
  type: 'atc',
  atcMode: 'v1',
  browser: 'auto',
  proxyListName: '',
  workers: '1',
  input: '',
  cookieTtlSec: '600',
  intervalDelaySec: '10',
  startSchedule: '',
  stopSchedule: '',
  enabled: true,
});

const HARVESTER_BROWSERS = [
  ['auto', 'Automatic pool'],
  ['chrome', 'Chrome'],
  ['msedge', 'Microsoft Edge'],
  ['brave', 'Brave'],
  ['vivaldi', 'Vivaldi'],
  ['yandex', 'Yandex'],
  ['chromium', 'Bundled Chromium'],
];

const HARVESTER_DRAWER_STORAGE_KEY = 'zyn.targetHarvesterDrawer';
const initialHarvesterDrawerOpen = () => {
  try { return window.localStorage.getItem(HARVESTER_DRAWER_STORAGE_KEY) === 'open'; } catch { return false; }
};

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const siteOf = account => String((account && account.site) || '').toLowerCase();
const normalizeCookieBankSize = value => String(value == null ? '' : value).replace(/\D/g, '').slice(0, 4);
const clampInteger = (value, minimum, maximum, fallback) => {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};
const localDateTimeValue = value => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
const isoDateTimeValue = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
};
const normalizeHarvester = (raw, index = 0) => {
  const type = ['login', 'atc', 'auto'].includes(raw && raw.type) ? raw.type : 'auto';
  return {
    id: String((raw && raw.id) || uid('harvester')),
    name: String((raw && raw.name) || `Harvester ${index + 1}`),
    type,
    atcMode: raw && raw.atcMode === 'v2' ? 'v2' : 'v1',
    browser: HARVESTER_BROWSERS.some(([value]) => value === (raw && raw.browser)) ? raw.browser : 'auto',
    proxyListName: String((raw && raw.proxyListName) || ''),
    workers: type === 'login' ? 1 : clampInteger(raw && raw.workers, 1, 100, 1),
    input: String((raw && raw.input) || ''),
    cookieTtlSec: clampInteger(raw && raw.cookieTtlSec, 30, 86400, 600),
    intervalDelaySec: clampInteger(raw && raw.intervalDelaySec, 0, 3600, 10),
    startSchedule: String((raw && raw.startSchedule) || ''),
    stopSchedule: String((raw && raw.stopSchedule) || ''),
    enabled: !!(raw && raw.enabled),
  };
};
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
  taskLogBox = createRef();

  state = {
    loaded: false,
    groups: [],
    selectedGroupId: '',
    selectedTaskId: '',
    groupFilter: '',
    taskFilter: '',
    showGroupModal: false,
    editingGroupId: '',
    groupDraft: { ...EMPTY_GROUP },
    showScheduleModal: false,
    scheduleDraft: emptyScheduleDraft(),
    scheduleError: '',
    scheduleNow: Date.now(),
    showTaskModal: false,
    selectedAccounts: [],
    taskProxy: '',
    copiedEngine: false,
    copiedTask: false,
    bank: null,
    bankCheckedAt: 0,
    brokerStartRequestedAt: 0,
    cookieBankSize: '',
    harvesters: [],
    harvesterDrawerOpen: initialHarvesterDrawerOpen(),
    showHarvesterModal: false,
    editingHarvesterId: '',
    harvesterDraft: { ...EMPTY_HARVESTER },
    throttleFallbackGroup: 'Local',
  };

  componentDidMount() {
    this.loadGroups();
    this.pollBank();
    this.bankTimer = setInterval(this.pollBank, 5000);
    this.scheduleClockTimer = setInterval(() => this.setState({ scheduleNow: Date.now() }), 30000);
    this.onTaskGroupSchedule = () => this.loadGroups();
    ipcRenderer.on('taskGroupSchedule', this.onTaskGroupSchedule);
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
    const taskId = this.state.selectedTaskId;
    const previousTaskLogs = ((prevProps.target && prevProps.target.taskLogs) || {})[taskId] || [];
    const currentTaskLogs = ((this.props.target && this.props.target.taskLogs) || {})[taskId] || [];
    if (previousTaskLogs.length !== currentTaskLogs.length && this.taskLogBox.current) {
      const element = this.taskLogBox.current;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 96) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }

  componentWillUnmount() {
    clearInterval(this.bankTimer);
    clearInterval(this.scheduleClockTimer);
    try { ipcRenderer.removeListener('taskGroupSchedule', this.onTaskGroupSchedule); } catch {}
  }

  loadGroups = () => {
    let groups = [];
    let cookieBankSize = '';
    let harvesters = [];
    let throttleFallbackGroup = 'Local';
    let migratedSettings = null;
    try { groups = ipcRenderer.sendSync('getTaskGroups') || []; } catch {}
    try {
      const settings = ipcRenderer.sendSync('getSettings') || {};
      cookieBankSize = normalizeCookieBankSize(settings.targetCookieBank);
      if (Array.isArray(settings.targetHarvesters)) {
        harvesters = settings.targetHarvesters.map(normalizeHarvester);
      } else {
        // One-time migration from the single global selector. It starts enabled so existing users
        // still have a farmer after upgrading, while every field is now editable independently.
        const proxyListName = typeof settings.targetHarvesterProxyList === 'string'
          ? settings.targetHarvesterProxyList : '';
        const workers = clampInteger(settings.targetHarvestWorkers, 1, 100, proxyListName ? 4 : 1);
        harvesters = [normalizeHarvester({
          id: uid('harvester'),
          name: 'Default Harvester',
          type: 'auto',
          atcMode: 'v1',
          browser: 'auto',
          proxyListName,
          workers,
          input: settings.targetAtcHarvestTcins || settings.targetAtcHarvestTcin || '',
          cookieTtlSec: settings.targetCookieTtlSec || 600,
          intervalDelaySec: 10,
          enabled: true,
        })];
        migratedSettings = { ...settings, targetHarvesters: harvesters };
        ipcRenderer.sendSync('saveSettings', migratedSettings);
      }
      if (typeof settings.targetThrottleFallbackGroup === 'string'
        && settings.targetThrottleFallbackGroup.trim()) {
        throttleFallbackGroup = settings.targetThrottleFallbackGroup;
      }
    } catch {}
    if (migratedSettings) {
      this.props.dispatch({ type: 'update', obj: { settings: migratedSettings } });
      try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
    }
    this.setState(({ selectedGroupId, selectedTaskId }) => ({
      groups,
      loaded: true,
      cookieBankSize,
      harvesters,
      throttleFallbackGroup,
      selectedGroupId: groups.some(group => group.id === selectedGroupId) ? selectedGroupId : '',
      selectedTaskId: groups.some(group => (group.tasks || []).some(task => task.id === selectedTaskId))
        ? selectedTaskId : '',
    }));
  };

  pollBank = () => {
    ipcRenderer.invoke('targetCookieBank')
      .then(bank => this.setState(previous => {
        const checkedAt = Date.now();
        return {
          bank: sameTargetBank(previous.bank, bank) ? previous.bank : bank,
          bankCheckedAt: checkedAt,
          brokerStartRequestedAt: bank ? 0 : previous.brokerStartRequestedAt,
        };
      }))
      .catch(() => this.setState({ bank: null, bankCheckedAt: Date.now() }));
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

  saveTargetSetting = (key, value) => {
    let settings = this.props.settings || {};
    try { settings = ipcRenderer.sendSync('getSettings') || settings; } catch {}
    const next = { ...settings, [key]: value };
    try { ipcRenderer.sendSync('saveSettings', next); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings: next } });
    if (key === 'targetThrottleFallbackGroup') this.setState({ throttleFallbackGroup: value });
  };

  persistHarvesters = (harvesters, callback) => {
    const normalized = harvesters.map(normalizeHarvester);
    const requestedAt = Date.now();
    const expectsBroker = targetBankPresentation(null, normalized, { now: requestedAt }).activeHarvesters > 0;
    let settings = this.props.settings || {};
    try { settings = ipcRenderer.sendSync('getSettings') || settings; } catch {}
    const first = normalized[0] || null;
    const next = {
      ...settings,
      targetHarvesters: normalized,
      // Keep the legacy keys synchronized so cloud backups remain readable by the previous build.
      targetHarvesterProxyList: first ? first.proxyListName : '',
      targetHarvestWorkers: first ? String(first.workers) : '',
    };
    try { ipcRenderer.sendSync('saveSettings', next); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings: next } });
    this.setState(previous => ({
      harvesters: normalized,
      brokerStartRequestedAt: expectsBroker && !previous.bank
        ? previous.brokerStartRequestedAt || requestedAt
        : 0,
    }), () => {
      try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
      if (callback) callback();
    });
  };

  openNewHarvester = () => this.setState({
    showHarvesterModal: true,
    editingHarvesterId: '',
    harvesterDraft: { ...EMPTY_HARVESTER },
  });

  openEditHarvester = harvester => this.setState({
    showHarvesterModal: true,
    editingHarvesterId: harvester.id,
    harvesterDraft: {
      ...harvester,
      workers: String(harvester.workers),
      cookieTtlSec: String(harvester.cookieTtlSec),
      intervalDelaySec: String(harvester.intervalDelaySec),
      startSchedule: localDateTimeValue(harvester.startSchedule),
      stopSchedule: localDateTimeValue(harvester.stopSchedule),
    },
  });

  closeHarvesterModal = () => this.setState({
    showHarvesterModal: false,
    editingHarvesterId: '',
  });

  setHarvesterDrawerOpen = open => {
    try { window.localStorage.setItem(HARVESTER_DRAWER_STORAGE_KEY, open ? 'open' : 'closed'); } catch {}
    this.setState({ harvesterDrawerOpen: open });
  };

  saveHarvester = () => {
    const draft = this.state.harvesterDraft;
    const name = String(draft.name || '').trim();
    if (!name) return;
    const startSchedule = isoDateTimeValue(draft.startSchedule);
    const stopSchedule = isoDateTimeValue(draft.stopSchedule);
    if (startSchedule && stopSchedule && Date.parse(stopSchedule) <= Date.parse(startSchedule)) {
      window.alert('Stop Schedule must be later than Start Schedule.');
      return;
    }
    const requestedWorkers = draft.type === 'login'
      ? 1 : clampInteger(draft.workers, 1, 100, 1);
    const harvester = normalizeHarvester({
      ...draft,
      id: this.state.editingHarvesterId || uid('harvester'),
      name,
      workers: draft.proxyListName ? requestedWorkers : Math.min(2, requestedWorkers),
      cookieTtlSec: clampInteger(draft.cookieTtlSec, 30, 86400, 600),
      intervalDelaySec: clampInteger(draft.intervalDelaySec, 0, 3600, 10),
      startSchedule,
      stopSchedule,
    });
    const harvesters = this.state.editingHarvesterId
      ? this.state.harvesters.map(item => item.id === this.state.editingHarvesterId ? harvester : item)
      : [...this.state.harvesters, harvester];
    this.persistHarvesters(harvesters, this.closeHarvesterModal);
  };

  toggleHarvester = harvester => {
    const harvesters = this.state.harvesters.map(item => item.id === harvester.id
      ? { ...item, enabled: !item.enabled } : item);
    this.persistHarvesters(harvesters);
  };

  deleteHarvester = harvester => {
    if (!window.confirm(`Delete “${harvester.name}”? Its cookies already in the shared bank will remain until they expire.`)) return;
    this.persistHarvesters(this.state.harvesters.filter(item => item.id !== harvester.id));
  };

  profileList = () => {
    const value = this.props.profiles || [];
    return (value.list || value.profiles || (Array.isArray(value) ? value : []))
      .filter(profile => profile && profile.profileType !== 'pokemoncenter');
  };

  targetAccounts = () => (this.props.accounts || []).filter(account => siteOf(account) === 'target');
  proxyLists = () => ((this.props.proxies && this.props.proxies.lists) || []);
  selectedGroup = () => this.state.groups.find(group => group.id === this.state.selectedGroupId);
  selectedTask = group => (group && (group.tasks || []).find(task => task.id === this.state.selectedTaskId));
  statusFor = task => (this.props.target.taskStatus || {})[task.id];
  proxyStatusFor = task => {
    const status = (this.props.target.proxyStatus || {})[task.id];
    return status && !status.hidden ? status : null;
  };
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

  setScheduleDraft = patch => this.setState(previous => ({
    scheduleDraft: { ...previous.scheduleDraft, ...patch },
    scheduleError: '',
  }));

  openSchedule = group => this.setState({
    showScheduleModal: true,
    scheduleDraft: draftFromSchedule(group.schedule),
    scheduleError: '',
    scheduleNow: Date.now(),
  });

  closeSchedule = () => this.setState({ showScheduleModal: false, scheduleError: '' });

  saveSchedule = group => {
    const built = buildScheduleFromDraft(this.state.scheduleDraft);
    if (built.error) {
      this.setState({ scheduleError: built.error });
      return;
    }
    const groups = this.state.groups.map(candidate => {
      if (candidate.id !== group.id) return candidate;
      if (!built.schedule) {
        const { schedule: _schedule, ...rest } = candidate;
        return { ...rest, updatedAt: Date.now() };
      }
      return { ...candidate, schedule: built.schedule, updatedAt: Date.now() };
    });
    this.persist(groups, () => this.setState({
      showScheduleModal: false,
      scheduleDraft: draftFromSchedule(built.schedule),
      scheduleError: '',
      scheduleNow: Date.now(),
    }));
  };

  clearSchedule = group => {
    if (!normalizeSchedule(group.schedule)) {
      this.setState({ showScheduleModal: false, scheduleDraft: emptyScheduleDraft(), scheduleError: '' });
      return;
    }
    if (!window.confirm(`Clear the schedule for “${group.name}”?`)) return;
    const groups = this.state.groups.map(candidate => {
      if (candidate.id !== group.id) return candidate;
      const { schedule: _schedule, ...rest } = candidate;
      return { ...rest, updatedAt: Date.now() };
    });
    this.persist(groups, () => this.setState({
      showScheduleModal: false,
      scheduleDraft: emptyScheduleDraft(),
      scheduleError: '',
    }));
  };

  saveGroup = () => {
    const draft = this.state.groupDraft;
    const name = String(draft.name || '').trim();
    if (!name) return;
    const now = Date.now();
    let selectedGroupId = this.state.editingGroupId;
    const previousGroup = selectedGroupId
      ? this.state.groups.find(group => group.id === selectedGroupId)
      : null;
    const nextSkus = parseSkus(draft.skus);
    const previousSkus = parseSkus(previousGroup && previousGroup.skus);
    const liveTasks = previousGroup
      ? (previousGroup.tasks || []).filter(task => statusKind(this.statusFor(task)) === 'running')
      : [];
    const liveWatchChanged = !!previousGroup && (
      previousSkus.join(',') !== nextSkus.join(',')
      || String(previousGroup.qty || 2) !== String(draft.qty || 2)
    );
    if (liveWatchChanged && liveTasks.length && !nextSkus.length) {
      window.alert('A running group must keep at least one valid Target SKU. Stop the tasks before clearing the watch list.');
      return;
    }
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
    this.persist(groups, () => {
      let liveEditError = '';
      if (liveWatchChanged && liveTasks.length) {
        try {
          const result = ipcRenderer.sendSync('editTargetTasks', {
            tasks: liveTasks,
            skus: nextSkus,
            qty: draft.qty || 2,
          });
          if (!result || result.ok !== true || result.updated < 1) {
            liveEditError = (result && result.error) || 'The native engine did not accept the live watch-list update.';
          }
        } catch (error) {
          liveEditError = (error && error.message) || 'The live watch-list update failed.';
        }
      }
      this.setState({
        selectedGroupId,
        showGroupModal: false,
        editingGroupId: '',
      }, () => {
        if (liveEditError) {
          window.alert(`The group was saved, but its running tasks were not updated. Stop and restart them to apply the new SKUs.\n\n${liveEditError}`);
        }
      });
    });
  };

  deleteGroup = (group) => {
    if (!window.confirm(`Delete “${group.name}” and its ${(group.tasks || []).length} task(s)?\n\nThe legacy Target workspace is not affected.`)) return;
    for (const task of (group.tasks || [])) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    }
    this.persist(this.state.groups.filter(item => item.id !== group.id), () => {
      if (this.state.selectedGroupId === group.id) this.setState({ selectedGroupId: '', selectedTaskId: '' });
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
    try {
      if (ipcRenderer.sendSync('setTargetTaskProxy', task.id, proxyListName)) {
        this.props.dispatch({
          type: 'targetProxyEditSent', taskId: task.id, at: Date.now(),
          group: String(proxyListName || '').trim() || 'Local',
        });
      }
    } catch {}
  };

  deleteTask = (group, task) => {
    if (!window.confirm(`Delete the task for “${this.accountLabel(task)}” from “${group.name}”?`)) return;
    try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.filter(candidate => candidate.id !== task.id),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups, () => {
      if (this.state.selectedTaskId === task.id) this.setState({ selectedTaskId: '' });
    });
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
    if (config) {
      this.setState({ brokerStartRequestedAt: Date.now(), bankCheckedAt: Date.now() });
      ipcRenderer.send('startTarget', config);
    }
  };

  stopTasks = (tasks) => {
    const runningBefore = this.allStats().running;
    const stopping = tasks.filter(task => statusKind(this.statusFor(task)) === 'running').length;
    for (const task of tasks) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    }
    if (!runningBefore || stopping >= runningBefore) this.setState({ brokerStartRequestedAt: 0 });
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

  copyTaskLogs = (task) => {
    const logs = (((this.props.target || {}).taskLogs || {})[task.id]) || [];
    if (!logs.length) return;
    try { clipboard.writeText(logs.join('\n')); } catch {}
    this.setState({ copiedTask: true }, () => {
      setTimeout(() => this.setState({ copiedTask: false }), 1200);
    });
  };

  clearTaskLogs = (task) => {
    const taskLogs = (this.props.target && this.props.target.taskLogs) || {};
    const logs = taskLogs[task.id] || [];
    if (!logs.length || !window.confirm(`Clear the log for “${this.accountLabel(task)}”?`)) return;
    this.props.dispatch({ type: 'targetSet', obj: { taskLogs: { ...taskLogs, [task.id]: [] } } });
  };

  renderScheduleChip(group, now = this.state.scheduleNow) {
    const summary = scheduleSummary(group.schedule, now);
    if (!summary) return null;
    return (
      <span className="group-schedule-chip" title={scheduleDetailLine(group.schedule)}>
        <Icon name="activity" size={11} /> {summary}
      </span>
    );
  }

  renderScheduleModal(group) {
    if (!this.state.showScheduleModal) return null;
    const draft = this.state.scheduleDraft || emptyScheduleDraft();
    const preview = buildScheduleFromDraft(draft);
    const armed = normalizeSchedule(group.schedule);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeSchedule()}>
        <div className="modal group-schedule-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div>
              <div className="modal-title">Schedule “{group.name}”</div>
              <p>{armed ? scheduleSummary(armed, this.state.scheduleNow) : 'Off — Zyn must stay open for timers to fire'}</p>
            </div>
            <button className="modal-close" onClick={this.closeSchedule}>×</button>
          </div>
          <div className="modal-body group-schedule-body">
            <p className="group-schedule-help">
              Start and/or stop this Target group at a local clock time or after a delay. Keep the Mac awake during drop windows.
            </p>
            <div className="group-schedule-grid">
              <div className="group-schedule-leg">
                <label className="form-label">Start group</label>
                <div className="group-schedule-modes">
                  {['off', 'at', 'in'].map(mode => (
                    <label key={`start-${mode}`} className={draft.startMode === mode ? 'active' : ''}>
                      <input type="radio" name="schedule-start" checked={draft.startMode === mode} onChange={() => this.setScheduleDraft({ startMode: mode })} />
                      {mode === 'off' ? 'Off' : mode === 'at' ? 'At time' : 'In…'}
                    </label>
                  ))}
                </div>
                {draft.startMode === 'at' && (
                  <input className="form-input" type="time" value={draft.startTime} onChange={event => this.setScheduleDraft({ startTime: event.target.value })} />
                )}
                {draft.startMode === 'in' && (
                  <div className="group-schedule-interval">
                    <input className="form-input" type="number" min="1" step="1" value={draft.startAmount} onChange={event => this.setScheduleDraft({ startAmount: event.target.value })} />
                    <select className="form-select" value={draft.startUnit} onChange={event => this.setScheduleDraft({ startUnit: event.target.value })}>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="group-schedule-leg">
                <label className="form-label">Stop group</label>
                <div className="group-schedule-modes">
                  {['off', 'at', 'in'].map(mode => (
                    <label key={`stop-${mode}`} className={draft.stopMode === mode ? 'active' : ''}>
                      <input type="radio" name="schedule-stop" checked={draft.stopMode === mode} onChange={() => this.setScheduleDraft({ stopMode: mode })} />
                      {mode === 'off' ? 'Off' : mode === 'at' ? 'At time' : 'In…'}
                    </label>
                  ))}
                </div>
                {draft.stopMode === 'at' && (
                  <input className="form-input" type="time" value={draft.stopTime} onChange={event => this.setScheduleDraft({ stopTime: event.target.value })} />
                )}
                {draft.stopMode === 'in' && (
                  <div className="group-schedule-interval">
                    <input className="form-input" type="number" min="1" step="1" value={draft.stopAmount} onChange={event => this.setScheduleDraft({ stopAmount: event.target.value })} />
                    <select className="form-select" value={draft.stopUnit} onChange={event => this.setScheduleDraft({ stopUnit: event.target.value })}>
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                    </select>
                  </div>
                )}
              </div>
            </div>
            <div className="group-schedule-preview">
              {preview.error ? <span className="text-danger">{preview.error}</span> : preview.schedule ? (
                <span>
                  {preview.schedule.startAt != null && <>Starts <strong>{formatLocalTime(preview.schedule.startAt)}</strong></>}
                  {preview.schedule.startAt != null && preview.schedule.stopAt != null && ' · '}
                  {preview.schedule.stopAt != null && <>Stops <strong>{formatLocalTime(preview.schedule.stopAt)}</strong></>}
                  {armed && scheduleDetailLine(armed) !== scheduleDetailLine(preview.schedule) && <em> — not saved yet</em>}
                </span>
              ) : <span className="text-muted">No start or stop selected</span>}
              {this.state.scheduleError && <span className="text-danger"> {this.state.scheduleError}</span>}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary group-schedule-clear" onClick={() => this.clearSchedule(group)} disabled={!armed}>Clear schedule</button>
            <button className="btn btn-secondary" onClick={this.closeSchedule}>Cancel</button>
            <button className="btn btn-primary" onClick={() => this.saveSchedule(group)}><Icon name="activity" size={13} /> Save Schedule</button>
          </div>
        </div>
      </div>
    );
  }

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

  renderCookieBank() {
    const bank = this.state.bank;
    const presentation = targetBankPresentation(bank, this.state.harvesters, {
      now: this.state.bankCheckedAt || Date.now(),
      brokerStartRequestedAt: this.state.brokerStartRequestedAt,
      checkoutRunning: this.allStats().running > 0,
    });

    return (
      <section className={`cookie-bank cookie-bank-prominent cookie-bank-${presentation.state}`} title={presentation.description} aria-label="Shared Target cookie bank">
        <span className="cookie-bank-icon"><Icon name="cookie" size={18} /></span>
        <span className="cookie-bank-copy">
          <small>Shared Cookie Bank</small>
          <strong>{presentation.label}</strong>
          <em>{presentation.description}</em>
        </span>
        <span className="cookie-bank-counts">
          <span><strong>{presentation.login}</strong><small>Login</small></span>
          <span><strong>{presentation.atc}</strong><small>ATC</small></span>
        </span>
        <label
          className="cookie-bank-limit"
          title="Maximum cookies of each type to keep in the shared bank. Blank or 0 means no limit. Changes apply on the next start."
        >
          <span>Per-type limit</span>
          <input
            type="text"
            inputMode="numeric"
            value={this.state.cookieBankSize}
            placeholder="Unlimited"
            aria-label="Target cookie bank maximum size"
            onChange={event => this.setState({ cookieBankSize: normalizeCookieBankSize(event.target.value) })}
            onBlur={this.saveCookieBankSize}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          <small>Next start</small>
        </label>
        <span className="cookie-bank-broker"><i />{presentation.brokerLabel}</span>
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

  renderTargetProxyControls() {
    const proxyLists = this.proxyLists();
    return (
      <section className="panel target-global-proxy-controls" aria-label="Global Target proxy routing">
        <div className="target-global-proxy-heading">
          <span className="target-global-proxy-icon"><Icon name="target" size={16} /></span>
          <span><strong>Global Target routing</strong><small>Shared by every task group</small></span>
        </div>
        <label className="target-global-proxy-field" title="After carting, a checkout that is rate limited switches once to this route.">
          <span><strong>FALLBACK</strong><small>Rate-limited checkout route · carted tasks</small></span>
          <select
            className="form-select"
            aria-label="Target checkout fallback proxy group"
            value={this.state.throttleFallbackGroup}
            onChange={event => this.saveTargetSetting('targetThrottleFallbackGroup', event.target.value)}
          >
            <option value="Local">Local (no proxy)</option>
            {proxyLists.map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
          </select>
        </label>
      </section>
    );
  }

  harvesterRuntimeFor = id => {
    const list = (this.state.bank && Array.isArray(this.state.bank.harvesters))
      ? this.state.bank.harvesters : [];
    return list.find(item => String(item.id) === String(id)) || null;
  };

  harvesterState = (harvester, runtime) => {
    if (!harvester.enabled) return { kind: 'idle', label: 'Stopped' };
    const now = Date.now();
    const startsAt = harvester.startSchedule ? Date.parse(harvester.startSchedule) : NaN;
    const stopsAt = harvester.stopSchedule ? Date.parse(harvester.stopSchedule) : NaN;
    if (Number.isFinite(startsAt) && now < startsAt) return { kind: 'idle', label: 'Scheduled' };
    if (Number.isFinite(stopsAt) && now >= stopsAt) return { kind: 'idle', label: 'Schedule ended' };
    if (!runtime) return { kind: 'running', label: 'Starting' };
    return (Number(runtime.activeWorkers) || 0) > 0
      ? { kind: 'running', label: 'Running' }
      : { kind: 'running', label: 'Detecting browsers' };
  };

  harvesterLastSuccess = runtime => {
    const timestamp = Number(runtime && runtime.lastSuccessAt) || 0;
    if (!timestamp) return 'No cookies yet';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  };

  renderHarvesterDrawer() {
    const bank = targetBankPresentation(this.state.bank, this.state.harvesters, {
      now: this.state.bankCheckedAt || Date.now(),
      brokerStartRequestedAt: this.state.brokerStartRequestedAt,
      checkoutRunning: this.allStats().running > 0,
    });
    const total = this.state.harvesters.length;
    const open = this.state.harvesterDrawerOpen;
    const railStatusLabel = {
      ready: 'Ready',
      working: 'Active',
      scheduled: 'Queued',
      starting: 'Starting',
      error: 'Error',
      offline: 'Offline',
      stopped: 'Stopped',
    }[bank.state] || bank.label;
    const drawerTitle = `${bank.activeHarvesters} of ${total} harvester${total === 1 ? '' : 's'} running · ${bank.login} login · ${bank.atc} ATC`;
    const list = !total ? (
      <div className="target-harvester-empty">
        <Icon name="cookie" size={20} />
        <span>No harvesters configured</span>
        <small>Create a Login, ATC, or Automatic harvester to feed the shared bank.</small>
      </div>
    ) : (
      <div className="target-harvester-list">
        {this.state.harvesters.map(harvester => {
          const runtime = this.harvesterRuntimeFor(harvester.id);
          const state = this.harvesterState(harvester, runtime);
          const produced = (runtime && runtime.produced) || {};
          const workerValue = state.kind === 'running'
            ? `${runtime ? Number(runtime.activeWorkers) || 0 : 0}/${harvester.workers}`
            : `${harvester.workers} configured`;
          const browser = (HARVESTER_BROWSERS.find(([value]) => value === harvester.browser) || [null, harvester.browser])[1];
          const atcModeLabel = harvester.atcMode === 'v2' ? 'ATC+' : 'ATC';
          const typeLabel = harvester.type === 'atc' ? `Target ${atcModeLabel}`
            : harvester.type === 'login' ? 'Target Login' : `Automatic (${atcModeLabel})`;
          const schedule = harvester.startSchedule || harvester.stopSchedule
            ? `${harvester.startSchedule ? new Date(harvester.startSchedule).toLocaleString() : 'Now'} → ${harvester.stopSchedule ? new Date(harvester.stopSchedule).toLocaleString() : 'No stop'}`
            : 'Always';
          return (
            <article className={`target-harvester-card target-harvester-card-${state.kind}`} key={harvester.id}>
              <div className="target-harvester-identity">
                <span className="target-harvester-state-dot" />
                <span><strong>{harvester.name}</strong><small>{typeLabel} · {proxyLabelForRef(this.proxyLists(), harvester.proxyListName, 'Local')}</small></span>
              </div>
              <div className="target-harvester-card-stat target-harvester-workers"><small>Workers</small><strong>{workerValue}</strong></div>
              <div className="target-harvester-card-stat target-harvester-produced"><small>Produced</small><strong>{Number(produced.login) || 0} login · {Number(produced.atc) || 0} ATC</strong></div>
              <div className="target-harvester-card-stat target-harvester-browser"><small>Browser / Last success</small><strong>{browser} · {this.harvesterLastSuccess(runtime)}</strong></div>
              <div className="target-harvester-card-stat target-harvester-schedule"><small>Schedule</small><strong title={schedule}>{schedule}</strong></div>
              <span className={`group-status group-status-${state.kind}`}><span className="group-status-dot" />{state.label}</span>
              <div className="target-harvester-actions">
                <button className={harvester.enabled ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'} onClick={() => this.toggleHarvester(harvester)}>
                  <Icon name={harvester.enabled ? 'stop' : 'play'} size={11} /> {harvester.enabled ? 'Stop' : 'Start'}
                </button>
                <button className="icon-action" title="Edit harvester" onClick={() => this.openEditHarvester(harvester)}><Icon name="settings" size={12} /></button>
                <button className="icon-action icon-action-danger" title="Delete harvester" onClick={() => this.deleteHarvester(harvester)}><Icon name="trash" size={12} /></button>
              </div>
            </article>
          );
        })}
      </div>
    );

    return (
      <>
        {!open && (
          <button
            type="button"
            className={`target-harvester-rail target-harvester-rail-${bank.state}`}
            title={`${drawerTitle}. Click to open Cookie Harvesters.`}
            aria-label={`Open Cookie Harvesters. ${drawerTitle}.`}
            aria-expanded="false"
            aria-controls="target-harvester-drawer"
            onClick={() => this.setHarvesterDrawerOpen(true)}
          >
            <span className="target-harvester-rail-icon"><Icon name="cookie" size={17} /></span>
            <span className="target-harvester-rail-state"><i /><small>{railStatusLabel}</small></span>
            <span className="target-harvester-rail-metric"><strong>{bank.activeHarvesters}/{total}</strong><small>Running</small></span>
            <span className="target-harvester-rail-divider" />
            <span className="target-harvester-rail-metric"><strong>{bank.login}</strong><small>Login</small></span>
            <span className="target-harvester-rail-metric"><strong>{bank.atc}</strong><small>ATC</small></span>
            <Icon name="chevronDown" size={13} className="target-harvester-rail-open-icon" />
          </button>
        )}
        {open && (
          <div className="target-harvester-drawer-layer" onMouseDown={event => {
            if (event.target === event.currentTarget) this.setHarvesterDrawerOpen(false);
          }}>
            <aside id="target-harvester-drawer" className="target-harvester-drawer" aria-label="Cookie Harvesters">
              <header className="target-harvester-drawer-head">
                <span className="target-harvester-drawer-icon"><Icon name="cookie" size={18} /></span>
                <span><h2>Cookie Harvesters</h2><p>Independent typed workers feed the shared Target bank.</p></span>
                <button className="icon-action" title="Close Cookie Harvesters" aria-label="Close Cookie Harvesters" onClick={() => this.setHarvesterDrawerOpen(false)}><Icon name="close" size={14} /></button>
              </header>
              <div className="target-harvester-drawer-summary" aria-label="Harvester progress">
                <span><strong>{bank.activeHarvesters}/{total}</strong><small>Running</small></span>
                <span><strong>{bank.activeWorkers}</strong><small>Active workers</small></span>
                <span><strong>{bank.login}</strong><small>Login banked</small></span>
                <span><strong>{bank.atc}</strong><small>ATC banked</small></span>
              </div>
              <div className="target-harvester-drawer-toolbar">
                <span className={`group-status group-status-${bank.state === 'ready' ? 'success' : bank.state === 'working' ? 'running' : bank.state === 'error' ? 'error' : 'idle'}`}>
                  <span className="group-status-dot" />{bank.label}
                </span>
                <button className="btn btn-primary btn-sm" onClick={this.openNewHarvester}><Icon name="plus" size={12} /> New Harvester</button>
              </div>
              <div className="target-harvester-drawer-content">{list}</div>
            </aside>
          </div>
        )}
      </>
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
          <span><h3>{group.name}</h3><p>Target task group</p>{this.renderScheduleChip(group)}</span>
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
      <div className="tasks-workspace tasks-workspace-with-harvester-dock">
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Task Groups</div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.props.history.push('/modules')}>All workspaces</button>
            <button className="btn btn-primary btn-sm" onClick={this.openNewGroup}><Icon name="plus" size={13} /> New Group</button>
          </div>
        </div>
        <div className="page-content task-groups-content">
          {this.renderTargetProxyControls()}
          {this.renderCookieBank()}
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
        {this.renderHarvesterDrawer()}
        {this.renderGroupModal()}
        {this.renderHarvesterModal()}
      </div>
    );
  }

  renderTaskRow(group, task) {
    const account = this.accountFor(task);
    const profile = this.profileForAccount(task.accountId);
    const status = this.statusFor(task);
    const displayStatus = this.proxyStatusFor(task) || status;
    const running = statusKind(status) === 'running';
    const initial = String((account && account.email) || '?').slice(0, 1).toUpperCase();
    return (
      <div
        className="group-task-row group-task-row-clickable"
        key={task.id}
        tabIndex="0"
        title="Open this task and its logs"
        onClick={() => this.setState({ selectedTaskId: task.id, copiedTask: false })}
        onKeyDown={event => {
          if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            this.setState({ selectedTaskId: task.id, copiedTask: false });
          }
        }}
      >
        <span className="task-primary"><i className="task-avatar">{initial}</i><span><strong>{this.accountLabel(task)}</strong><small>{task.id}</small></span></span>
        <span className={profile ? 'text-success' : 'text-danger'}>{profile ? 'Ready' : 'Missing profile'}</span>
        <select className="form-select task-proxy-select" value={task.proxyListName || ''} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onChange={event => this.updateTaskProxy(group, task, event.target.value)}>
          <option value="">Local</option>
          {this.proxyLists().map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
        </select>
        <StatusBadge status={displayStatus} />
        <span>{new Date(task.createdAt || group.createdAt).toLocaleDateString()}</span>
        <span className="task-row-actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
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

  renderTaskDetail(group, task) {
    const account = this.accountFor(task);
    const profile = this.profileForAccount(task.accountId);
    const status = this.statusFor(task);
    const displayStatus = this.proxyStatusFor(task) || status;
    const kind = statusKind(status);
    const running = kind === 'running';
    const logs = ((((this.props.target || {}).taskLogs) || {})[task.id]) || [];
    const accountName = this.accountLabel(task);
    const initial = String((account && account.email) || '?').slice(0, 1).toUpperCase();
    const profileName = profile
      ? profile.name || profile.email || profile.id
      : 'Missing matching profile';
    const statusLabel = (displayStatus && (displayStatus.label || displayStatus.state)) || STATUS_LABELS[kind];
    const statusDetail = (displayStatus && displayStatus.detail) || (running
      ? 'This task is running through the existing Target checkout engine.'
      : 'Start this task to see its checkout steps and diagnostic output here.');

    return (
      <div className="tasks-workspace tasks-workspace-with-harvester-dock">
        <div className="page-header task-view-header">
          <div>
            <div className="task-breadcrumbs">
              <button onClick={() => this.setState({ selectedGroupId: '', selectedTaskId: '', taskFilter: '' })}>Task Groups</button>
              <span>/</span>
              <button onClick={() => this.setState({ selectedTaskId: '', copiedTask: false })}>{group.name}</button>
              <span>/</span>
              <em>{accountName}</em>
            </div>
            <div className="page-title"><span className="page-title-dot" /> {accountName}</div>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selectedTaskId: '', copiedTask: false })}>Back to Group</button>
            {running ? (
              <button className="btn btn-danger btn-sm" onClick={() => this.stopTasks([task])}><Icon name="stop" size={12} /> Stop Task</button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => this.startTasks(group, [task])}><Icon name="play" size={12} /> Start Task</button>
            )}
          </div>
        </div>
        <div className="page-content task-detail-content">
          {this.renderTargetProxyControls()}
          <section className={`task-status-hero task-status-hero-${kind}`}>
            <span className="task-status-hero-icon"><i className="task-avatar task-avatar-lg">{initial}</i></span>
            <div><small>Current task status</small><h2>{statusLabel}</h2><p>{statusDetail}</p></div>
            <StatusBadge status={displayStatus} />
          </section>

          {this.renderCookieBank()}

          <div className="task-detail-grid">
            <section className="panel task-information">
              <div className="detail-panel-heading"><h3>Task Information</h3><span>{group.name}</span></div>
              <dl>
                <div><dt>Account</dt><dd>{accountName}</dd></div>
                <div><dt>Profile</dt><dd className={profile ? '' : 'text-danger'}>{profileName}</dd></div>
                <div><dt>Proxy</dt><dd>{proxyLabelForRef(this.proxyLists(), task.proxyListName, 'Local')}</dd></div>
                <div><dt>Watch list</dt><dd>{parseSkus(group.skus).length} SKU{parseSkus(group.skus).length === 1 ? '' : 's'} · qty {group.qty || 2}</dd></div>
                <div><dt>Created</dt><dd>{new Date(task.createdAt || group.createdAt).toLocaleString()}</dd></div>
                <div><dt>Task ID</dt><dd>{task.id}</dd></div>
              </dl>
            </section>
            <section className="panel task-log-panel task-own-log-panel">
              <div className="detail-panel-heading">
                <div><h3><Icon name="activity" size={13} /> Task Log</h3><span>{logs.length} line{logs.length === 1 ? '' : 's'} · only this task</span></div>
                <div className="page-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => this.copyTaskLogs(task)} disabled={!logs.length}>
                    <Icon name="copy" size={11} /> {this.state.copiedTask ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => this.clearTaskLogs(task)} disabled={!logs.length}>Clear</button>
                </div>
              </div>
              <div className="task-log-view" ref={this.taskLogBox}>
                {!logs.length ? (
                  <div className="task-log-empty">
                    <Icon name="activity" size={20} />
                    <span>No output from this task yet</span>
                    <small>Checkout steps tagged with this task ID will appear here. Broker, farmer, and monitor startup remain in the shared log below.</small>
                  </div>
                ) : logs.map((line, index) => (
                  <div key={index}><span>{String(index + 1).padStart(3, '0')}</span>{String(line)}</div>
                ))}
              </div>
            </section>
          </div>

          {this.renderSharedEngineLog()}
        </div>
        {this.renderHarvesterDrawer()}
        {this.renderHarvesterModal()}
      </div>
    );
  }

  renderGroup(group) {
    const stats = this.groupStats(group);
    const filter = this.state.taskFilter.trim().toLowerCase();
    const visibleTasks = (group.tasks || []).filter(task => !filter || this.accountLabel(task).toLowerCase().includes(filter));
    return (
      <div className="tasks-workspace tasks-workspace-with-harvester-dock">
        <div className="page-header task-view-header">
          <div>
            <button className="breadcrumb-back" onClick={() => this.setState({ selectedGroupId: '', selectedTaskId: '', taskFilter: '' })}><Icon name="chevronDown" size={11} /> Task Groups</button>
            <div className="page-title"><span className="page-title-dot" /> {group.name}{this.renderScheduleChip(group)}</div>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => this.openSchedule(group)}><Icon name="activity" size={12} /> Schedule</button>
            <button className="btn btn-secondary btn-sm" onClick={() => this.openEditGroup(group)}><Icon name="settings" size={12} /> Edit Group</button>
            {stats.running ? (
              <button className="btn btn-danger btn-sm" onClick={() => this.stopTasks(group.tasks)}><Icon name="stop" size={12} /> Stop All</button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => this.startTasks(group, group.tasks)}><Icon name="play" size={12} /> Start All</button>
            )}
          </div>
        </div>
        <div className="page-content task-group-dashboard">
          {this.renderTargetProxyControls()}
          {this.renderCookieBank()}
          <div className="panel group-config-strip group-config-strip-r2">
            <div><span>Site</span><strong><Icon name="target" size={12} /> Target</strong></div>
            <div><span>Tasks</span><strong>{stats.total}</strong></div>
            <div><span>Watch list</span><strong>{parseSkus(group.skus).length} SKU{parseSkus(group.skus).length === 1 ? '' : 's'} · qty {group.qty || 2}</strong></div>
            <div><span>Default proxy</span><strong>{proxyLabelForRef(this.proxyLists(), group.proxyListName, 'Local')}</strong></div>
          </div>
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
        </div>
        {this.renderHarvesterDrawer()}
        {this.renderScheduleModal(group)}
        {this.renderGroupModal()}
        {this.renderTaskModal(group)}
        {this.renderHarvesterModal()}
      </div>
    );
  }

  renderHarvesterModal() {
    if (!this.state.showHarvesterModal) return null;
    const draft = this.state.harvesterDraft;
    const editing = Boolean(this.state.editingHarvesterId);
    const setDraft = patch => this.setState({ harvesterDraft: { ...draft, ...patch } });
    const proxyMissing = draft.proxyListName
      && !this.proxyLists().some(list => proxyRef(list) === draft.proxyListName);
    const workerMaximum = draft.type === 'login' ? 1 : draft.proxyListName ? 100 : 2;
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeHarvesterModal()}>
        <div className="modal target-harvester-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">{editing ? 'Edit Cookie Harvester' : 'Create Cookie Harvester'}</div><p>Each harvester runs independently and contributes to the shared Target cookie bank.</p></div>
            <button className="modal-close" onClick={this.closeHarvesterModal}>×</button>
          </div>
          <div className="modal-body target-harvester-modal-body">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" autoFocus value={draft.name} placeholder="Home ATC" onChange={event => setDraft({ name: event.target.value })} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-select" value={draft.type} onChange={event => {
                  const type = event.target.value;
                  setDraft({ type, workers: type === 'login' ? '1' : draft.workers });
                }}>
                  <option value="atc">Target ATC</option>
                  <option value="login">Target Login</option>
                  <option value="auto">Automatic (Login + ATC)</option>
                </select>
                <div className="form-hint">Login uses a generated email and one worker. ATC uses the product rotation below.</div>
              </div>
              <div className="form-group">
                <label className="form-label">Browser</label>
                <select className="form-select" value={draft.browser} onChange={event => setDraft({ browser: event.target.value })}>
                  {HARVESTER_BROWSERS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
                <div className="form-hint">Automatic distributes workers across every detected browser.</div>
              </div>
            </div>
            {draft.type !== 'login' && (
              <div className="form-group">
                <label className="form-label">ATC mode</label>
                <select className="form-select" value={draft.atcMode} onChange={event => setDraft({ atcMode: event.target.value })}>
                  <option value="v1">Standard — Live Target product page</option>
                  <option value="v2">ATC+</option>
                </select>
              </div>
            )}
            {draft.type !== 'login' && (
              <div className="form-group">
                <label className="form-label">Harvest products</label>
                <textarea className="form-input target-harvester-input" value={draft.input} placeholder="Leave blank for the built-in Target product rotation, or paste TCINs / product links" onChange={event => setDraft({ input: event.target.value })} />
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Proxy</label>
                <select className="form-select" value={draft.proxyListName} onChange={event => {
                  const proxyListName = event.target.value;
                  const workers = proxyListName ? draft.workers : String(Math.min(2, clampInteger(draft.workers, 1, 100, 1)));
                  setDraft({ proxyListName, workers });
                }}>
                  <option value="">Local (no proxy)</option>
                  {proxyMissing && <option value={draft.proxyListName}>Unavailable: {draft.proxyListName}</option>}
                  {this.proxyLists().map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Workers</label>
                <input className="form-input" type="number" min="1" max={workerMaximum} disabled={draft.type === 'login'} value={draft.type === 'login' ? '1' : draft.workers} onChange={event => setDraft({ workers: event.target.value })} />
                <div className="form-hint">Local is capped at 2; proxy harvesters allow up to 100.</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Cookie expiration (seconds)</label>
                <input className="form-input" type="number" min="30" max="86400" value={draft.cookieTtlSec} onChange={event => setDraft({ cookieTtlSec: event.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Interval delay (seconds)</label>
                <input className="form-input" type="number" min="0" max="3600" value={draft.intervalDelaySec} onChange={event => setDraft({ intervalDelaySec: event.target.value })} />
                <div className="form-hint">Minimum pause after an attempt; health cooldowns may wait longer.</div>
              </div>
            </div>
            <div className="target-harvester-schedule-grid">
              <div className="form-group">
                <label className="form-label">Start Schedule</label>
                <input className="form-input" type="datetime-local" value={draft.startSchedule} onChange={event => setDraft({ startSchedule: event.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Stop Schedule</label>
                <input className="form-input" type="datetime-local" value={draft.stopSchedule} onChange={event => setDraft({ stopSchedule: event.target.value })} />
              </div>
            </div>
            <label className="target-harvester-enabled">
              <input type="checkbox" checked={draft.enabled !== false} onChange={event => setDraft({ enabled: event.target.checked })} />
              <span><strong>Start this harvester</strong><small>Future schedules wait until their start time. Zyn must remain open.</small></span>
            </label>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={this.closeHarvesterModal}>Cancel</button>
            <button className="btn btn-primary" disabled={!String(draft.name || '').trim()} onClick={this.saveHarvester}><Icon name="check" size={12} /> {editing ? 'Save Changes' : 'Create Harvester'}</button>
          </div>
        </div>
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
    if (!group) return this.renderOverview();
    const task = this.selectedTask(group);
    return task ? this.renderTaskDetail(group, task) : this.renderGroup(group);
  }
}

export default connect(state => ({
  accounts: state.accounts,
  profiles: state.profiles,
  proxies: state.proxies,
  settings: state.settings,
  target: state.target,
}))(TaskGroups);
