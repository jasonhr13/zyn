import React, { Component, createRef } from 'react';

// Matches `.task-log-view` (9.5px * 1.65). Rows are forced to one line so the window
// math stays exact; Copy still reads the full in-memory array.
export const LOG_ROW_HEIGHT = 16;
export const LOG_OVERSCAN = 8;
export const LOG_FOLLOW_PX = 96;

export function visibleLogWindow({
  scrollTop = 0,
  viewportHeight = 0,
  lineCount = 0,
  rowHeight = LOG_ROW_HEIGHT,
  overscan = LOG_OVERSCAN,
} = {}) {
  const count = Math.max(0, lineCount | 0);
  const height = Math.max(1, Number(rowHeight) || LOG_ROW_HEIGHT);
  if (!count) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const view = Math.max(0, Number(viewportHeight) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const start = Math.max(0, Math.floor(top / height) - overscan);
  const visible = Math.ceil(view / height) + overscan * 2;
  const end = Math.min(count, start + Math.max(visible, 1));
  return {
    start,
    end,
    padTop: start * height,
    padBottom: (count - end) * height,
  };
}

export default class VirtualLogView extends Component {
  static defaultProps = {
    lines: [],
    rowHeight: LOG_ROW_HEIGHT,
    overscan: LOG_OVERSCAN,
    followThreshold: LOG_FOLLOW_PX,
    numbered: true,
    empty: null,
    className: 'task-log-view',
    estimatedHeight: 260,
  };

  state = { scrollTop: 0, height: 0 };
  box = createRef();
  stickToBottom = true;
  scrollFrame = 0;
  pendingScrollTop = 0;

  componentDidMount() {
    this.measure();
    if (typeof ResizeObserver === 'function' && this.box.current) {
      this.resizeObserver = new ResizeObserver(this.measure);
      this.resizeObserver.observe(this.box.current);
    }
    if (this.stickToBottom) this.scrollToBottom();
  }

  getSnapshotBeforeUpdate(prevProps) {
    if (this.props.lines === prevProps.lines) return null;
    const el = this.box.current;
    if (!el) return this.stickToBottom;
    return el.scrollHeight - el.scrollTop - el.clientHeight < this.props.followThreshold;
  }

  componentDidUpdate(prevProps, _prevState, wasAtBottom) {
    if (wasAtBottom) this.scrollToBottom();
    else if (prevProps.lines !== this.props.lines) this.measure();
  }

  componentWillUnmount() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
  }

  measure = () => {
    const el = this.box.current;
    if (!el) return;
    const height = el.clientHeight;
    if (height !== this.state.height) {
      this.setState({ height }, () => { if (this.stickToBottom) this.scrollToBottom(); });
    }
  };

  onScroll = event => {
    const el = event.currentTarget;
    this.pendingScrollTop = el.scrollTop;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < this.props.followThreshold;
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (this.state.scrollTop !== this.pendingScrollTop) {
        this.setState({ scrollTop: this.pendingScrollTop });
      }
    });
  };

  scrollToBottom = () => {
    const el = this.box.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.pendingScrollTop = el.scrollTop;
    this.stickToBottom = true;
    if (this.state.scrollTop !== el.scrollTop) this.setState({ scrollTop: el.scrollTop });
  };

  render() {
    const { lines, rowHeight, overscan, numbered, empty, className, estimatedHeight } = this.props;
    if (!lines.length) {
      return <div className={className} ref={this.box}>{empty}</div>;
    }
    const range = visibleLogWindow({
      scrollTop: this.state.scrollTop,
      viewportHeight: this.state.height || estimatedHeight,
      lineCount: lines.length,
      rowHeight,
      overscan,
    });
    const rows = [];
    for (let index = range.start; index < range.end; index += 1) {
      const line = lines[index];
      rows.push(
        <div key={index} title={String(line)}>
          {numbered ? <span>{String(index + 1).padStart(3, '0')}</span> : null}
          {line}
        </div>,
      );
    }
    return (
      <div
        className={`${className} task-log-view-virtual`}
        ref={this.box}
        onScroll={this.onScroll}
      >
        {range.padTop > 0 && (
          <div className="task-log-virtual-pad" style={{ height: range.padTop }} aria-hidden="true" />
        )}
        {rows}
        {range.padBottom > 0 && (
          <div className="task-log-virtual-pad" style={{ height: range.padBottom }} aria-hidden="true" />
        )}
      </div>
    );
  }
}
