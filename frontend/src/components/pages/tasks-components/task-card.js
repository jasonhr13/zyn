import React, { Component, createRef } from 'react';

const STATUS_LABELS = {
  idle: 'Idle', waiting: 'Waiting', running: 'Running', done: 'Done',
  confirmed: 'Confirmed', declined: 'Declined', manual: 'Manual', error: 'Error',
};

// Map a raw bot log line to a short, friendly step. First match wins.
const STEP_MAP = [
  [/order confirmed|thank you|order number/i, 'Order confirmed'],
  [/declined|refused/i, 'Declined'],
  [/place order|\[10\]|review order|\[9\]|billing/i, 'Placing order'],
  [/payment|adyen|\[5\]|\[6\]|\[7\]|\[8\]|card number|expiry|cvv|submit card/i, 'Payment processing'],
  [/secure checkout|continue to (shipping|payment)|shipping form|cart api|\[4\]/i, 'Checking out'],
  [/add.?to.?cart clicked|added to cart|cart items|cart page|\[3\]/i, 'Adding to cart'],
  [/\[2\]|adding item|product/i, 'Navigating to product'],
  [/bypass|queue-it|timer|self-acquire|token acquired|\[1\]/i, 'Bypassed queue'],
  [/starting|launching|visiting/i, 'Starting'],
];

function currentStep(status, lastLog) {
  if (status === 'confirmed') return 'Order confirmed';
  if (status === 'declined') return 'Declined';
  if (status === 'error') return 'Error';
  if (status === 'manual') return 'Manual checkout';
  if (status === 'waiting') return 'Armed — waiting for queue';
  const line = lastLog || '';
  for (const [rx, label] of STEP_MAP) if (rx.test(line)) return label;
  if (status === 'running') return 'Working…';
  return null;
}

function StatusBadge({ status }) {
  const s = status || 'idle';
  return (
    <span className={`badge badge-${s}`}>
      <span className={`status-dot status-dot-${s}`} />
      {STATUS_LABELS[s] || s}
    </span>
  );
}

class TaskCard extends Component {
  state = { expanded: false };
  logEndRef = createRef();
  logBoxRef = createRef();

  toggle = () => this.setState(prev => ({ expanded: !prev.expanded }));

  // Capture whether the log box was already pinned to the bottom BEFORE React re-renders with the
  // new lines — afterwards the added content has changed scrollHeight and the answer is unknowable.
  getSnapshotBeforeUpdate(prevProps) {
    if (!this.state.expanded || this.props.taskLogs === prevProps.taskLogs) return null;
    const box = this.logBoxRef.current;
    if (!box) return null;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 40;   // within 40px of the bottom
  }

  componentDidUpdate(prevProps, prevState, wasAtBottom) {
    // Only follow the tail if the user was already there. Previously this scrolled on EVERY new
    // line, and used scrollIntoView — which scrolls the whole PAGE to reveal the element, so a
    // running task dragged the view back down whenever you tried to read anything else.
    if (wasAtBottom) this.scrollLogs();
  }

  scrollLogs() {
    const box = this.logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;   // scrolls only the log box, never the page
  }

  get taskStatus() {
    const { taskStatus, task } = this.props;
    return taskStatus[task.id] || {};
  }

  get runStatus() {
    return this.taskStatus.status || 'idle';
  }

  get threadStatus() {
    const threads = this.taskStatus.threads || {};
    return threads[1] || {};  // single thread, always T1
  }

  get logs() {
    return (this.props.taskLogs || {})[this.props.task.id] || [];
  }

  get profileName() {
    const { task, profiles = [] } = this.props;
    const pid = task.profileId || (task.profileIds && task.profileIds[0]);
    if (!pid) return null;
    const p = profiles.find(p => p.id === pid);
    return p ? (p.profileName || p.email) : null;
  }

  handleStart = (e) => { e.stopPropagation(); this.props.onStart(this.props.task.id); };
  handleFireNow = (e) => { e.stopPropagation(); this.props.onFireNow(this.props.task.id); };
  handleStop = (e) => { e.stopPropagation(); this.props.onStop(this.props.task.id); };
  handleDelete = (e) => { e.stopPropagation(); this.props.onDelete(this.props.task.id); };
  handleEdit = (e) => { e.stopPropagation(); this.props.onEdit(this.props.task); };
  handleClearLogs = (e) => { e.stopPropagation(); this.props.onClearLogs(this.props.task.id); };

  render() {
    const { task, isWaiting } = this.props;
    const { expanded } = this.state;
    const runStatus = this.runStatus;
    const isRunning = runStatus === 'running';
    const threadSt = this.threadStatus;
    const logs = this.logs;
    const profileName = this.profileName;

    // Best status to show: waiting > thread-level (confirmed/declined/error) > task-level
    const displayStatus = isWaiting ? 'waiting' : (threadSt.status || runStatus);
    const step = currentStep(displayStatus, threadSt.lastLog);

    return (
      <div className={`task-card${isRunning ? ' task-running' : ''}`}>
        {/* Header */}
        <div className="task-card-header" onClick={this.toggle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button className="expand-toggle">{expanded ? '▾' : '▸'}</button>
            <StatusBadge status={displayStatus} />
          </div>

          <div className="task-card-info">
            <div className="task-card-name">{task.name}</div>
            <div className="task-card-meta">
              {profileName ? profileName : <span style={{ color: 'var(--muted)' }}>no profile</span>}
              {' · '}qty {task.qty || 1}
              {task.variant ? ` · ${task.variant}` : ''}
              {task.proxyList ? ` · ${task.proxyList}` : ''}
            </div>
          </div>

          {/* Current step — short and friendly */}
          {step && !expanded && (
            <div style={{ flex: 1, fontSize: 11, fontWeight: 500, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280, marginLeft: 8 }}>
              {step}
            </div>
          )}

          {/* Edit / Trash on the left, Arm / Fire / Stop on the right */}
          <div className="task-card-controls">
            <button className="btn btn-sm btn-secondary btn-icon" onClick={this.handleEdit} title="Edit">
              <i className="ion-md-create" style={{ fontSize: 12 }} />
            </button>
            <button className="btn btn-sm btn-danger btn-icon" onClick={this.handleDelete} title="Delete">
              <i className="ion-md-trash" style={{ fontSize: 12 }} />
            </button>
            {isRunning || isWaiting ? (
              <button className="btn btn-sm btn-secondary" style={{ marginLeft: 6 }} onClick={this.handleStop}>
                <i className="ion-md-square" style={{ fontSize: 12 }} /> {isWaiting ? 'Disarm' : 'Stop'}
              </button>
            ) : (
              <>
                <button className="btn btn-sm btn-success" style={{ marginLeft: 6 }} onClick={this.handleStart} title="Arm — waits for queue URL from Discord">
                  <i className="ion-md-play" style={{ fontSize: 12 }} /> Arm
                </button>
                <button className="btn btn-sm btn-warning" onClick={this.handleFireNow} title="Fire now — skips queue, goes straight to product page">
                  <i className="ion-md-flash" style={{ fontSize: 12 }} /> Fire
                </button>
              </>
            )}
          </div>
        </div>

        {/* Expanded: log viewer */}
        {expanded && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px 4px', borderTop: '1px solid var(--panel-border)' }}>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                {logs.length > 0 ? `${logs.length} log line${logs.length !== 1 ? 's' : ''}` : 'No logs yet'}
              </span>
              {logs.length > 0 && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => {
                    const text = logs.map(e => e.line).join('\n');
                    navigator.clipboard.writeText(text).catch(() => {});
                  }}>
                    Copy
                  </button>
                  <button className="btn btn-sm btn-secondary" style={{ padding: '2px 8px', fontSize: 10 }} onClick={this.handleClearLogs}>
                    Clear
                  </button>
                </div>
              )}
            </div>
            <div ref={this.logBoxRef} className="thread-log-section" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {logs.length === 0 ? (
                <div style={{ padding: '12px 16px', color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>
                  Waiting for output…
                </div>
              ) : (
                logs.map((entry, i) => {
                  let cls = 'log-line';
                  if (/ORDER CONFIRMED/i.test(entry.line)) cls += ' log-line-confirmed';
                  else if (/declined|refused/i.test(entry.line)) cls += ' log-line-declined';
                  else if (/ERROR:|FATAL|FAILED/i.test(entry.line)) cls += ' log-line-error';
                  return (
                    <div key={i} className={cls}>{(entry.line || '').replace(/^\s+/, '')}</div>
                  );
                })
              )}
              <div ref={this.logEndRef} />
            </div>
          </div>
        )}
      </div>
    );
  }
}

export default TaskCard;
