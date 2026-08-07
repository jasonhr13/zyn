import React, { Component } from 'react';
import { connect } from 'react-redux';
import CreateTaskModal from './tasks-components/create-modal';
import TaskCard from './tasks-components/task-card';
import { freshPool } from '../store';
import { claimLinksShared, sharedPoolDepth } from '../queue-pass-client';
const { ipcRenderer } = window.require('electron');

const STATUS_COLORS = { connected: '#4ade80', connecting: '#fbbf24', error: '#f87171', no_token: '#6b7280', disconnected: '#6b7280' };
const STATUS_LABELS = { connected: 'Discord connected', connecting: 'Connecting…', error: 'Discord error', no_token: 'No token set', disconnected: 'Discord disconnected' };

// Queue-It bypass tokens are single-use. freshPool/claimLinks live in the store so that claiming is
// atomic against the live state — see the comment on claimLinks. Never select links from props.

class Tasks extends Component {
  state = {
    showCreate: false,
    editTask: null,
    waitingIds: new Set(),  // tasks armed by user, waiting for a queue pass URL
    sharedPool: null,       // links available in the shared pool; null = not reached yet
  };

  componentDidMount() {
    this.pollSharedPool();
    // Slow poll: this only drives the header readout, so a user can tell at a glance that they're
    // connected to the pool and how many links are waiting.
    this.poolStatusTimer = setInterval(this.pollSharedPool, 10000);
  }

  pollSharedPool = async () => {
    try {
      const { shared } = await sharedPoolDepth();
      if (shared !== this.state.sharedPool) this.setState({ sharedPool: shared });
    } catch { /* leave the last known value */ }
  };

  componentDidUpdate(prevProps, prevState) {
    const poolGrew = this.props.cartUrlPool.length > prevProps.cartUrlPool.length;
    const waitingGrew = this.state.waitingIds.size > prevState.waitingIds.size;
    // No `cartUrlPool.length > 0` gate any more: links can come from the SHARED pool, which this
    // client cannot see by inspecting local state. Gating on the local pool meant a user without a
    // Discord token — whose local pool is empty forever — had armed tasks that never fired even
    // when the shared pool was full.
    if (poolGrew || waitingGrew) this.tryDistribute();
    this.syncArmedPoll();
  }

  componentWillUnmount() {
    if (this.armedPoll) clearInterval(this.armedPoll);
    if (this.poolStatusTimer) clearInterval(this.poolStatusTimer);
  }

  // While anything is armed, poll for links. Local passes arrive by IPC and re-render us, but a
  // shared-pool link produces no local event at all, so without this an armed task would wait
  // forever on a client that isn't watching Discord itself. Runs only while tasks are armed.
  armedPoll = null;

  syncArmedPoll = () => {
    const armed = this.state.waitingIds.size > 0;
    if (armed && !this.armedPoll) {
      this.armedPoll = setInterval(this.tryDistribute, 3000);
    } else if (!armed && this.armedPoll) {
      clearInterval(this.armedPoll);
      this.armedPoll = null;
    }
  };

  // The shared claim is async (network), so this can be re-entered by another pass arriving while a
  // claim is in flight. Without this guard both runs would target the same armed tasks and fire them
  // twice — the guard, not the pool, is what makes that safe.
  distributing = false;

  tryDistribute = async () => {
    if (this.distributing) return;
    // Only fire tasks the user EXPLICITLY armed. (Previously this also auto-fired any idle/done task,
    // so during a live drop every finished/stopped task got re-spawned on each incoming pass —
    // "browsers keep opening until I delete the task". Each armed task now fires exactly once.)
    const candidates = this.props.tasks.filter(t => this.state.waitingIds.has(t.id));
    if (!candidates.length) return;

    this.distributing = true;
    try {
      // Claim first, then fire — each link is exclusive before any browser opens.
      const links = await claimLinksShared(candidates.length);
      if (!links.length) return;

      this.setState(prev => {
        const newWaiting = new Set(prev.waitingIds);
        links.forEach((link, i) => {
          const task = candidates[i];
          if (!task || !newWaiting.has(task.id)) return;   // disarmed while we were claiming
          ipcRenderer.send('startTask', { id: task.id, cartUrl: link.cartUrl, proxy: link.proxy });
          newWaiting.delete(task.id);
        });
        return { waitingIds: newWaiting };
      });
    } finally {
      this.distributing = false;
    }
  };

  openCreate = () => this.setState({ showCreate: true, editTask: null });
  closeModal = () => this.setState({ showCreate: false, editTask: null });

  handleCreate = (data) => {
    // data may be a single task or an array (groups / multiple-of-one)
    const list = Array.isArray(data) ? data : [data];
    const created = list.map(d => ipcRenderer.sendSync('createTask', d));
    this.props.dispatch({ type: 'update', obj: { tasks: [...this.props.tasks, ...created] } });
    this.closeModal();
  };

  handleEdit = (task) => this.setState({ editTask: task, showCreate: true });

  handleUpdate = (id, data) => {
    ipcRenderer.sendSync('updateTask', { id, data });
    const tasks = this.props.tasks.map(t => t.id === id ? { ...t, ...data } : t);
    this.props.dispatch({ type: 'update', obj: { tasks } });
    this.closeModal();
  };

  handleDelete = (id) => {
    ipcRenderer.sendSync('deleteTask', id);
    this.setState(prev => {
      const w = new Set(prev.waitingIds);
      w.delete(id);
      return { waitingIds: w };
    });
    this.props.dispatch({ type: 'update', obj: { tasks: this.props.tasks.filter(t => t.id !== id) } });
  };

  handleStart = async (id) => {
    // Exclusive claim — clicking Start on several tasks in a row previously read a stale props
    // snapshot each time and gave every one of them the same freshest link.
    const [link] = await claimLinksShared(1);
    if (link) {
      ipcRenderer.send('startTask', { id, cartUrl: link.cartUrl, proxy: link.proxy });
    } else {
      // Arm this task — it fires when the next queue pass hits Discord. Pull the latest from the
      // channel now in case a fresh pass was posted before/between live events.
      this.setState(prev => ({ waitingIds: new Set([...prev.waitingIds, id]) }));
      ipcRenderer.send('refreshQueuePasses');
    }
  };

  handleFireNow = (id) => {
    // Fire immediately with no queue URL — bot skips Queue-It step and goes straight to product page
    ipcRenderer.send('startTask', { id, cartUrl: '--no-queue' });
  };

  handleStop = (id) => {
    if (this.state.waitingIds.has(id)) {
      // Task was only armed, not running — just disarm it
      this.setState(prev => {
        const w = new Set(prev.waitingIds);
        w.delete(id);
        return { waitingIds: w };
      });
    } else {
      ipcRenderer.sendSync('stopTask', id);
    }
  };

  handleArmAll = async () => {
    const notRunning = this.props.tasks.filter(t => {
      const s = (this.props.taskStatus[t.id] || {}).status;
      return s !== 'running';
    });
    if (!notRunning.length) return;

    // Claim up front so each task gets a distinct link; whatever we couldn't cover gets armed.
    const links = await claimLinksShared(notRunning.length);
    links.forEach((link, i) => {
      ipcRenderer.send('startTask', { id: notRunning[i].id, cartUrl: link.cartUrl, proxy: link.proxy });
    });
    const toArm = notRunning.slice(links.length);
    this.setState({ waitingIds: new Set(toArm.map(t => t.id)) });
    if (toArm.length) ipcRenderer.send('refreshQueuePasses'); // pull latest for the armed remainder
  };

  handleStopAll = () => {
    this.setState({ waitingIds: new Set() });
    this.props.tasks.forEach(t => {
      if ((this.props.taskStatus[t.id] || {}).status === 'running') {
        ipcRenderer.sendSync('stopTask', t.id);
      }
    });
  };

  handleClearLogs = (id) => {
    const taskLogs = { ...this.props.taskLogs, [id]: [] };
    this.props.dispatch({ type: 'update', obj: { taskLogs } });
  };

  get stats() {
    let confirmed = 0, declined = 0, running = 0;
    Object.values(this.props.taskStatus).forEach(ts => {
      Object.values(ts.threads || {}).forEach(th => {
        if (th.status === 'confirmed') confirmed++;
        else if (th.status === 'declined') declined++;
        else if (th.status === 'running') running++;
      });
    });
    return { confirmed, declined, running };
  }

  render() {
    const { tasks, taskStatus, taskLogs, discordStatus, cartUrlPool } = this.props;
    const { showCreate, editTask, waitingIds, sharedPool } = this.state;
    const ds = discordStatus || { status: 'disconnected' };
    const { confirmed, declined, running } = this.stats;
    const freshCount = freshPool(cartUrlPool).length; // usable (fresh, unspent) links only

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title">
            <span className="page-title-dot" />
            Secret Lair
            {tasks.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400 }}>
                — {tasks.length} task{tasks.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          <div className="page-actions">
            {/* Link source. Only the operator runs a Discord bot — everyone else claims from the
                shared pool and has no token by design, so showing them "No token set" reads as a
                fault when nothing is wrong. Without a token we report the pool they actually
                depend on instead. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginRight: 8 }}>
              {ds.status === 'no_token' ? (
                <>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: sharedPool === null ? '#6b7280' : '#4ade80' }} />
                  <span style={{ fontSize: 11, color: 'var(--text)' }}>
                    {sharedPool === null ? 'Connecting to link pool…' : 'Link pool connected'}
                  </span>
                  {sharedPool !== null && (
                    <span style={{ fontSize: 11, color: 'var(--text2)' }}>({sharedPool} available)</span>
                  )}
                </>
              ) : (
                <>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[ds.status] || '#6b7280', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--text)' }}>{STATUS_LABELS[ds.status] || ds.status}</span>
                  {ds.tag && <span style={{ fontSize: 11, color: 'var(--text2)' }}>({ds.tag})</span>}
                </>
              )}
            </div>

            {/* Pool indicator — only fresh, unspent links are actually usable */}
            {freshCount > 0 && (
              <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 600 }}>
                {freshCount} URL{freshCount !== 1 ? 's' : ''} queued
              </span>
            )}

            {/* Waiting indicator */}
            {waitingIds.size > 0 && (
              <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>
                {waitingIds.size} waiting
              </span>
            )}

            {/* Stats */}
            {(confirmed > 0 || declined > 0 || running > 0) && (
              <div style={{ display: 'flex', gap: 10 }}>
                {confirmed > 0 && <span style={{ fontSize: 11 }}><strong className="text-success">{confirmed}</strong> hit</span>}
                {declined > 0 && <span style={{ fontSize: 11 }}><strong className="text-danger">{declined}</strong> dec</span>}
                {running > 0 && <span style={{ fontSize: 11 }}><strong className="text-warning">{running}</strong> run</span>}
              </div>
            )}

            {tasks.length > 0 && (
              <>
                <button className="btn btn-success btn-sm" onClick={this.handleArmAll}>
                  <i className="ion-md-play" style={{ fontSize: 11 }} /> Arm All
                </button>
                <button className="btn btn-secondary btn-sm" onClick={this.handleStopAll}>
                  <i className="ion-md-square" style={{ fontSize: 11 }} /> Stop All
                </button>
              </>
            )}

            <button className="btn btn-primary btn-sm" onClick={this.openCreate}>
              <i className="ion-md-add" style={{ fontSize: 13 }} /> New Task
            </button>
          </div>
        </div>

        <div className="page-content">
          {tasks.length === 0 ? (
            <div className="table-wrap">
              <div className="table-empty">
                <div className="table-empty-icon"><i className="ion-md-list" /></div>
                <div className="table-empty-text">No tasks yet</div>
                <div className="table-empty-sub">Each task = 1 profile = 1 checkout. Arm tasks and they fire automatically when a queue pass URL arrives in Discord.</div>
              </div>
            </div>
          ) : (
            <div className="task-cards">
              {tasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  taskStatus={taskStatus}
                  taskLogs={taskLogs}
                  profiles={this.props.profiles}
                  isWaiting={waitingIds.has(task.id)}
                  onStart={this.handleStart}
                  onFireNow={this.handleFireNow}
                  onStop={this.handleStop}
                  onDelete={this.handleDelete}
                  onEdit={this.handleEdit}
                  onClearLogs={this.handleClearLogs}
                />
              ))}
            </div>
          )}
        </div>

        {showCreate && !editTask && (
          <CreateTaskModal onCreate={this.handleCreate} onClose={this.closeModal} />
        )}
        {showCreate && editTask && (
          <CreateTaskModal initialData={editTask} onCreate={(data) => this.handleUpdate(editTask.id, data)} onClose={this.closeModal} />
        )}
      </div>
    );
  }
}

const mapStateToProps = s => ({
  tasks: s.tasks,
  profiles: s.profiles,
  taskStatus: s.taskStatus,
  taskLogs: s.taskLogs,
  discordStatus: s.discordStatus,
  cartUrlPool: s.cartUrlPool,
});

export default connect(mapStateToProps)(Tasks);
