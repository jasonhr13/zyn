import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
import VirtualList, { TASK_ROW_HEIGHT } from '../virtual-list';
import InlineSelect from '../inline-select';
import { connectEngineLog, connectTaskLog, pickTableState } from '../module-table-state';
import { showOperatorLogs } from '../operator-logs';
import Icon from '../icon';
const { ipcRenderer } = window.require('electron');

const COSTCO_TABLE_KEYS = Object.freeze([
  'productUrl', 'tasks', 'taskStatus', 'taskLogs', 'monitorDelay', 'retryDelay',
  'openBrowserOnPass',
]);
const CostcoEngineLog = connectEngineLog('costco');
const CostcoTaskLog = connectTaskLog('costco');
const uid = () => 'cs_' + Math.random().toString(36).slice(2, 10);
const LOCAL_SENTINEL = '__local__';
const TASK_COLS = '28px 240px minmax(160px, 1fr) 185px';

function normalizeCostcoUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    if (host === 'costco.com' || host.endsWith('.costco.com')) return parsed.href;
    if (host === 'costco.ca' || host.endsWith('.costco.ca')) return parsed.href;
    if (host.endsWith('.queue-it.net') || host.includes('queue-it')) return parsed.href;
    return '';
  } catch {
    return '';
  }
}

function Status({ value }) {
  const color = (value && value.color) || '#6b7280';
  const label = (value && (value.label || value.state)) || 'Idle';
  const detail = String((value && value.detail) || '').trim();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color, fontSize: 11, fontWeight: 650, minWidth: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: '0 0 auto' }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}{detail && detail !== label ? ` · ${detail}` : ''}
      </span>
    </span>
  );
}

class Costco extends Component {
  state = {
    draftCount: '10', draftProxy: '',
    expanded: null, notice: '', setupOpen: true,
    selected: {}, anchorId: null,
  };

  componentDidMount() {
    try {
      const saved = ipcRenderer.sendSync('getCostcoTasks') || {};
      this.props.dispatch({ type: 'costcoSet', obj: {
        productUrl: String(saved.productUrl || ''),
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        monitorDelay: String(saved.monitorDelay || '2000'),
        retryDelay: String(saved.retryDelay || '2000'),
        openBrowserOnPass: saved.openBrowserOnPass !== false,
      } });
      this.setState({
        setupOpen: saved.setupOpen !== false,
        draftCount: String(saved.draftCount || '10'),
        draftProxy: String(saved.draftProxy || ''),
      });
    } catch {}
  }

  componentWillUnmount() {
    this.flushPersist();
    clearTimeout(this.noticeTimer);
  }

  persist = (over = {}) => {
    this.pendingPersist = { ...(this.pendingPersist || {}), ...over };
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(this.flushPersist, 400);
  };

  flushPersist = () => {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = 0;
    }
    const over = this.pendingPersist || {};
    this.pendingPersist = null;
    const payload = { ...this.props.costco, ...over };
    try {
      ipcRenderer.sendSync('saveCostcoTasks', {
        productUrl: payload.productUrl,
        tasks: payload.tasks,
        monitorDelay: payload.monitorDelay,
        retryDelay: payload.retryDelay,
        openBrowserOnPass: payload.openBrowserOnPass !== false,
        setupOpen: payload.setupOpen !== undefined ? payload.setupOpen !== false : this.state.setupOpen !== false,
        draftCount: this.state.draftCount,
        draftProxy: this.state.draftProxy,
      });
    } catch {}
  };

  setModule = (key, value) => {
    this.props.dispatch({ type: 'costcoSet', obj: { [key]: value } });
    this.persist({ [key]: value });
  };

  flash = notice => {
    this.setState({ notice });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.setState({ notice: '' }), 3500);
  };

  sharedConfig = (over = {}) => {
    const c = { ...this.props.costco, ...over };
    return {
      productUrl: String(c.productUrl || '').trim(),
      monitorDelay: String(c.monitorDelay || '2000'),
      retryDelay: String(c.retryDelay || '2000'),
      openBrowserOnPass: c.openBrowserOnPass !== false,
      mode: 'Queue Runner',
    };
  };

  createTasks = () => {
    const count = Math.max(1, Math.min(500, parseInt(this.state.draftCount, 10) || 1));
    const tasks = [];
    for (let i = 0; i < count; i += 1) {
      tasks.push({ id: uid(), proxyListName: this.state.draftProxy });
    }
    const next = [...(this.props.costco.tasks || []), ...tasks];
    this.props.dispatch({ type: 'costcoTasksAdd', tasks });
    this.persist({ tasks: next });
    this.flash(`Created ${count} task${count === 1 ? '' : 's'}`);
  };

  updateTask = (task, obj) => {
    const tasks = this.props.costco.tasks.map(value => value.id === task.id ? { ...value, ...obj } : value);
    this.props.dispatch({ type: 'costcoSet', obj: { tasks } });
    this.persist({ tasks });
    if (!this.props.costco.taskStatus[task.id]) return;
    if (Object.prototype.hasOwnProperty.call(obj, 'proxyListName')) {
      const ok = ipcRenderer.sendSync('setCostcoTaskProxy', task.id, obj.proxyListName);
      this.flash(ok ? 'Proxy update sent to the running task' : 'Proxy update could not reach the engine');
    }
  };

  toggleSelected = id => this.setState(({ selected }) => {
    const next = { ...selected };
    if (next[id]) delete next[id]; else next[id] = true;
    return { selected: next, anchorId: id };
  });

  selectRange = (tasks, id) => this.setState(({ selected, anchorId }) => {
    const ids = tasks.map(task => task.id);
    const to = ids.indexOf(id);
    if (to < 0) return null;
    const from = ids.indexOf(anchorId);
    if (from < 0) return { selected: { ...selected, [id]: true }, anchorId: id };
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const next = { ...selected };
    for (let i = lo; i <= hi; i++) next[ids[i]] = true;
    return { selected: next };
  });

  toggleSelectAll = () => this.setState(({ selected }) => {
    const tasks = this.props.costco.tasks || [];
    const allOn = tasks.length > 0 && tasks.every(task => selected[task.id]);
    if (allOn) return { selected: {}, anchorId: null };
    const next = {};
    for (const task of tasks) next[task.id] = true;
    return { selected: next };
  });

  selectedTasks = () => {
    const { selected } = this.state;
    return (this.props.costco.tasks || []).filter(task => selected[task.id]);
  };

  bulkSetProxy = name => {
    const list = this.selectedTasks();
    if (!list.length) return;
    const ids = new Set(list.map(task => String(task.id)));
    const tasks = (this.props.costco.tasks || []).map(task =>
      ids.has(String(task.id)) ? { ...task, proxyListName: name } : task);
    this.props.dispatch({ type: 'costcoSet', obj: { tasks } });
    this.persist({ tasks });
    let sent = 0;
    for (const task of list) {
      if (!this.props.costco.taskStatus[task.id]) continue;
      if (ipcRenderer.sendSync('setCostcoTaskProxy', task.id, name)) sent += 1;
    }
    if (sent) this.flash(`Proxy update sent to ${sent} running task${sent === 1 ? '' : 's'}`);
  };

  removeTask = task => {
    if (this.props.costco.taskStatus[task.id]) ipcRenderer.sendSync('stopCostco', task.id);
    const tasks = this.props.costco.tasks.filter(value => value.id !== task.id);
    this.props.dispatch({ type: 'costcoTaskDelete', id: task.id });
    this.persist({ tasks });
  };

  removeSelected = () => {
    const list = this.selectedTasks();
    if (!list.length) return;
    const ids = new Set(list.map(task => String(task.id)));
    for (const task of list) {
      if (this.props.costco.taskStatus[task.id]) ipcRenderer.sendSync('stopCostco', task.id);
    }
    const tasks = (this.props.costco.tasks || []).filter(task => !ids.has(String(task.id)));
    const taskStatus = { ...this.props.costco.taskStatus };
    const taskLogs = { ...this.props.costco.taskLogs };
    for (const id of ids) {
      delete taskStatus[id];
      delete taskLogs[id];
    }
    this.props.dispatch({ type: 'costcoSet', obj: { tasks, taskStatus, taskLogs } });
    this.persist({ tasks });
    this.setState(state => ({
      selected: {},
      anchorId: null,
      expanded: ids.has(String(state.expanded)) ? null : state.expanded,
    }));
    this.flash(`Deleted ${list.length} task${list.length === 1 ? '' : 's'}`);
  };

  start = tasks => {
    const url = normalizeCostcoUrl(this.props.costco.productUrl);
    if (!url) {
      this.flash('Paste a Costco product URL or Queue-it waiting-room URL');
      return;
    }
    if (!tasks.length) {
      this.flash('Create tasks first');
      return;
    }
    const ok = ipcRenderer.sendSync('startCostco', { ...this.sharedConfig(), productUrl: url, tasks });
    if (ok) {
      this.props.dispatch({ type: 'costcoLaunch', taskIds: tasks.map(task => task.id) });
      this.setState({ expanded: tasks[0] && tasks[0].id });
    } else this.flash('The Costco engine did not start');
  };

  stop = taskId => { ipcRenderer.sendSync('stopCostco', taskId); };

  taskRunning = task => {
    const status = this.props.costco.taskStatus[task && task.id];
    return !!(status && status.running !== false);
  };

  renderTaskRow = (task, { proxyOptions, tasks }) => {
    const status = this.props.costco.taskStatus[task.id];
    const active = status && status.running !== false;
    const open = this.state.expanded === task.id;
    const picked = !!this.state.selected[task.id];
    return (
      <div key={task.id} className={`site-task-row${picked ? ' is-selected' : ''}`} style={{ display: 'grid', gridTemplateColumns: TASK_COLS, gap: 10 }}>
        <input
          type="checkbox"
          checked={picked}
          onClick={event => {
            event.stopPropagation();
            if (!event.shiftKey) return;
            event.preventDefault();
            try { window.getSelection().removeAllRanges(); } catch {}
            this.selectRange(tasks, task.id);
          }}
          onChange={event => { event.stopPropagation(); this.toggleSelected(task.id); }}
          title="Select task"
        />
        <div style={{ minWidth: 0 }}>
          <InlineSelect
            className="form-select"
            value={task.proxyListName || ''}
            placeholder="Local (no proxy)"
            options={proxyOptions}
            onChange={value => this.updateTask(task, { proxyListName: value })}
          />
        </div>
        <Status value={status} />
        <span style={{ display: 'flex', gap: 5 }}>
          {active
            ? <button className="btn btn-secondary btn-sm" onClick={() => this.stop(task.id)}>Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={() => this.start([task])}>Start</button>}
          {showOperatorLogs(this.props.settings) && (
            <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ expanded: open ? null : task.id })}>Log</button>
          )}
          <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeTask(task)} title="Delete task"><i className="ion-md-trash" /></button>
        </span>
      </div>
    );
  };

  render() {
    const { costco, proxies } = this.props;
    const { draftCount, draftProxy, expanded, notice, setupOpen } = this.state;
    const tasks = costco.tasks || [];
    const proxyLists = (proxies && proxies.lists) || [];
    const proxyOptions = [{ value: '', label: 'Local (no proxy)' }, ...proxyLists.map(proxy => ({ value: proxyRef(proxy), label: proxyLabel(proxy) }))];
    const urlOk = !!normalizeCostcoUrl(costco.productUrl);
    const running = tasks.some(this.taskRunning);

    return (
      <div className="page" style={{ padding: '16px 20px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="page-header" style={{ marginBottom: 14 }}>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}><span className="page-title-dot" /> Costco</h1>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Paste the product or waiting-room URL when the room opens. Each task is one unique queue session. On pass, a headed browser opens on that same proxy.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notice && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{notice}</span>}
            <button className="btn btn-secondary" onClick={() => this.setState({ setupOpen: !setupOpen })}>
              {setupOpen ? 'Hide setup' : 'Show setup'}
            </button>
            {running
              ? <button className="btn btn-danger" onClick={() => this.stop()}><Icon name="stop" size={13} /> Stop Tasks</button>
              : <button className="btn btn-primary" onClick={() => this.start(tasks)} disabled={!tasks.length}><Icon name="play" size={13} /> Start All</button>}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {setupOpen && <div className="panel" style={{ margin: '0 0 14px', padding: 14, display: 'grid', gridTemplateColumns: '1fr 140px 140px 220px auto', gap: 12, alignItems: 'end' }}>
            <label className="form-group" style={{ margin: 0 }}>
              <span className="form-label">Product / waiting-room URL</span>
              <input
                className="form-input"
                value={costco.productUrl || ''}
                placeholder="https://www.costco.com/… or https://costco.queue-it.net/?c=costco&e=…"
                onChange={e => this.setModule('productUrl', e.target.value)}
              />
            </label>
            <label className="form-group" style={{ margin: 0 }}>
              <span className="form-label">Poll delay ms</span>
              <input className="form-input" value={costco.monitorDelay || '2000'} onChange={e => this.setModule('monitorDelay', e.target.value.replace(/\D/g, ''))} />
            </label>
            <label className="form-group" style={{ margin: 0 }}>
              <span className="form-label">Tasks to create</span>
              <input className="form-input" value={draftCount} onChange={e => this.setState({ draftCount: e.target.value.replace(/\D/g, '') })} />
            </label>
            <label className="form-group" style={{ margin: 0 }}>
              <span className="form-label">Proxy for new tasks</span>
              <select className="form-select" value={draftProxy} onChange={e => this.setState({ draftProxy: e.target.value })}>
                <option value="">Local (no proxy)</option>
                {proxyLists.map(proxy => <option key={proxyRef(proxy)} value={proxyRef(proxy)}>{proxyLabel(proxy)}</option>)}
              </select>
            </label>
            <button className="btn btn-primary" onClick={this.createTasks}>Create tasks</button>
            <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
              <input
                type="checkbox"
                checked={costco.openBrowserOnPass !== false}
                onChange={e => this.setModule('openBrowserOnPass', e.target.checked)}
              />
              Open a headed browser on queue pass (same proxy + cookies)
            </label>
            {!urlOk && costco.productUrl ? (
              <span style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--danger)' }}>
                Use a costco.com / costco.ca product URL or a Queue-it waiting-room URL.
              </span>
            ) : null}
          </div>}

          <div className="panel" style={{ margin: 0, display: 'flex', flexDirection: 'column', minHeight: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', height: 40, borderBottom: '1px solid var(--panel-border)' }}>
              <span style={{ fontSize: 12, fontWeight: 650 }}>{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary btn-sm" onClick={this.toggleSelectAll}>Select all</button>
                {this.selectedTasks().length > 0 && (
                  <>
                    <InlineSelect
                      className="form-select"
                      value={LOCAL_SENTINEL}
                      placeholder="Set proxy list"
                      options={[{ value: LOCAL_SENTINEL, label: 'Set proxy list' }, ...proxyOptions]}
                      onChange={value => { if (value !== LOCAL_SENTINEL) this.bulkSetProxy(value); }}
                    />
                    <button className="btn btn-secondary btn-sm" onClick={this.removeSelected}>
                      Delete {this.selectedTasks().length}
                    </button>
                  </>
                )}
              </span>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: TASK_COLS, gap: 10, padding: '8px 14px',
              fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em',
            }}>
              <span />
              <span>Proxy</span>
              <span>Status</span>
              <span />
            </div>
            <VirtualList
              className="virtual-list site-task-virtual"
              count={tasks.length}
              rowHeight={TASK_ROW_HEIGHT}
              estimatedHeight={480}
              renderRow={index => this.renderTaskRow(tasks[index], { proxyOptions, tasks })}
            />
            {expanded && showOperatorLogs(this.props.settings) && (
              <div style={{ borderTop: '1px solid var(--panel-border)', height: 180 }}>
                <CostcoTaskLog taskId={expanded} />
              </div>
            )}
          </div>

          {showOperatorLogs(this.props.settings) && (
            <div className="panel" style={{ marginTop: 14, height: 160 }}>
              <CostcoEngineLog />
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default connect(state => ({
  costco: pickTableState(state.costco, COSTCO_TABLE_KEYS),
  proxies: state.proxies,
  settings: state.settings,
}))(Costco);
