import React, { Component } from 'react';
import { connect } from 'react-redux';
import Icon from '../icon';
import { proxyFolderRef, proxyLabel, proxyLabelForRef, proxyRef } from '../proxy-options';
import {
  formatBandwidth,
  sameTargetBank,
  targetBandwidthSummary,
  targetBankPresentation,
} from '../target-bank-metrics.mjs';
import {
  TARGET_MONITOR_BANDWIDTH_TOOLTIP,
  targetMonitorBandwidthSummary,
} from '../target-monitor-bandwidth.mjs';
import {
  harvesterExtensionIdsFromSettings,
  hasHarvesterExtensionId,
} from '../harvester-extension-ids.mjs';
import {
  buildScheduleFromDraft,
  draftFromSchedule,
  emptyScheduleDraft,
  formatLocalTime,
  normalizeSchedule,
  scheduleDetailLine,
  scheduleSummary,
} from '../task-group-schedule.mjs';
import { targetStatusTone, targetTaskIsRunning } from '../target-task-status';
import { showOperatorLogs } from '../operator-logs';
import TargetOtpInput, { targetOtpForTask } from '../target-otp-input';
import VirtualLogView from '../virtual-log-view';
import VirtualList, { TASK_ROW_HEIGHT } from '../virtual-list';
import InlineSelect from '../inline-select';
import Store from '../store';
import {
  accountForTask,
  mapGroupRuntimeState,
  mapTaskDetailState,
  mapTaskRowState,
  profileForAccountId,
  profileListFrom,
  selectTargetWorkspaceRuntime,
} from '../target-task-runtime';

const { ipcRenderer, clipboard } = window.require('electron');

const EMPTY_GROUP = Object.freeze({
  name: '',
  skus: '',
  maxPrices: {},
  priorities: {},
  qty: 2,
  proxyListName: '',
  loopCheckout: false,
  useFillerItem: false,
  stockConfidence: 'any',
});

const EMPTY_HARVESTER = Object.freeze({
  name: '',
  type: 'atc',
  engine: 'playwright',
  atcMode: 'v1',
  browser: 'auto',
  proxyListName: '',
  workers: '1',
  input: '',
  cookieTtlSec: '600',
  intervalDelaySec: '10',
  startSchedule: '',
  stopSchedule: '',
  // Saving a new configuration must not be equivalent to clicking Start.
  enabled: false,
});

const HARVESTER_ENGINES = [
  ['playwright', 'Default'],
  ['patchright', 'Experimental'],
];
const harvesterEngineOf = raw => (raw === 'patchright' ? 'patchright' : 'playwright');
const harvesterModeLabel = engine => (engine === 'patchright' ? 'Experimental' : 'Default');
const harvesterWorkerMaximum = ({ type, engine, proxyListName }) => {
  if (type === 'login') return 1;
  if (engine === 'patchright') return proxyListName ? 8 : 2;
  return proxyListName ? 100 : 2;
};

const HARVESTER_BROWSERS = [
  ['auto', 'Automatic pool'],
  ['chrome', 'Chrome'],
  ['msedge', 'Microsoft Edge'],
  ['brave', 'Brave'],
  ['vivaldi', 'Vivaldi'],
  ['yandex', 'Yandex'],
  ['opera', 'Opera'],
  ['chromium', 'Bundled Chromium'],
];

const HARVESTER_DRAWER_STORAGE_KEY = 'zyn.targetHarvesterDrawer';
const initialHarvesterDrawerOpen = () => {
  try { return window.localStorage.getItem(HARVESTER_DRAWER_STORAGE_KEY) === 'open'; } catch { return false; }
};

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const siteOf = account => String((account && account.site) || '').toLowerCase();
const DEFAULT_ATC_COOKIES_PER_TASK = 3;
const MAX_ATC_COOKIES_PER_TASK = Number.MAX_SAFE_INTEGER;
const normalizeAtcCookiesPerTaskInput = value => String(value == null ? '' : value).replace(/\D/g, '');
const normalizeAtcCookiesPerTask = value => {
  const parsed = Number.parseInt(normalizeAtcCookiesPerTaskInput(value), 10);
  return String(Number.isFinite(parsed)
    ? Math.max(0, Math.min(MAX_ATC_COOKIES_PER_TASK, parsed))
    : DEFAULT_ATC_COOKIES_PER_TASK);
};
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
  const engine = harvesterEngineOf(raw && raw.engine);
  const proxyListName = String((raw && raw.proxyListName) || '');
  return {
    id: String((raw && raw.id) || uid('harvester')),
    name: String((raw && raw.name) || `Harvester ${index + 1}`),
    type,
    engine,
    atcMode: raw && raw.atcMode === 'v2' ? 'v2' : 'v1',
    browser: HARVESTER_BROWSERS.some(([value]) => value === (raw && raw.browser)) ? raw.browser : 'auto',
    proxyListName,
    workers: type === 'login' ? 1 : clampInteger(raw && raw.workers, 1, harvesterWorkerMaximum({ type, engine, proxyListName }), 1),
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
  return ((marker >= 0 ? value.slice(marker + 2) : value).match(/^\d{6,}/) || [])[0] || '';
}).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
const normalizeMaxPrice = value => {
  const text = String(value == null ? '' : value).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 && number <= 100000 ? number.toFixed(2) : null;
};
const watchedItemsForGroup = group => {
  const candidate = group && typeof group === 'object' ? group : {};
  const bySku = new Map();
  for (const item of (Array.isArray(candidate.items) ? candidate.items : [])) {
    const sku = parseSkus(item && typeof item === 'object'
      ? item.sku || item.tcin || item.monitorInput
      : item)[0];
    if (sku && !bySku.has(sku)) {
      bySku.set(sku, {
        sku,
        maxPrice: normalizeMaxPrice(item && typeof item === 'object' ? item.maxPrice : '') || '',
        priority: !!(item && typeof item === 'object' && item.priority === true),
      });
    }
  }
  for (const sku of parseSkus(candidate.skus)) {
    if (!bySku.has(sku)) bySku.set(sku, { sku, maxPrice: '', priority: false });
  }
  return [...bySku.values()];
};
const watchListSummary = group => {
  const items = watchedItemsForGroup(group);
  const priorityCount = items.filter(item => item.priority).length;
  const skuPart = `${items.length} SKU${items.length === 1 ? '' : 's'}`;
  const priorityPart = priorityCount ? ` · ${priorityCount} priority` : '';
  return `${skuPart}${priorityPart} · qty ${group.qty || 2}`;
};

const STATUS_LABELS = {
  idle: 'Idle',
  watching: 'Watching',
  carting: 'Carting',
  checkout: 'Checking out',
  submitting: 'Submitting order',
  success: 'Success',
  error: 'Attention',
};

function StatusBadge({ status }) {
  const tone = targetStatusTone(status);
  const label = (status && (status.label || status.state)) || STATUS_LABELS[tone];
  return (
    <span
      className={`group-status target-task-status target-task-status-${tone}`}
      title={String(label)}
      aria-label={`Task status: ${label}`}
    >
      <span className="group-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function liveTarget() {
  try { return (Store.getState().target) || {}; } catch { return {}; }
}

class TaskGroupTaskRowView extends Component {
  proxyStatusFor(task) {
    return this.props.proxyStatus || null;
  }

  render() {
    const { group, task, selected, host, account, profile, status, otpRequest, checkouts, declines, canReset } = this.props;
    const displayStatus = this.proxyStatusFor(task) || status;
    const running = targetTaskIsRunning(status);
    const initial = String((account && account.email) || '?').slice(0, 1).toUpperCase();
    return (
      <div
        className={`group-task-row group-task-row-clickable${selected ? ' selected' : ''}`}
        key={task.id}
        tabIndex="0"
        aria-label={`Open task for ${host.accountLabel(task)}`}
        onClick={() => host.openTask(task)}
        onKeyDown={event => {
          if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            host.openTask(task);
          }
        }}
      >
        <span className="task-select-cell" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${host.accountLabel(task)}`}
            onChange={() => host.toggleTaskSelected(task.id)}
          />
        </span>
        <span className={`task-primary${profile ? '' : ' task-primary-missing'}`} title={profile ? '' : 'No matching checkout profile'}>
          <i className="task-avatar">{initial}</i>
          <strong>{host.accountLabel(task)}</strong>
        </span>
        <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          <InlineSelect
            className="form-select task-proxy-select"
            value={task.proxyListName || ''}
            options={host.proxySelectOptions()}
            placeholder="Local"
            ariaLabel={`Proxy for ${host.accountLabel(task)}`}
            onChange={value => host.updateTaskProxy(group, task, value)}
          />
        </span>
        <label
          className={`task-repeat-toggle${task.loopCheckout ? ' enabled' : ''}`}
          title={running ? 'Stop this task before changing loop checkout.' : 'Continue after checkout or decline until the Target order cap is reached.'}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={task.loopCheckout === true}
            disabled={running}
            onChange={event => host.updateTaskLoopCheckout(group, task, event.target.checked)}
          />
          {task.loopCheckout ? 'On' : 'Off'}
        </label>
        <span className="task-run-counts">
          <span
            className={`task-checkout-count${checkouts > 0 ? ' has-checkouts' : ''}`}
            title={`${checkouts} successful checkout${checkouts === 1 ? '' : 's'} this run`}
            aria-label={`${checkouts} successful checkout${checkouts === 1 ? '' : 's'} this run`}
          >
            {checkouts}
          </span>
          <span
            className={`task-failure-count${declines > 0 ? ' has-failures' : ''}`}
            title={`${declines} failed checkout${declines === 1 ? '' : 's'} this run`}
            aria-label={`${declines} failed checkout${declines === 1 ? '' : 's'} this run`}
          >
            {declines}
          </span>
        </span>
        {otpRequest ? <TargetOtpInput request={otpRequest} /> : <StatusBadge status={displayStatus} />}
        <span>{new Date(task.createdAt || group.createdAt).toLocaleDateString()}</span>
        <span className="task-row-actions" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
          {running ? (
            <button className="icon-action icon-action-stop" title="Stop task" onClick={() => host.stopTasks([task])}><Icon name="stop" size={12} /></button>
          ) : (
            <button className="icon-action icon-action-start" title="Start task" onClick={() => host.startTasks(group, [task])}><Icon name="play" size={12} /></button>
          )}
          <button className="icon-action icon-action-reset" disabled={!canReset || running} title={canReset && !running ? 'Reset task to Idle' : 'Task is already fresh'} onClick={() => host.resetTask(task)}><Icon name="refresh" size={12} /></button>
          <button className="icon-action icon-action-danger" title="Delete task" onClick={() => host.deleteTask(group, task)}><Icon name="trash" size={12} /></button>
        </span>
      </div>
    );
  }
}

const TaskGroupTaskRow = connect(mapTaskRowState)(TaskGroupTaskRowView);

class TaskGroupTaskDetailView extends Component {
  proxyStatusFor(task) {
    return this.props.proxyStatus || null;
  }

  render() {
    const { group, task, host, account, profile, status, otpRequest, checkouts, declines, canReset, copiedTask, readinessPending } = this.props;
    const showLogs = this.props.showOperatorLogs === true;
    const logs = showLogs ? (this.props.taskLogs || []) : [];
    const displayStatus = this.proxyStatusFor(task) || status;
    const tone = targetStatusTone(displayStatus);
    const running = targetTaskIsRunning(status);
    const accountName = host.accountLabel(task);
    const initial = String((account && account.email) || '?').slice(0, 1).toUpperCase();
    const profileName = profile
      ? profile.name || profile.email || profile.id
      : 'Missing matching profile';
    const statusLabel = (displayStatus && (displayStatus.label || displayStatus.state)) || STATUS_LABELS[tone];
    const statusDetail = (displayStatus && displayStatus.detail) || (running
      ? 'This task is running through the existing Target checkout engine.'
      : 'Start this task to see its checkout steps and diagnostic output here.');
    const resetEnabled = !running && canReset;

    return (
      <div className="tasks-workspace tasks-workspace-with-harvester-dock">
        <div className="page-header task-view-header">
          <div>
            <div className="task-breadcrumbs">
              <button onClick={() => host.setState({ selectedGroupId: '', selectedTaskId: '', selectedTaskIds: [], taskFilter: '' })}>Task Groups</button>
              <span>/</span>
              <button onClick={() => host.setState({ selectedTaskId: '', copiedTask: false })}>{group.name}</button>
              <span>/</span>
              <em>{accountName}</em>
            </div>
            <div className="page-title"><span className="page-title-dot" /> {accountName}</div>
            <div className="group-ops-facts" aria-label="Monitor status"><GroupMonitorStatus /></div>
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => host.setState({ selectedTaskId: '', copiedTask: false })}>Back to Group</button>
            <button className="btn btn-secondary btn-sm" disabled={readinessPending} onClick={() => host.runReadiness(group, [task])}><Icon name="check" size={12} /> Check Readiness</button>
            <button className="btn btn-secondary btn-sm" disabled={!resetEnabled} title={resetEnabled ? 'Clear this completed run and return the task to Idle' : 'Task is already fresh'} onClick={() => host.resetTask(task)}><Icon name="refresh" size={12} /> Reset Task</button>
            {running ? (
              <button className="btn btn-danger btn-sm" onClick={() => host.stopTasks([task])}><Icon name="stop" size={12} /> Stop Task</button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => host.startTasks(group, [task])}><Icon name="play" size={12} /> Start Task</button>
            )}
          </div>
        </div>
        <div className="page-content task-detail-content">
          <section className={`task-status-hero task-status-hero-${tone}`}>
            <span className="task-status-hero-icon"><i className="task-avatar task-avatar-lg">{initial}</i></span>
            <div><small>Current task status</small><h2>{statusLabel}</h2><p>{statusDetail}</p></div>
            {otpRequest ? <TargetOtpInput request={otpRequest} large /> : <StatusBadge status={displayStatus} />}
          </section>

          <div className={`task-detail-grid${showLogs ? '' : ' task-detail-grid-solo'}`}>
            <section className="panel task-information">
              <div className="detail-panel-heading"><h3>Task Information</h3><span>{group.name}</span></div>
              <dl>
                <div><dt>Account</dt><dd>{accountName}</dd></div>
                <div><dt>Profile</dt><dd className={profile ? '' : 'text-danger'}>{profileName}</dd></div>
                <div><dt>Proxy</dt><dd>{proxyLabelForRef(host.proxyLists(), task.proxyListName, 'Local')}</dd></div>
                <div><dt>Watch list</dt><dd>{watchListSummary(group)}</dd></div>
                <div><dt>Stock confidence</dt><dd>{group.stockConfidence === 'confirmed-10-plus' ? 'Confirmed 10+' : 'Any in-stock signal'}</dd></div>
                <div><dt>Loop checkout</dt><dd>{task.loopCheckout ? 'On — up to the order cap' : 'Off — stop after one result'}</dd></div>
                <div><dt>Checkouts this run</dt><dd className={checkouts > 0 ? 'task-checkout-detail-success' : ''}>{checkouts}</dd></div>
                <div><dt>Failures this run</dt><dd className={declines > 0 ? 'task-checkout-detail-fail' : ''}>{declines}</dd></div>
                <div><dt>Created</dt><dd>{new Date(task.createdAt || group.createdAt).toLocaleString()}</dd></div>
                <div><dt>Task ID</dt><dd>{task.id}</dd></div>
              </dl>
            </section>
            {showLogs && (
            <section className="panel task-log-panel task-own-log-panel">
              <div className="detail-panel-heading">
                <div><h3><Icon name="activity" size={13} /> Task Log</h3><span>{logs.length} line{logs.length === 1 ? '' : 's'} · only this task</span></div>
                <div className="page-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => host.copyTaskLogs(task)} disabled={!logs.length}>
                    <Icon name="copy" size={11} /> {copiedTask ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => host.clearTaskLogs(task)} disabled={!logs.length}>Clear</button>
                </div>
              </div>
              <VirtualLogView
                className="task-log-view"
                lines={logs}
                estimatedHeight={340}
                empty={(
                  <div className="task-log-empty">
                    <Icon name="activity" size={20} />
                    <span>No output from this task yet</span>
                    <small>Checkout steps tagged with this task ID will appear here. Broker, farmer, and monitor startup remain in the shared log below.</small>
                  </div>
                )}
              />
            </section>
            )}
          </div>

          {showLogs ? <SharedEngineLog host={host} /> : null}
        </div>
        {host.renderHarvesterDrawer()}
        {host.renderReadinessModal()}
        {host.renderHarvesterModal()}
      </div>
    );
  }
}

const TaskGroupTaskDetail = connect(mapTaskDetailState)(TaskGroupTaskDetailView);

class TaskGroupDropPulseView extends Component {
  render() {
    const pulse = this.props.pulse || { carting: 0, submitting: 0, checkouts: 0, failures: 0 };
    const stats = [
      { key: 'cart', icon: 'cart', count: pulse.carting, label: 'Adding to cart' },
      { key: 'submit', icon: 'send', count: pulse.submitting, label: 'Carted this run' },
      { key: 'success', icon: 'check', count: pulse.checkouts, label: 'Successful checkouts this run' },
      { key: 'fail', icon: 'warning', count: pulse.failures, label: 'Failed this run' },
    ];
    return (
      <div className="group-drop-pulse" role="status" aria-live="polite" aria-label="Drop status">
        {stats.map(stat => (
          <span
            className={`group-drop-stat group-drop-stat-${stat.key}${stat.count ? ' active' : ''}`}
            key={stat.key}
            title={stat.label}
          >
            <Icon name={stat.icon} size={13} />
            <strong>{stat.count}</strong>
            <em>{stat.label}</em>
          </span>
        ))}
      </div>
    );
  }
}

const TaskGroupDropPulse = connect(mapGroupRuntimeState)(TaskGroupDropPulseView);

class TaskGroupRunControlsView extends Component {
  render() {
    const { group, host, running } = this.props;
    return running ? (
      <button className="btn btn-danger btn-sm" onClick={() => host.stopTasks(group.tasks)}><Icon name="stop" size={12} /> Stop All</button>
    ) : (
      <button className="btn btn-primary btn-sm" onClick={() => host.startTasks(group, group.tasks)}><Icon name="play" size={12} /> Start All</button>
    );
  }
}

const TaskGroupRunControls = connect(mapGroupRuntimeState)(TaskGroupRunControlsView);

class TaskGroupOverviewRowView extends Component {
  render() {
    const { group, host, scheduleNow, total, running, error } = this.props;
    const items = watchedItemsForGroup(group);
    const limited = items.filter(item => item.maxPrice).length;
    const isRunning = running > 0;
    return (
      <article
        className="task-group-row task-group-r2-row"
        key={group.id}
        tabIndex="0"
        onClick={() => host.setState({ selectedGroupId: group.id, selectedTaskIds: [] })}
        onKeyDown={event => event.key === 'Enter' && host.setState({ selectedGroupId: group.id, selectedTaskIds: [] })}
      >
        <div className="task-group-row-identity">
          <span className="site-mark"><Icon name="target" size={19} /></span>
          <span><h3>{group.name}</h3><p>Target task group</p>{host.renderScheduleChip(group, scheduleNow)}</span>
        </div>
        <div className="task-group-row-stats">
          <span><strong>{total}</strong>Tasks</span>
          <span><strong>{running}</strong>Running</span>
          <span><strong>{error}</strong>Attention</span>
        </div>
        <div className="task-group-row-runtime">
          <div className="task-group-row-summary">
            <span className="task-group-row-summary-icon"><Icon name="list" size={15} /></span>
            <span><small>Watch list</small><strong>{watchListSummary(group)}{limited ? ` · ${limited} price cap${limited === 1 ? '' : 's'}` : ''}</strong></span>
          </div>
        </div>
        <div className="task-group-row-actions" onClick={event => event.stopPropagation()}>
          {isRunning ? (
            <button className="btn btn-danger btn-sm" onClick={() => host.stopTasks(group.tasks)}><Icon name="stop" size={12} /> Stop</button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => host.startTasks(group, group.tasks)}><Icon name="play" size={12} /> Start</button>
          )}
          <button className="icon-action" title="Edit group" onClick={() => host.openEditGroup(group)}><Icon name="settings" size={13} /></button>
          <button className="icon-action icon-action-danger" title="Delete group" onClick={() => host.deleteGroup(group)}><Icon name="trash" size={13} /></button>
          <button className="btn btn-secondary btn-sm" onClick={() => host.setState({ selectedGroupId: group.id, selectedTaskIds: [] })}>Open</button>
        </div>
      </article>
    );
  }
}

const TaskGroupOverviewRow = connect(mapGroupRuntimeState)(TaskGroupOverviewRowView);

class TaskGroupMetricsView extends Component {
  render() {
    const stats = this.props;
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
}

const TaskGroupMetrics = connect((state, { groups }) => selectTargetWorkspaceRuntime(state.target, groups))(TaskGroupMetricsView);

class TaskGroups extends Component {

  state = {
    loaded: false,
    groups: [],
    selectedGroupId: '',
    selectedTaskId: '',
    selectedTaskIds: [],
    groupFilter: '',
    taskFilter: '',
    showGroupModal: false,
    editingGroupId: '',
    groupDraft: { ...EMPTY_GROUP },
    skuInput: '',
    skuInputError: '',
    productHistory: [],
    productHistoryFilter: '',
    showScheduleModal: false,
    scheduleDraft: emptyScheduleDraft(),
    scheduleError: '',
    scheduleNow: Date.now(),
    showTaskModal: false,
    selectedAccounts: [],
    taskProxy: '',
    taskLoopCheckout: false,
    copiedEngine: false,
    copiedTask: false,
    bank: null,
    bankCheckedAt: 0,
    brokerStartRequestedAt: 0,
    atcCookiesPerTask: String(DEFAULT_ATC_COOKIES_PER_TASK),
    harvesters: [],
    harvesterDrawerOpen: initialHarvesterDrawerOpen(),
    showHarvesterModal: false,
    editingHarvesterId: '',
    harvesterDraft: { ...EMPTY_HARVESTER },
    readinessPending: false,
    readiness: null,
    readinessIntent: '',
    readinessGroupId: '',
    readinessTaskIds: [],
  };

  componentDidMount() {
    this.loadGroups();
    this.loadProductHistory();
    this.pollBank();
    this.bankTimer = setInterval(this.pollBank, 5000);
    this.scheduleClockTimer = setInterval(() => this.setState({ scheduleNow: Date.now() }), 30000);
    this.onTaskGroupSchedule = () => this.loadGroups();
    ipcRenderer.on('taskGroupSchedule', this.onTaskGroupSchedule);
    this.onTargetProductHistory = (_event, payload = {}) => {
      this.setState({ productHistory: Array.isArray(payload.items) ? payload.items : [] });
    };
    ipcRenderer.on('targetProductHistory', this.onTargetProductHistory);
  }

  componentWillUnmount() {
    this.flushPersist();
    clearInterval(this.bankTimer);
    clearInterval(this.scheduleClockTimer);
    try { ipcRenderer.removeListener('taskGroupSchedule', this.onTaskGroupSchedule); } catch {}
    try { ipcRenderer.removeListener('targetProductHistory', this.onTargetProductHistory); } catch {}
  }

  loadProductHistory = () => {
    let productHistory = [];
    try { productHistory = ipcRenderer.sendSync('getTargetProductHistory') || []; } catch {}
    this.setState({ productHistory: Array.isArray(productHistory) ? productHistory : [] });
  };

  loadGroups = () => {
    let groups = [];
    let atcCookiesPerTask = String(DEFAULT_ATC_COOKIES_PER_TASK);
    let harvesters = [];
    let migratedSettings = null;
    try { groups = ipcRenderer.sendSync('getTaskGroups') || []; } catch {}
    try {
      const settings = ipcRenderer.sendSync('getSettings') || {};
      atcCookiesPerTask = normalizeAtcCookiesPerTask(settings.targetAtcCookiesPerTask);
      if (Array.isArray(settings.targetHarvesters)) {
        harvesters = settings.targetHarvesters.map(normalizeHarvester);
      } else {
        // Absence means exactly that: the user has not created a harvester. Persist an explicit
        // empty list so neither a fresh install nor an older settings file can fall through to the
        // retired task-owned farmer and begin using bandwidth merely because a task was added.
        harvesters = [];
        migratedSettings = { ...settings, targetHarvesters: harvesters };
        ipcRenderer.sendSync('saveSettings', migratedSettings);
      }
    } catch {}
    if (migratedSettings) {
      this.props.dispatch({ type: 'update', obj: { settings: migratedSettings } });
      try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
    }
    this.setState(({ selectedGroupId, selectedTaskId, selectedTaskIds }) => ({
      groups,
      loaded: true,
      atcCookiesPerTask,
      harvesters,
      selectedGroupId: groups.some(group => group.id === selectedGroupId) ? selectedGroupId : '',
      selectedTaskId: groups.some(group => (group.tasks || []).some(task => task.id === selectedTaskId))
        ? selectedTaskId : '',
      selectedTaskIds: selectedTaskIds.filter(id => groups.some(group => (group.tasks || []).some(task => task.id === id))),
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

  saveAtcCookiesPerTask = () => {
    const targetAtcCookiesPerTask = normalizeAtcCookiesPerTask(this.state.atcCookiesPerTask);
    let settings = this.props.settings || {};
    try { settings = ipcRenderer.sendSync('getSettings') || settings; } catch {}
    if (normalizeAtcCookiesPerTask(settings.targetAtcCookiesPerTask) === targetAtcCookiesPerTask) {
      this.setState({ atcCookiesPerTask: targetAtcCookiesPerTask }, () => {
        try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
        this.pollBank();
      });
      return;
    }
    const next = { ...settings, targetAtcCookiesPerTask };
    try { ipcRenderer.sendSync('saveSettings', next); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings: next } });
    this.setState({ atcCookiesPerTask: targetAtcCookiesPerTask }, () => {
      try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
      this.pollBank();
    });
  };

  persistHarvesters = (harvesters, callback, runCommand = null) => {
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
      try { ipcRenderer.sendSync('syncTargetHarvesters', runCommand); } catch {}
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
    if (draft.enabled !== false && !this.harvesterProxyAvailable(draft)) {
      window.alert(`Proxy group “${draft.proxyListName}” is unavailable. Select another proxy group or Local before starting this harvester.`);
      return;
    }
    const startSchedule = isoDateTimeValue(draft.startSchedule);
    const stopSchedule = isoDateTimeValue(draft.stopSchedule);
    if (startSchedule && stopSchedule && Date.parse(stopSchedule) <= Date.parse(startSchedule)) {
      window.alert('Stop Schedule must be later than Start Schedule.');
      return;
    }
    const requestedWorkers = draft.type === 'login'
      ? 1 : clampInteger(draft.workers, 1, harvesterWorkerMaximum(draft), 1);
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
    if (!harvester.enabled && !this.harvesterProxyAvailable(harvester)) {
      window.alert(`Proxy group “${harvester.proxyListName}” is unavailable. Edit this harvester before starting it.`);
      return;
    }
    const running = !harvester.enabled;
    const harvesters = this.state.harvesters.map(item => item.id === harvester.id
      ? { ...item, enabled: running } : item);
    this.persistHarvesters(harvesters, null, { id: harvester.id, running });
  };

  deleteHarvester = harvester => {
    if (!window.confirm(`Delete “${harvester.name}”? Its cookies already in the shared bank will remain until they expire.`)) return;
    this.persistHarvesters(this.state.harvesters.filter(item => item.id !== harvester.id));
  };

  profileList = () => profileListFrom(this.props.profiles);

  targetAccounts = () => (this.props.accounts || []).filter(account => siteOf(account) === 'target');
  proxyLists = () => ((this.props.proxies && this.props.proxies.lists) || []);
  proxyFolders = () => {
    try {
      const folders = ipcRenderer.sendSync('getProxyGroups') || [];
      if (Array.isArray(folders) && folders.length) return folders;
    } catch {}
    const names = new Set();
    for (const list of this.proxyLists()) {
      for (const group of (Array.isArray(list.groups) ? list.groups : [])) {
        if (group) names.add(String(group));
      }
    }
    return [...names];
  };
  proxySelectOptions = ({ localValue = '', localLabel = 'Local', includeLocal = true } = {}) => {
    const options = [];
    if (includeLocal) options.push({ value: localValue, label: localLabel });
    for (const name of this.proxyFolders()) options.push({ value: proxyFolderRef(name), label: name, group: 'Folders' });
    for (const list of this.proxyLists()) options.push({ value: proxyRef(list), label: proxyLabel(list), group: 'Lists' });
    return options;
  };

  renderProxySelectOptions = ({ localValue = '', localLabel = 'Local', includeLocal = true } = {}) => {
    const folders = this.proxyFolders();
    const lists = this.proxyLists();
    return (
      <>
        {includeLocal && <option value={localValue}>{localLabel}</option>}
        {!!folders.length && (
          <optgroup label="Folders">
            {folders.map(name => <option key={proxyFolderRef(name)} value={proxyFolderRef(name)}>{name}</option>)}
          </optgroup>
        )}
        {!!lists.length && (
          <optgroup label="Lists">
            {lists.map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
          </optgroup>
        )}
      </>
    );
  };
  harvesterProxyAvailable = harvester => {
    const ref = String(harvester && harvester.proxyListName || '');
    if (!ref) return true;
    const folder = ref.toLowerCase().startsWith('group:') ? ref.slice(6).trim().toLowerCase() : '';
    if (folder) {
      return this.proxyLists().some(list => !list.managed && (Array.isArray(list.groups) ? list.groups : [])
        .some(group => String(group || '').toLowerCase() === folder));
    }
    return this.proxyLists().some(list => proxyRef(list) === ref);
  };

  extensionHarvesterConfigured = () => {
    const settings = this.props.settings || {};
    return /^harvester$/i.test(String(settings.shapeMethod || '').trim())
      && hasHarvesterExtensionId(harvesterExtensionIdsFromSettings(settings));
  };
  selectedGroup = () => this.state.groups.find(group => group.id === this.state.selectedGroupId);
  selectedTask = group => (group && (group.tasks || []).find(task => task.id === this.state.selectedTaskId));
  statusFor = task => (liveTarget().taskStatus || {})[task.id];
  accountFor = task => accountForTask(this.props.accounts, task);
  openTask = task => this.setState({ selectedTaskId: task.id, copiedTask: false });

  taskHasResettableState = task => {
    const target = liveTarget();
    const account = this.accountFor(task);
    return Boolean(
      (target.taskStatus || {})[task.id]
      || Object.prototype.hasOwnProperty.call(target.taskOutcomes || {}, task.id)
      || (target.proxyStatus || {})[task.id]
      || (((target.taskLogs || {})[task.id]) || []).length
      || targetOtpForTask(target.otpPending, task.id, account && account.email)
    );
  };

  profileForAccount = (accountId) => profileForAccountId(this.props.profiles, this.props.accounts, accountId);

  persist = (groups, callback) => {
    this.setState({ groups }, callback);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = 0;
      try { ipcRenderer.sendSync('saveTaskGroups', this.state.groups); } catch {}
    }, 400);
  };

  flushPersist = () => {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = 0;
    try { ipcRenderer.sendSync('saveTaskGroups', this.state.groups); } catch {}
  };

  allStats = () => selectTargetWorkspaceRuntime(liveTarget(), this.state.groups);

  openNewGroup = () => {
    this.loadProductHistory();
    this.setState({
      showGroupModal: true,
      editingGroupId: '',
      groupDraft: { ...EMPTY_GROUP },
      skuInput: '',
      skuInputError: '',
      productHistoryFilter: '',
    });
  };

  openEditGroup = group => {
    this.loadProductHistory();
    const items = watchedItemsForGroup(group);
    this.setState({
      showGroupModal: true,
      editingGroupId: group.id,
      groupDraft: {
        name: group.name,
        skus: items.map(item => item.sku).join('\n'),
        maxPrices: Object.fromEntries(items.map(item => [item.sku, item.maxPrice || ''])),
        priorities: Object.fromEntries(items.map(item => [item.sku, item.priority === true])),
        qty: group.qty || 2,
        proxyListName: group.proxyListName || '',
        loopCheckout: group.loopCheckout === true,
        useFillerItem: group.useFillerItem === true,
        stockConfidence: group.stockConfidence === 'confirmed-10-plus' ? 'confirmed-10-plus' : 'any',
      },
      skuInput: '',
      skuInputError: '',
      productHistoryFilter: '',
    });
  };

  closeGroupModal = () => this.setState({
    showGroupModal: false,
    editingGroupId: '',
    skuInput: '',
    skuInputError: '',
  });

  productNameForSku = sku => {
    const item = (this.state.productHistory || []).find(entry => String(entry.sku) === String(sku));
    return String(item && item.name || '').trim();
  };

  addWatchedSkus = raw => {
    const incoming = parseSkus(raw);
    if (!incoming.length) {
      this.setState({ skuInputError: 'Paste a Target TCIN or product URL.' });
      return false;
    }
    this.setState(previous => {
      const existing = parseSkus(previous.groupDraft.skus);
      const next = [...existing];
      for (const sku of incoming) {
        if (!next.includes(sku)) next.push(sku);
      }
      const added = next.length - existing.length;
      return {
        skuInput: '',
        skuInputError: added ? '' : incoming.length === 1
          ? 'That SKU is already on the list.'
          : 'Those SKUs are already on the list.',
        groupDraft: added ? { ...previous.groupDraft, skus: next.join('\n') } : previous.groupDraft,
      };
    });
    return true;
  };

  addProductFromHistory = sku => this.addWatchedSkus(sku);

  removeSku = sku => this.setState(previous => {
    const id = String(sku || '').trim();
    if (!id) return null;
    const next = parseSkus(previous.groupDraft.skus).filter(item => item !== id);
    const maxPrices = { ...(previous.groupDraft.maxPrices || {}) };
    const priorities = { ...(previous.groupDraft.priorities || {}) };
    delete maxPrices[id];
    delete priorities[id];
    return {
      skuInputError: '',
      groupDraft: { ...previous.groupDraft, skus: next.join('\n'), maxPrices, priorities },
    };
  });

  setSkuMaxPrice = (sku, value) => this.setState(previous => ({
    groupDraft: {
      ...previous.groupDraft,
      maxPrices: { ...(previous.groupDraft.maxPrices || {}), [sku]: value },
    },
  }));

  setSkuPriority = (sku, value) => this.setState(previous => ({
    groupDraft: {
      ...previous.groupDraft,
      priorities: { ...(previous.groupDraft.priorities || {}), [sku]: value === true },
    },
  }));

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
    const invalidPriceSku = nextSkus.find(sku => normalizeMaxPrice((draft.maxPrices || {})[sku]) === null);
    if (invalidPriceSku) {
      window.alert(`Enter a valid maximum price for Target SKU ${invalidPriceSku}, or leave it empty for no maximum.`);
      return;
    }
    const items = nextSkus.map(sku => ({
      sku,
      maxPrice: normalizeMaxPrice((draft.maxPrices || {})[sku]) || '',
      ...((draft.priorities || {})[sku] ? { priority: true } : {}),
    }));
    const previousItems = watchedItemsForGroup(previousGroup);
    const liveTasks = previousGroup
      ? (previousGroup.tasks || []).filter(task => targetTaskIsRunning(this.statusFor(task)))
      : [];
    const serializeWatch = list => JSON.stringify((list || []).map(item => ({
      sku: item.sku,
      maxPrice: item.maxPrice || '',
      priority: item.priority === true,
    })));
    const liveWatchChanged = !!previousGroup && (
      serializeWatch(previousItems) !== serializeWatch(items)
      || String(previousGroup.qty || 2) !== String(draft.qty || 2)
    );
    const loopCheckout = draft.loopCheckout === true;
    const liveLoopChanged = !!previousGroup
      && (previousGroup.loopCheckout === true) !== loopCheckout;
    const useFillerItem = draft.useFillerItem === true;
    const liveFillerChanged = !!previousGroup
      && (previousGroup.useFillerItem === true) !== useFillerItem;
    const stockConfidence = draft.stockConfidence === 'confirmed-10-plus' ? 'confirmed-10-plus' : 'any';
    const liveStockConfidenceChanged = !!previousGroup
      && (previousGroup.stockConfidence === 'confirmed-10-plus' ? 'confirmed-10-plus' : 'any') !== stockConfidence;
    if (liveWatchChanged && liveTasks.length && !nextSkus.length) {
      window.alert('A running group must keep at least one valid Target SKU. Stop the tasks before clearing the watch list.');
      return;
    }
    let groups;
    if (selectedGroupId) {
      groups = this.state.groups.map(group => group.id === selectedGroupId ? {
        ...group,
        name,
        items,
        skus: items.map(item => item.sku).join('\n'),
        qty: draft.qty,
        proxyListName: draft.proxyListName,
        loopCheckout,
        useFillerItem,
        stockConfidence,
        tasks: liveLoopChanged
          ? (group.tasks || []).map(task => ({ ...task, loopCheckout }))
          : group.tasks,
        updatedAt: now,
      } : group);
    } else {
      selectedGroupId = uid('group');
      groups = [...this.state.groups, {
        id: selectedGroupId,
        name,
        site: 'target',
        items,
        skus: items.map(item => item.sku).join('\n'),
        qty: draft.qty,
        proxyListName: draft.proxyListName,
        loopCheckout,
        useFillerItem,
        stockConfidence,
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
            items,
            qty: draft.qty || 2,
            stockConfidence,
            ignoreLowStock: stockConfidence === 'confirmed-10-plus',
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
        } else if ((liveLoopChanged || liveFillerChanged || liveStockConfidenceChanged) && liveTasks.length) {
          window.alert('The group checkout settings were saved. Stop and restart the running tasks to apply them.');
        }
      });
    });
  };

  deleteGroup = (group) => {
    if (!window.confirm(`Delete “${group.name}” and its ${(group.tasks || []).length} task(s)?\n\nThe legacy Target workspace is not affected.`)) return;
    for (const task of (group.tasks || [])) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
      this.props.dispatch({ type: 'targetTaskDelete', id: task.id });
    }
    this.persist(this.state.groups.filter(item => item.id !== group.id), () => {
      if (this.state.selectedGroupId === group.id) this.setState({ selectedGroupId: '', selectedTaskId: '', selectedTaskIds: [] });
    });
  };

  openTaskModal = group => this.setState({
    selectedGroupId: group.id,
    showTaskModal: true,
    selectedAccounts: [],
    taskProxy: group.proxyListName || '',
    taskLoopCheckout: group.loopCheckout === true,
  });

  toggleAccount = (accountId) => this.setState(({ selectedAccounts }) => ({
    selectedAccounts: selectedAccounts.includes(accountId)
      ? selectedAccounts.filter(id => id !== accountId)
      : [...selectedAccounts, accountId],
  }));

  selectableAccountIds = (group) => {
    const used = new Set(((group && group.tasks) || []).map(task => String(task.accountId)));
    return this.targetAccounts()
      .filter(account => !used.has(String(account.id)))
      .map(account => account.id);
  };

  toggleSelectAllAccounts = () => {
    const group = this.selectedGroup();
    if (!group) return;
    const selectable = this.selectableAccountIds(group);
    this.setState(({ selectedAccounts }) => {
      const selected = new Set(selectedAccounts.map(String));
      const allSelected = selectable.length > 0 && selectable.every(id => selected.has(String(id)));
      return { selectedAccounts: allSelected ? [] : selectable };
    });
  };

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
        loopCheckout: this.state.taskLoopCheckout === true,
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
    this.updateTasksProxy(group, [task], proxyListName);
  };

  updateTasksProxy = (group, tasks, proxyListName) => {
    const ids = new Set((Array.isArray(tasks) ? tasks : []).map(task => task.id));
    if (!ids.size) return;
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.map(candidate => ids.has(candidate.id) ? { ...candidate, proxyListName } : candidate),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups);
    const label = String(proxyListName || '').trim() || 'Local';
    for (const task of tasks) {
      try {
        if (ipcRenderer.sendSync('setTargetTaskProxy', task.id, proxyListName)) {
          this.props.dispatch({
            type: 'targetProxyEditSent', taskId: task.id, at: Date.now(),
            group: label,
          });
        }
      } catch {}
    }
  };

  toggleTaskSelected = taskId => this.setState(({ selectedTaskIds }) => ({
    selectedTaskIds: selectedTaskIds.includes(taskId)
      ? selectedTaskIds.filter(id => id !== taskId)
      : [...selectedTaskIds, taskId],
  }));

  toggleSelectVisibleTasks = visibleTasks => {
    const visibleIds = (Array.isArray(visibleTasks) ? visibleTasks : []).map(task => task.id);
    this.setState(({ selectedTaskIds }) => {
      const selected = new Set(selectedTaskIds);
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
      if (allVisibleSelected) visibleIds.forEach(id => selected.delete(id));
      else visibleIds.forEach(id => selected.add(id));
      return { selectedTaskIds: [...selected] };
    });
  };

  updateTaskLoopCheckout = (group, task, loopCheckout) => {
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.map(candidate => candidate.id === task.id
        ? { ...candidate, loopCheckout: loopCheckout === true }
        : candidate),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups);
  };

  deleteTask = (group, task) => {
    if (!window.confirm(`Delete the task for “${this.accountLabel(task)}” from “${group.name}”?`)) return;
    try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    this.props.dispatch({ type: 'targetTaskDelete', id: task.id });
    const groups = this.state.groups.map(item => item.id === group.id ? {
      ...item,
      tasks: item.tasks.filter(candidate => candidate.id !== task.id),
      updatedAt: Date.now(),
    } : item);
    this.persist(groups, () => {
      this.setState(({ selectedTaskId, selectedTaskIds }) => ({
        selectedTaskId: selectedTaskId === task.id ? '' : selectedTaskId,
        selectedTaskIds: selectedTaskIds.filter(id => id !== task.id),
      }));
    });
  };

  resetTask = task => {
    if (targetTaskIsRunning(this.statusFor(task)) || !this.taskHasResettableState(task)) return;
    const label = this.accountLabel(task);
    if (!window.confirm(
      `Reset “${label}” to Idle?\n\nThis clears its completed status, checkout count, temporary OTP/proxy notices, and task log. Task settings and Target order-limit history stay unchanged.`,
    )) return;
    const account = this.accountFor(task);
    this.props.dispatch({
      type: 'targetTaskReset',
      id: task.id,
      email: (account && account.email) || '',
    });
  };

  accountLabel = task => {
    const account = this.accountFor(task);
    return (account && (account.email || account.username || account.name)) || task.accountId || 'Unknown account';
  };

  runnableTasks = (group, tasks) => {
    const items = watchedItemsForGroup(group);
    const skus = items.map(item => item.sku);
    if (!items.length) {
      window.alert('Add at least one Target SKU to this task group first.');
      return null;
    }
    const runnable = [];
    const missing = [];
    for (const task of tasks) {
      const profile = task.profileId
        ? this.profileList().find(item => String(item.id) === String(task.profileId)) || this.profileForAccount(task.accountId)
        : this.profileForAccount(task.accountId);
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
    return {
      tasks: runnable,
      skus,
      items,
      qty: group.qty || 2,
      useFillerItem: group.useFillerItem === true,
      stockConfidence: group.stockConfidence === 'confirmed-10-plus' ? 'confirmed-10-plus' : 'any',
      ignoreLowStock: group.stockConfidence === 'confirmed-10-plus',
    };
  };

  activeOtherGroup = group => this.state.groups.find(item => item.id !== group.id
    && (item.tasks || []).some(task => targetTaskIsRunning(this.statusFor(task))));

  launchTasks = (group, tasks) => {
    const config = this.runnableTasks(group, tasks);
    if (config) {
      this.setState({ brokerStartRequestedAt: Date.now(), bankCheckedAt: Date.now() });
      ipcRenderer.send('startTarget', config);
    }
  };

  runReadiness = async (group, tasks, intent = 'check') => {
    if (this.state.readinessPending) return;
    const taskIds = (Array.isArray(tasks) ? tasks : []).map(task => String(task.id));
    this.setState({ readinessPending: true });
    let readiness;
    try {
      readiness = await ipcRenderer.invoke('targetReadiness', { groupId: group.id, taskIds });
    } catch (error) {
      readiness = {
        ok: false,
        level: 'blocked',
        blockers: [{ code: 'check-failed', title: 'Readiness check unavailable', detail: String((error && error.message) || error) }],
        warnings: [],
        checks: [],
        counts: { tasks: taskIds.length, skus: watchedItemsForGroup(group).length },
      };
    }
    if (intent === 'start' && readiness && readiness.level === 'ready') {
      this.setState({ readinessPending: false }, () => this.launchTasks(group, tasks));
      return;
    }
    this.setState({
      readinessPending: false,
      readiness,
      readinessIntent: intent,
      readinessGroupId: String(group.id),
      readinessTaskIds: taskIds,
    });
  };

  closeReadiness = () => this.setState({
    readiness: null,
    readinessIntent: '',
    readinessGroupId: '',
    readinessTaskIds: [],
  });

  continueReadinessStart = () => {
    const group = this.state.groups.find(item => String(item.id) === this.state.readinessGroupId);
    const selected = new Set(this.state.readinessTaskIds);
    const tasks = group ? (group.tasks || []).filter(task => selected.has(String(task.id))) : [];
    this.closeReadiness();
    if (group && tasks.length) this.launchTasks(group, tasks);
  };

  startTasks = (group, tasks) => {
    const other = this.activeOtherGroup(group);
    if (other) {
      window.alert(`“${other.name}” is already running. The current Target engine has one shared monitor, so stop that group first.`);
      return;
    }
    this.runReadiness(group, tasks, 'start');
  };

  stopTasks = (tasks) => {
    const runningBefore = this.allStats().running;
    const stopping = tasks.filter(task => targetTaskIsRunning(this.statusFor(task))).length;
    for (const task of tasks) {
      try { ipcRenderer.sendSync('stopTarget', task.id); } catch {}
    }
    if (!runningBefore || stopping >= runningBefore) this.setState({ brokerStartRequestedAt: 0 });
  };

  copyEngineLogs = () => {
    const logs = liveTarget().logs || [];
    if (!logs.length) return;
    try { clipboard.writeText(logs.join('\n')); } catch {}
    this.setState({ copiedEngine: true }, () => {
      setTimeout(() => this.setState({ copiedEngine: false }), 1200);
    });
  };

  clearEngineLogs = () => {
    const logs = liveTarget().logs || [];
    if (!logs.length || !window.confirm('Clear the shared engine / monitor log?')) return;
    this.props.dispatch({ type: 'targetSet', obj: { logs: [] } });
  };

  copyTaskLogs = (task) => {
    const logs = ((liveTarget().taskLogs || {})[task.id]) || [];
    if (!logs.length) return;
    try { clipboard.writeText(logs.join('\n')); } catch {}
    this.setState({ copiedTask: true }, () => {
      setTimeout(() => this.setState({ copiedTask: false }), 1200);
    });
  };

  clearTaskLogs = (task) => {
    const taskLogs = liveTarget().taskLogs || {};
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

  renderSharedEngineLog(source = this.props) {
    const target = {
      logs: source.targetLogs || [],
      monitorStatus: source.monitorStatus,
      monitorBandwidth: source.monitorBandwidth,
    };
    const logs = target.logs || [];
    const bandwidth = targetMonitorBandwidthSummary(target.monitorBandwidth, Date.now());
    const monitorCount = bandwidth.available ? bandwidth.runCount : 0;
    return (
      <section className="panel task-log-panel engine-log-panel engine-log-panel-dashboard">
        <div className="detail-panel-heading engine-log-heading">
          <div className="engine-log-heading-left">
            <h3><Icon name="activity" size={13} /> Engine &amp; Monitor Log</h3>
            <span className="engine-log-meta">
              <span className="engine-log-line-count">
                {logs.length} line{logs.length === 1 ? '' : 's'}
              </span>
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
        <section
          className={`engine-monitor-bandwidth${bandwidth.available ? '' : ' engine-monitor-bandwidth-pending'}`}
          aria-label="Task monitor bandwidth telemetry"
          aria-describedby="target-monitor-bandwidth-description"
        >
          <header>
            <span className="engine-monitor-bandwidth-title">
              <span className="engine-monitor-bandwidth-icon"><Icon name="activity" size={12} /></span>
              <span>
                <strong>Monitor bandwidth</strong>
                <small>{bandwidth.available
                  ? `This run · ${bandwidth.watchedItems} watched item${bandwidth.watchedItems === 1 ? '' : 's'}`
                  : 'This run · waiting for measured traffic'}</small>
              </span>
            </span>
            {bandwidth.available && (
              <em className={bandwidth.running ? 'active' : ''}>
                {bandwidth.running ? 'Measuring' : (bandwidth.incomplete ? 'Stopped · last sample' : 'Run complete')}
                {monitorCount > 1 ? ` · ${monitorCount} monitor runs` : ''}
              </em>
            )}
          </header>
          {bandwidth.available ? (
            <div className="engine-monitor-bandwidth-stats">
              <span>
                <strong>{bandwidth.saturated ? '≥ ' : ''}{formatBandwidth(bandwidth.totalBytes)}</strong>
                <small>{bandwidth.saturated ? 'Display limit reached' : 'Total transport'}</small>
              </span>
              <span><strong>↓ {formatBandwidth(bandwidth.downloadBytes)}</strong><small>↑ {formatBandwidth(bandwidth.uploadBytes)} upload</small></span>
              <span><strong>{bandwidth.saturated ? '≥ ' : ''}{formatBandwidth(bandwidth.bytesPerHour)}/hr</strong><small>Run average</small></span>
              <span><strong>{formatBandwidth(bandwidth.proxyBytes)} proxy</strong><small>{formatBandwidth(bandwidth.directBytes)} direct{bandwidth.saturated ? ' · capped split' : ''}</small></span>
              <span>
                <strong>{bandwidth.polls.toLocaleString()} poll{bandwidth.polls === 1 ? '' : 's'}</strong>
                <small>{bandwidth.failedPolls.toLocaleString()} failed</small>
              </span>
            </div>
          ) : (
            <div className="engine-monitor-bandwidth-empty">
              <strong>Bandwidth not measured yet</strong>
              <small>A compatible engine will report totals after the shared monitor starts polling. No traffic is being shown as zero.</small>
            </div>
          )}
          <p id="target-monitor-bandwidth-description" className="engine-monitor-bandwidth-note">
            {TARGET_MONITOR_BANDWIDTH_TOOLTIP}
          </p>
        </section>
        <VirtualLogView
          className="task-log-view engine-log-view"
          lines={logs}
          estimatedHeight={260}
          empty={(
            <div className="task-log-empty">
              <Icon name="activity" size={20} />
              <span>No shared engine output yet</span>
              <small>Shape farmer, stock monitor, Discord pings, and engine lifecycle output appear here for this Target workspace.</small>
            </div>
          )}
        />
      </section>
    );
  }

  renderGroupFacts(group) {
    const tasks = group.tasks || [];
    const loopOn = tasks.filter(task => task.loopCheckout).length;
    return (
      <div className="group-ops-facts" aria-label="Group settings">
        <span><small>Tasks</small><strong>{tasks.length}</strong></span>
        <span title={watchListSummary(group)}><small>Watch</small><strong>{watchListSummary(group)}</strong></span>
        <span><small>Stock</small><strong>{group.stockConfidence === 'confirmed-10-plus' ? 'Confirmed 10+' : 'Any stock'}</strong></span>
        <span title={proxyLabelForRef(this.proxyLists(), group.proxyListName, 'Local')}><small>Proxy</small><strong>{proxyLabelForRef(this.proxyLists(), group.proxyListName, 'Local')}</strong></span>
        <span><small>Loop</small><strong>{tasks.length ? `${loopOn}/${tasks.length}` : group.loopCheckout ? 'On' : 'Off'}</strong></span>
        <span title={group.useFillerItem ? 'On · SKU 84704409' : 'Off'}><small>Filler</small><strong>{group.useFillerItem ? 'On' : 'Off'}</strong></span>
        <GroupMonitorStatus />
      </div>
    );
  }

  renderMetrics() {
    return <TaskGroupMetrics groups={this.state.groups} />;
  }

  harvesterRuntimeFor = id => {
    const list = (this.state.bank && Array.isArray(this.state.bank.harvesters))
      ? this.state.bank.harvesters : [];
    return list.find(item => String(item.id) === String(id)) || null;
  };

  harvesterState = (harvester, runtime) => {
    if (!harvester.enabled) return { kind: 'idle', label: 'Stopped' };
    if (!this.harvesterProxyAvailable(harvester)) {
      return { kind: 'error', label: 'Proxy unavailable' };
    }
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

  renderHarvesterDrawer() {
    const availableHarvesters = this.state.harvesters.map(harvester =>
      this.harvesterProxyAvailable(harvester) ? harvester : { ...harvester, enabled: false });
    const bank = targetBankPresentation(this.state.bank, availableHarvesters, {
      now: this.state.bankCheckedAt || Date.now(),
      brokerStartRequestedAt: this.state.brokerStartRequestedAt,
      checkoutRunning: this.allStats().running > 0,
      atcPerTask: this.state.atcCookiesPerTask,
      externalAtcHarvesterEnabled: this.extensionHarvesterConfigured(),
    });
    const total = this.state.harvesters.length;
    const open = this.state.harvesterDrawerOpen;
    const configuredHarvesterIds = new Set(this.state.harvesters.map(item => String(item.id)));
    const runtimeHarvesters = this.state.bank && Array.isArray(this.state.bank.harvesters)
      ? this.state.bank.harvesters.filter(item => configuredHarvesterIds.has(String(item && item.id))) : [];
    const bandwidthSummary = targetBandwidthSummary(runtimeHarvesters, Date.now());
    const railStatusLabel = {
      ready: 'Ready',
      working: 'Active',
      filling: 'Filling',
      deficit: 'Needs ATC',
      paused: 'Paused',
      'over-target': 'Above target',
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
          const atcModeLabel = harvester.atcMode === 'v2' ? 'ATC+' : 'ATC';
          const typeLabel = harvester.type === 'atc' ? `Target ${atcModeLabel}`
            : harvester.type === 'login' ? 'Target Login' : `Automatic (${atcModeLabel})`;
          const modeLabel = harvesterModeLabel(harvester.engine);
          const schedule = harvester.startSchedule || harvester.stopSchedule
            ? `${harvester.startSchedule ? new Date(harvester.startSchedule).toLocaleString() : 'Now'} → ${harvester.stopSchedule ? new Date(harvester.stopSchedule).toLocaleString() : 'No stop'}`
            : 'Always';
          return (
            <article className={`target-harvester-card target-harvester-card-${state.kind}`} key={harvester.id}>
              <div className="target-harvester-identity">
                <span className="target-harvester-state-dot" />
                <span>
                  <strong>{harvester.name}</strong>
                  <small>{typeLabel} · {modeLabel} · {proxyLabelForRef(this.proxyLists(), harvester.proxyListName, 'Local')} · {schedule}</small>
                </span>
              </div>
              <span className={`group-status group-status-${state.kind}`}><span className="group-status-dot" />{state.label}</span>
              <div className="target-harvester-meta">
                <span><small>Workers</small><strong>{workerValue}</strong></span>
                <span><small>Produced</small><strong>{Number(produced.login) || 0} login · {Number(produced.atc) || 0} ATC</strong></span>
              </div>
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
          <>
            <div className="target-harvester-drawer-layer" onMouseDown={() => this.setHarvesterDrawerOpen(false)} />
            <aside id="target-harvester-drawer" className="target-harvester-drawer" aria-label="Cookie Harvesters">
              <header className="target-harvester-drawer-head">
                <span className="target-harvester-drawer-icon"><Icon name="cookie" size={18} /></span>
                <span><h2>Cookie Harvesters</h2><p>Independent typed workers feed the shared Target bank.</p></span>
                <button className="icon-action" title="Close Cookie Harvesters" aria-label="Close Cookie Harvesters" onClick={() => this.setHarvesterDrawerOpen(false)}><Icon name="close" size={14} /></button>
              </header>
              <div className="target-harvester-drawer-summary" aria-label="Harvester progress">
                <span><strong>{bank.activeHarvesters}/{total}</strong><small>Running</small></span>
                <span><strong>{bank.activeWorkers}</strong><small>Active workers</small></span>
              </div>
              <section className={`cookie-bank cookie-bank-prominent cookie-bank-${bank.state}`} title={bank.description} aria-label="Shared Target cookie bank">
                <span className="cookie-bank-copy">
                  <small>Shared Cookie Bank</small>
                  <strong>{bank.label}</strong>
                  <em>{bank.description}</em>
                </span>
                <span className="cookie-bank-counts">
                  <span><strong>{bank.login}</strong><small>Login</small></span>
                  <span title={bank.demandLabel}>
                    <strong>{bank.atc}/{bank.demandReported ? bank.atcTargetLabel : '—'}</strong>
                    <small>ATC</small>
                  </span>
                </span>
                <label
                  className="cookie-bank-limit"
                  title="Ready ATC cookies to keep for every active Target task, or configured standby task before a run. Zyn scales the total automatically. Set 0 for no bank limit."
                >
                  <span>ATC per task</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={this.state.atcCookiesPerTask}
                    aria-label="Target ATC cookies per task"
                    aria-describedby="target-atc-demand-formula"
                    onChange={event => this.setState({ atcCookiesPerTask: normalizeAtcCookiesPerTaskInput(event.target.value) })}
                    onBlur={this.saveAtcCookiesPerTask}
                    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  />
                  <small id="target-atc-demand-formula">{bank.demandLabel}</small>
                </label>
              </section>
              <section className="target-harvester-bandwidth-summary" aria-label="Proxy bandwidth telemetry"
                title="Browser-level transfer. Your proxy provider may report slightly more for tunnel and TLS overhead.">
                <header>
                  <span><strong>Proxy bandwidth</strong><small>Current harvester runs</small></span>
                  <em>{bandwidthSummary.available ? 'Wire download · estimated upload' : 'Waiting for harvester traffic'}</em>
                </header>
                <div>
                  <span><strong>{formatBandwidth(bandwidthSummary.proxyBytes)}</strong><small>Total proxy data</small></span>
                  <span><strong>{formatBandwidth(bandwidthSummary.bytesPerHour)}/hr</strong><small>Average rate</small></span>
                  <span><strong>{bandwidthSummary.proxyCookies ? formatBandwidth(bandwidthSummary.bytesPerProxyCookie) : '—'}</strong><small>Per cookie</small></span>
                  <span><strong>↓ {formatBandwidth(bandwidthSummary.proxyDownloadBytes)}</strong><small>↑ {formatBandwidth(bandwidthSummary.proxyUploadBytes)} est.</small></span>
                </div>
                <p>{bandwidthSummary.requests} network requests · {bandwidthSummary.blockedRequests} heavy assets blocked · {bandwidthSummary.failedRequests} failed · {bandwidthSummary.cachedRequests} cache hits
                  {bandwidthSummary.unmeasuredAttempts > 0 ? ` · ${bandwidthSummary.unmeasuredAttempts} pages unmeasured` : ''}
                  {bandwidthSummary.directBytes > 0 ? ` · ${formatBandwidth(bandwidthSummary.directBytes)} direct traffic excluded` : ''}</p>
              </section>
              <div className="target-harvester-drawer-toolbar">
                <button className="btn btn-primary btn-sm" onClick={this.openNewHarvester}><Icon name="plus" size={12} /> New Harvester</button>
              </div>
              <div className="target-harvester-drawer-content">{list}</div>
            </aside>
          </>
        )}
      </>
    );
  }

  renderGroupRow(group) {
    return (
      <TaskGroupOverviewRow
        key={group.id}
        host={this}
        group={group}
        scheduleNow={this.state.scheduleNow}
      />
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
        {this.renderReadinessModal()}
        {this.renderGroupModal()}
        {this.renderHarvesterModal()}
      </div>
    );
  }

  renderTaskRow(group, task) {
    return (
      <TaskGroupTaskRow
        key={task.id}
        host={this}
        group={group}
        task={task}
        selected={this.state.selectedTaskIds.includes(task.id)}
      />
    );
  }

  renderTaskDetail(group, task) {
    return (
      <TaskGroupTaskDetail
        host={this}
        group={group}
        task={task}
        copiedTask={this.state.copiedTask}
        readinessPending={this.state.readinessPending}
      />
    );
  }

  renderGroupDropPulse(group) {
    return <TaskGroupDropPulse group={group} />;
  }

  renderGroup(group) {
    const filter = this.state.taskFilter.trim().toLowerCase();
    const visibleTasks = (group.tasks || []).filter(task => !filter || this.accountLabel(task).toLowerCase().includes(filter));
    const selectedIds = new Set(this.state.selectedTaskIds);
    const selectedVisible = visibleTasks.filter(task => selectedIds.has(task.id));
    const selectedInGroup = (group.tasks || []).filter(task => selectedIds.has(task.id));
    const allVisibleSelected = visibleTasks.length > 0 && selectedVisible.length === visibleTasks.length;
    return (
      <div className="tasks-workspace tasks-workspace-with-harvester-dock">
        <div className="page-header task-view-header">
          <div>
            <button className="breadcrumb-back" onClick={() => this.setState({ selectedGroupId: '', selectedTaskId: '', selectedTaskIds: [], taskFilter: '' })}><Icon name="chevronDown" size={11} /> Task Groups</button>
            <div className="page-title"><span className="page-title-dot" /> {group.name}{this.renderScheduleChip(group)}</div>
            {this.renderGroupFacts(group)}
          </div>
          <div className="page-actions">
            <button className="btn btn-secondary btn-sm" disabled={this.state.readinessPending} onClick={() => this.runReadiness(group, group.tasks)}><Icon name="check" size={12} /> Check Readiness</button>
            <button className="btn btn-secondary btn-sm" onClick={() => this.openSchedule(group)}><Icon name="activity" size={12} /> Schedule</button>
            <button className="btn btn-secondary btn-sm" onClick={() => this.openEditGroup(group)}><Icon name="settings" size={12} /> Edit Group</button>
            <TaskGroupRunControls host={this} group={group} />
          </div>
        </div>
        <div className="page-content task-group-dashboard">
          <div className="panel group-task-panel">
            <div className="group-task-toolbar">
              <div><h2>Account tasks</h2></div>
              {this.renderGroupDropPulse(group)}
              <div className="page-actions">
                {(group.tasks || []).length > 0 && <input className="form-input task-filter" placeholder="Filter tasks…" value={this.state.taskFilter} onChange={event => this.setState({ taskFilter: event.target.value })} />}
                <button className="btn btn-primary btn-sm" onClick={() => this.openTaskModal(group)}><Icon name="plus" size={12} /> Add Tasks</button>
              </div>
            </div>
            {(group.tasks || []).length === 0 ? (
              <div className="group-tasks-empty"><span><Icon name="user" size={19} /></span><h3>No account tasks yet</h3><p>Add Target accounts to this group. Their checkout profiles are matched automatically by email.</p><button className="btn btn-primary btn-sm" onClick={() => this.openTaskModal(group)}>Add Tasks</button></div>
            ) : (
              <div>
                {selectedInGroup.length > 0 && (
                  <div className="group-task-bulk-bar">
                    <strong>{selectedInGroup.length} selected</strong>
                    <label className="group-task-bulk-proxy">
                      <span>Set proxy</span>
                      <select
                        className="form-select task-proxy-select"
                        defaultValue=""
                        key={selectedInGroup.map(task => task.id).join(',')}
                        onChange={event => {
                          const value = event.target.value;
                          if (value === '__keep') return;
                          this.updateTasksProxy(group, selectedInGroup, value === '__local' ? '' : value);
                          event.target.value = '__keep';
                        }}
                      >
                        <option value="__keep">Choose a proxy…</option>
                        {this.renderProxySelectOptions({ localValue: '__local', localLabel: 'Local' })}
                      </select>
                    </label>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.setState({ selectedTaskIds: [] })}>Clear selection</button>
                  </div>
                )}
                <div className="group-task-row group-task-table-head">
                  <span className="task-select-cell">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleTasks.length}
                      aria-label="Select all visible tasks"
                      ref={element => {
                        if (element) element.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                      }}
                      onChange={() => this.toggleSelectVisibleTasks(visibleTasks)}
                    />
                  </span>
                  <span>Account</span><span>Proxy</span><span>Loop</span><span>This run</span><span>Status</span><span>Created</span><span>Actions</span>
                </div>
                {visibleTasks.length ? (
                  <VirtualList
                    className="virtual-list group-task-virtual"
                    count={visibleTasks.length}
                    rowHeight={TASK_ROW_HEIGHT}
                    estimatedHeight={520}
                    renderRow={index => this.renderTaskRow(group, visibleTasks[index])}
                  />
                ) : <div className="table-empty" style={{ padding: 28 }}>No matching tasks.</div>}
              </div>
            )}
          </div>
          {showOperatorLogs(this.props.settings) ? <SharedEngineLog host={this} /> : null}
        </div>
        {this.renderHarvesterDrawer()}
        {this.renderReadinessModal()}
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
    const workerMaximum = harvesterWorkerMaximum(draft);
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
            <div className="form-group">
              <label className="form-label">Mode</label>
              <select className="form-select" value={harvesterEngineOf(draft.engine)} onChange={event => {
                const engine = harvesterEngineOf(event.target.value);
                const maximum = harvesterWorkerMaximum({ ...draft, engine });
                setDraft({ engine, workers: String(Math.min(maximum, clampInteger(draft.workers, 1, 100, 1))) });
              }}>
                {HARVESTER_ENGINES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              {harvesterEngineOf(draft.engine) === 'patchright' && (
                <div className="form-hint">Zyn opens the browser and assigns the proxy. You do not set up Chrome profiles or an extension.</div>
              )}
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
                  {this.renderProxySelectOptions({ localLabel: 'Local (no proxy)' })}
                  {proxyMissing && <option value={draft.proxyListName}>Unavailable: {draft.proxyListName}</option>}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Workers</label>
                <input className="form-input" type="number" min="1" max={workerMaximum} disabled={draft.type === 'login'} value={draft.type === 'login' ? '1' : draft.workers} onChange={event => setDraft({ workers: event.target.value })} />
                <div className="form-hint">{harvesterEngineOf(draft.engine) === 'patchright'
                  ? 'Experimental mode is capped at 2 local workers or 8 with proxies.'
                  : 'Local is capped at 2; proxy harvesters allow up to 100.'}</div>
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
            <div className="form-hint">Saving never starts a harvester. Use its Start button to arm it for this app session; a future schedule waits after you click Start.</div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={this.closeHarvesterModal}>Cancel</button>
            <button className="btn btn-primary" disabled={!String(draft.name || '').trim()} onClick={this.saveHarvester}><Icon name="check" size={12} /> {editing ? 'Save Changes' : 'Create Harvester'}</button>
          </div>
        </div>
      </div>
    );
  }

  renderProductHistoryPicker(draft) {
    const filter = this.state.productHistoryFilter.trim().toLowerCase();
    const selected = new Set(parseSkus(draft.skus));
    const history = this.state.productHistory.filter(item => {
      if (!filter) return true;
      return `${item.sku || ''} ${item.name || ''}`.toLowerCase().includes(filter);
    }).slice(0, filter ? 100 : 20);
    return (
      <div className="target-product-history">
        <div className="target-product-history-heading">
          <span><strong>Recently monitored</strong><small>Select products you have tracked before.</small></span>
          {this.state.productHistory.length > 4 && (
            <input
              className="form-input"
              type="search"
              aria-label="Search Target product history"
              placeholder="Search SKU or name…"
              value={this.state.productHistoryFilter}
              onChange={event => this.setState({ productHistoryFilter: event.target.value })}
            />
          )}
        </div>
        {history.length ? (
          <div className="target-product-history-list">
            {history.map(item => {
              const added = selected.has(item.sku);
              return (
                <button
                  className={added ? 'added' : ''}
                  type="button"
                  key={item.sku}
                  disabled={added}
                  onClick={() => this.addProductFromHistory(item.sku)}
                  title={item.name || `Target SKU ${item.sku}`}
                >
                  <span className="target-product-history-sku">{item.sku}</span>
                  <span className="target-product-history-name">
                    <strong className={item.name ? '' : 'pending'}>{item.name || 'Name not fetched yet'}</strong>
                    <small>{item.useCount > 1 ? `Monitored ${item.useCount} times` : 'Previously monitored'}</small>
                  </span>
                  <span className="target-product-history-action">{added ? 'Added' : 'Add'}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="target-product-history-empty">
            {filter ? 'No history matches that search.' : 'Products appear here after a Target monitor starts.'}
          </div>
        )}
      </div>
    );
  }

  renderReadinessModal() {
    const readiness = this.state.readiness;
    if (!readiness) return null;
    const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
    const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
    const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
    const blocked = blockers.length > 0 || readiness.level === 'blocked';
    const warning = !blocked && (warnings.length > 0 || readiness.level === 'warning');
    const readinessCounts = readiness.counts || {};
    const title = blocked ? 'Target is not ready' : warning ? 'Target readiness warnings' : 'Target is ready';
    const detail = blocked
      ? 'Fix the blockers below before starting these tasks.'
      : warning
        ? 'You can start now, but checkout may wait or use a less reliable route.'
        : `${readinessCounts.tasks || 0} task(s) and ${readinessCounts.skus || 0} SKU(s) passed preflight.`;
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeReadiness()}>
        <div className={`modal target-readiness-modal target-readiness-${blocked ? 'blocked' : warning ? 'warning' : 'ready'}`} onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">{title}</div><p>{detail}</p></div>
            <button className="modal-close" onClick={this.closeReadiness}>×</button>
          </div>
          <div className="modal-body">
            {!!blockers.length && (
              <section className="target-readiness-issues target-readiness-blockers">
                <h4>Blockers</h4>
                {blockers.map((item, index) => <div key={`${item.code || 'blocker'}-${index}`}><Icon name="warning" size={13} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></div>)}
              </section>
            )}
            {!!warnings.length && (
              <section className="target-readiness-issues target-readiness-warnings">
                <h4>Warnings</h4>
                {warnings.map((item, index) => <div key={`${item.code || 'warning'}-${index}`}><Icon name="warning" size={13} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></div>)}
              </section>
            )}
            {!!checks.length && (
              <section className="target-readiness-checks">
                <h4>Preflight checklist</h4>
                {checks.map((item, index) => (
                  <div className={`target-readiness-check target-readiness-check-${item.status || 'pass'}`} key={`${item.code || 'check'}-${index}`}>
                    <i>{item.status === 'pass' ? '✓' : item.status === 'fail' ? '×' : '!'}</i>
                    <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  </div>
                ))}
              </section>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={this.closeReadiness}>{blocked || this.state.readinessIntent !== 'start' ? 'Close' : 'Cancel'}</button>
            {this.state.readinessIntent === 'start' && !blocked && (
              <button className="btn btn-primary" onClick={this.continueReadinessStart}><Icon name="play" size={12} /> {warning ? 'Start Anyway' : 'Start Tasks'}</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  renderGroupModal() {
    if (!this.state.showGroupModal) return null;
    const draft = this.state.groupDraft;
    const editing = Boolean(this.state.editingGroupId);
    const editingGroup = editing
      ? this.state.groups.find(group => group.id === this.state.editingGroupId)
      : null;
    const controlsLocked = !!editingGroup
      && (editingGroup.tasks || []).some(task => targetTaskIsRunning(this.statusFor(task)));
    const watchedSkus = parseSkus(draft.skus);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeGroupModal()}>
        <div className="modal task-group-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header"><div><div className="modal-title">{editing ? 'Edit Target Group' : 'New Target Group'}</div><p>One shared watch list, with one checkout task per account.</p></div><button className="modal-close" onClick={this.closeGroupModal}>×</button></div>
          <div className="modal-body">
            <div className="form-group"><label className="form-label">Group name</label><input className="form-input" autoFocus={!editing} value={draft.name} placeholder="Friday drop" onChange={event => this.setState({ groupDraft: { ...draft, name: event.target.value } })} /></div>
            <div className="form-group target-sku-watch">
              <div className="target-sku-watch-heading">
                <span>
                  <label className="form-label">Watch list</label>
                  <small>Add TCINs or Target URLs. Remove a SKU to drop it from running tasks before payment.</small>
                </span>
                {controlsLocked && <em>Prices lock while tasks run. Add, remove, and priority still apply on save.</em>}
              </div>
              <form
                className="target-sku-add"
                onSubmit={event => {
                  event.preventDefault();
                  this.addWatchedSkus(this.state.skuInput);
                }}
              >
                <input
                  className="form-input"
                  autoFocus={editing}
                  value={this.state.skuInput}
                  placeholder="12345678 or https://www.target.com/p/…/-/A-87654321"
                  aria-label="Add Target SKUs or product URLs"
                  onChange={event => this.setState({ skuInput: event.target.value, skuInputError: '' })}
                  onPaste={event => {
                    const text = event.clipboardData && event.clipboardData.getData('text');
                    if (!text || !/[\n,]/.test(text)) return;
                    event.preventDefault();
                    this.addWatchedSkus(`${this.state.skuInput}\n${text}`);
                  }}
                />
                <button type="submit" className="btn btn-secondary">Add</button>
              </form>
              {!!this.state.skuInputError && <div className="form-hint target-sku-add-error">{this.state.skuInputError}</div>}
              {watchedSkus.length ? (
                <div className="target-sku-watch-list">
                  {watchedSkus.map(sku => {
                    const rawPrice = (draft.maxPrices || {})[sku] || '';
                    const invalid = normalizeMaxPrice(rawPrice) === null;
                    const priority = (draft.priorities || {})[sku] === true;
                    const name = this.productNameForSku(sku);
                    return (
                      <div className={`target-sku-watch-row${invalid ? ' invalid' : ''}${priority ? ' priority' : ''}`} key={sku}>
                        <button
                          type="button"
                          className={`target-sku-priority${priority ? ' active' : ''}`}
                          aria-pressed={priority}
                          aria-label={`${priority ? 'Remove priority from' : 'Mark as priority'} Target SKU ${sku}`}
                          onClick={() => this.setSkuPriority(sku, !priority)}
                        >
                          <Icon name="star" size={11} />
                          {priority ? 'Priority' : 'Normal'}
                        </button>
                        <span className="target-sku-watch-identity">
                          <strong className={name ? '' : 'pending'}>{name || 'Name not fetched yet'}</strong>
                          <small>{sku}</small>
                        </span>
                        <label className="target-sku-price-input">
                          <i>$</i>
                          <input
                            className="form-input"
                            type="text"
                            inputMode="decimal"
                            disabled={controlsLocked}
                            value={rawPrice}
                            placeholder="No max"
                            aria-label={`Maximum price for Target SKU ${sku}`}
                            onChange={event => this.setSkuMaxPrice(sku, event.target.value)}
                            onBlur={() => {
                              const normalized = normalizeMaxPrice(rawPrice);
                              if (normalized !== null) this.setSkuMaxPrice(sku, normalized);
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm target-sku-remove"
                          aria-label={`Remove Target SKU ${sku}`}
                          onClick={() => this.removeSku(sku)}
                        >
                          <Icon name="trash" size={11} /> Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="target-sku-watch-empty">No SKUs yet. Paste a TCIN or pick one from recently monitored.</div>
              )}
            </div>
            {this.renderProductHistoryPicker(draft)}
            <div className="form-row">
              <div className="form-group"><label className="form-label">Quantity per SKU</label><input className="form-input" type="number" min="1" max="99" value={draft.qty} onChange={event => this.setState({ groupDraft: { ...draft, qty: event.target.value } })} /></div>
              <div className="form-group"><label className="form-label">Default proxy</label><select className="form-select" value={draft.proxyListName} onChange={event => this.setState({ groupDraft: { ...draft, proxyListName: event.target.value } })}>{this.renderProxySelectOptions()}</select></div>
            </div>
            <div className="form-group">
              <label className="form-label">Stock confidence</label>
              <select
                className="form-select"
                value={draft.stockConfidence || 'any'}
                disabled={controlsLocked}
                onChange={event => this.setState({ groupDraft: { ...draft, stockConfidence: event.target.value } })}
              >
                <option value="any">Any in-stock signal</option>
                <option value="confirmed-10-plus">Confirmed 10+ units</option>
              </select>
              <div className="form-hint">Confirmed 10+ ignores low or unknown stock quantities. This applies to every SKU in the group.</div>
            </div>
            <label className={`task-repeat-toggle task-repeat-toggle-modal${draft.loopCheckout ? ' enabled' : ''}`}>
              <input type="checkbox" checked={draft.loopCheckout === true} onChange={event => this.setState({ groupDraft: { ...draft, loopCheckout: event.target.checked } })} />
              <span><strong>Loop checkout by default</strong><small>When changed, this applies to every task in the group. Individual tasks can be overridden afterward. Looping stops as each account reaches two orders per SKU in four hours.</small></span>
            </label>
            <label className={`task-repeat-toggle task-repeat-toggle-modal${draft.useFillerItem ? ' enabled' : ''}`}>
              <input type="checkbox" checked={draft.useFillerItem === true} onChange={event => this.setState({ groupDraft: { ...draft, useFillerItem: event.target.checked } })} />
              <span><strong>Pre-cart filler item</strong><small>Add one of Target SKU 84704409 before waiting for a watched product. The native engine attempts to remove the filler after checkout.</small></span>
            </label>
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
    const selectableIds = this.selectableAccountIds(group);
    const selectedIds = new Set(this.state.selectedAccounts.map(String));
    const allSelectableSelected = selectableIds.length > 0
      && selectableIds.every(id => selectedIds.has(String(id)));
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.setState({ showTaskModal: false })}>
        <div className="modal task-create-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header"><div><div className="modal-title">Add Account Tasks</div><p>Select one or more Target accounts for “{group.name}”.</p></div><button className="modal-close" onClick={() => this.setState({ showTaskModal: false })}>×</button></div>
          <div className="modal-body">
            <div className="task-create-summary"><span><Icon name="user" size={14} /> {this.state.selectedAccounts.length} selected</span><strong>{accounts.length} Target accounts</strong></div>
            <div className="form-group"><label className="form-label">Proxy for new tasks</label><select className="form-select" value={this.state.taskProxy} onChange={event => this.setState({ taskProxy: event.target.value })}>{this.renderProxySelectOptions()}</select></div>
            <label className={`task-repeat-toggle task-repeat-toggle-modal${this.state.taskLoopCheckout ? ' enabled' : ''}`}>
              <input type="checkbox" checked={this.state.taskLoopCheckout === true} onChange={event => this.setState({ taskLoopCheckout: event.target.checked })} />
              <span><strong>Loop checkout for these tasks</strong><small>After a checkout or decline, keep trying eligible SKUs. Confirmed orders stop at two per account, per SKU, within four hours.</small></span>
            </label>
            <div className="task-account-section-head">
              <div className="form-label task-account-section-label">Accounts</div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!selectableIds.length}
                onClick={this.toggleSelectAllAccounts}>
                {allSelectableSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>
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

class GroupMonitorStatusView extends Component {
  render() {
    const monitor = this.props.monitorStatus;
    if (!monitor) return null;
    const tone = targetStatusTone(monitor);
    const label = monitor.label || monitor.state || 'Idle';
    return (
      <span className={`group-ops-monitor group-ops-monitor-${tone}`} title={`Monitor: ${label}`}>
        <small>Monitor</small>
        <strong>{label}</strong>
      </span>
    );
  }
}

const GroupMonitorStatus = connect(state => ({
  monitorStatus: state.target.monitorStatus,
}))(GroupMonitorStatusView);

class SharedEngineLogView extends Component {
  render() {
    return this.props.host.renderSharedEngineLog(this.props);
  }
}

const SharedEngineLog = connect(state => ({
  targetLogs: state.target.logs,
  monitorStatus: state.target.monitorStatus,
  monitorBandwidth: state.target.monitorBandwidth,
}))(SharedEngineLogView);

export default connect(state => ({
  accounts: state.accounts,
  profiles: state.profiles,
  proxies: state.proxies,
  settings: state.settings,
}))(TaskGroups);
