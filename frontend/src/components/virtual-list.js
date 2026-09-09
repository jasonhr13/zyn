import React, { Component, createRef } from 'react';

export const TASK_ROW_HEIGHT = 46;
export const LIST_OVERSCAN = 8;

export function visibleListWindow({
  scrollTop = 0,
  viewportHeight = 0,
  count = 0,
  rowHeight = TASK_ROW_HEIGHT,
  overscan = LIST_OVERSCAN,
} = {}) {
  const total = Math.max(0, count | 0);
  const height = Math.max(1, Number(rowHeight) || TASK_ROW_HEIGHT);
  if (!total) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const view = Math.max(0, Number(viewportHeight) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const start = Math.max(0, Math.floor(top / height) - overscan);
  const visible = Math.ceil(view / height) + overscan * 2;
  const end = Math.min(total, start + Math.max(visible, 1));
  return {
    start,
    end,
    padTop: start * height,
    padBottom: (total - end) * height,
  };
}

export default class VirtualList extends Component {
  static defaultProps = {
    count: 0,
    rowHeight: TASK_ROW_HEIGHT,
    overscan: LIST_OVERSCAN,
    className: 'virtual-list',
    estimatedHeight: 520,
    renderRow: () => null,
  };

  state = { scrollTop: 0, height: 0 };
  box = createRef();
  scrollFrame = 0;
  scrollTimer = 0;
  pendingScrollTop = 0;

  componentDidMount() {
    this.measure();
    if (typeof ResizeObserver === 'function' && this.box.current) {
      this.resizeObserver = new ResizeObserver(this.measure);
      this.resizeObserver.observe(this.box.current);
    }
  }

  componentDidUpdate(prevProps) {
    const el = this.box.current;
    const size = Math.max(1, Number(this.props.rowHeight) || TASK_ROW_HEIGHT);
    const maxScroll = Math.max(0, Math.max(0, this.props.count | 0) * size - (this.state.height || 0));
    if (this.pendingScrollTop > maxScroll) this.pendingScrollTop = maxScroll;
    // RDP/compositor frames can collapse clientHeight and clamp scrollTop to 0.
    // Put the user back where the last scroll event said they were.
    if (el && this.pendingScrollTop > 0 && Math.abs(el.scrollTop - this.pendingScrollTop) > 1) {
      el.scrollTop = this.pendingScrollTop;
    }
    if (prevProps.count !== this.props.count) this.measure();
  }

  componentWillUnmount() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
  }

  measure = () => {
    const el = this.box.current;
    if (!el) return;
    const height = el.clientHeight;
    // Windows Server / RDP often reports 0 during a DWM frame. Treating that as
    // a real resize remounts the window at the top of the list.
    if (height < 32) return;
    if (height !== this.state.height) this.setState({ height });
  };

  flushScroll = () => {
    this.scrollFrame = 0;
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = 0;
    }
    const next = Math.max(0, this.pendingScrollTop);
    if (this.state.scrollTop !== next) this.setState({ scrollTop: next });
  };

  onScroll = event => {
    this.pendingScrollTop = event.currentTarget.scrollTop;
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(this.flushScroll);
    // Occluded Chromium (RDP) can stall rAF; the timer still advances the window.
    this.scrollTimer = setTimeout(this.flushScroll, 32);
  };

  render() {
    const { count, rowHeight, overscan, className, estimatedHeight, renderRow } = this.props;
    const size = Math.max(1, Number(rowHeight) || TASK_ROW_HEIGHT);
    const total = Math.max(0, count | 0);
    const range = visibleListWindow({
      scrollTop: this.pendingScrollTop,
      viewportHeight: this.state.height || estimatedHeight,
      count: total,
      rowHeight: size,
      overscan,
    });
    const rows = [];
    for (let index = range.start; index < range.end; index += 1) {
      rows.push(renderRow(index));
    }
    return (
      <div className={className} ref={this.box} onScroll={this.onScroll}>
        <div className="virtual-list-space" style={{ height: total * size }}>
          <div
            className="virtual-list-window"
            style={{ top: range.start * size }}
          >
            {rows}
          </div>
        </div>
      </div>
    );
  }
}
