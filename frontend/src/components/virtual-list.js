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
  pendingScrollTop = 0;

  componentDidMount() {
    this.measure();
    if (typeof ResizeObserver === 'function' && this.box.current) {
      this.resizeObserver = new ResizeObserver(this.measure);
      this.resizeObserver.observe(this.box.current);
    }
  }

  componentDidUpdate(prevProps) {
    if (prevProps.count !== this.props.count) this.measure();
  }

  componentWillUnmount() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
  }

  measure = () => {
    const el = this.box.current;
    if (!el) return;
    const height = el.clientHeight;
    if (height !== this.state.height) this.setState({ height });
  };

  onScroll = event => {
    this.pendingScrollTop = event.currentTarget.scrollTop;
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (this.state.scrollTop !== this.pendingScrollTop) {
        this.setState({ scrollTop: this.pendingScrollTop });
      }
    });
  };

  render() {
    const { count, rowHeight, overscan, className, estimatedHeight, renderRow } = this.props;
    const range = visibleListWindow({
      scrollTop: this.state.scrollTop,
      viewportHeight: this.state.height || estimatedHeight,
      count,
      rowHeight,
      overscan,
    });
    const rows = [];
    for (let index = range.start; index < range.end; index += 1) {
      rows.push(renderRow(index));
    }
    return (
      <div className={className} ref={this.box} onScroll={this.onScroll}>
        {range.padTop > 0 && <div className="virtual-list-pad" style={{ height: range.padTop }} aria-hidden="true" />}
        {rows}
        {range.padBottom > 0 && <div className="virtual-list-pad" style={{ height: range.padBottom }} aria-hidden="true" />}
      </div>
    );
  }
}
