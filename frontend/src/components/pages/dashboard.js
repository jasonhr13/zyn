import React, { Component } from 'react';
import Icon from '../icon';
import './dashboard.css';

const { ipcRenderer } = window.require('electron');
const RANGE_LABELS = { today: 'Today', '30d': 'Last 30 Days', '90d': 'Last 90 Days', all: 'All Time' };
const EMPTY_SUMMARY = { checkouts: 0, declines: 0, totalSpentCents: 0, stuckInCart: 0 };

function rangeBounds(range) {
  const now = new Date();
  let from = 0;
  if (range === 'today') {
    const localMidnight = new Date(now);
    localMidnight.setHours(0, 0, 0, 0);
    from = localMidnight.getTime();
  } else if (range === '30d') from = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  else if (range === '90d') from = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  return { range, from, to: now.getTime() + 1 };
}

function currency(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
}

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function accountName(email) {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local || 'there';
}

function bucketKey(day, interval) {
  if (interval === 'year') return day.slice(0, 4);
  if (interval === 'month') return day.slice(0, 7);
  if (interval === 'week') {
    const date = new Date(`${day}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    return date.toISOString().slice(0, 10);
  }
  return day;
}

function chartRows(series, interval, metric) {
  const grouped = new Map();
  for (const row of (series || [])) {
    const key = bucketKey(String(row.day || ''), interval);
    const value = metric === 'spent' ? (Number(row.totalSpentCents) || 0) / 100
      : (Number(row[metric]) || 0);
    grouped.set(key, (grouped.get(key) || 0) + value);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => ({ key, value }));
}

function shortBucketLabel(key, interval) {
  if (interval === 'year') return key;
  if (interval === 'month') return new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function MetricChart({ series, interval, metric }) {
  const rows = chartRows(series, interval, metric);
  const width = 760;
  const height = 290;
  const left = 48;
  const right = 18;
  const top = 18;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...rows.map(row => row.value));
  const points = rows.map((row, index) => ({
    ...row,
    x: left + (rows.length <= 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1)),
    y: top + plotHeight - row.value / max * plotHeight,
  }));
  const pointString = points.map(point => `${point.x},${point.y}`).join(' ');
  const area = points.length
    ? `${left},${top + plotHeight} ${pointString} ${left + plotWidth},${top + plotHeight}` : '';
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  return (
    <div className="analytics-chart-canvas">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} analytics chart`}>
        <defs>
          <linearGradient id="zyn-chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".24" />
            <stop offset="1" stopColor="var(--run)" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {[0, .25, .5, .75, 1].map(mark => {
          const y = top + plotHeight - mark * plotHeight;
          const value = max * mark;
          return <g key={mark}>
            <line className="analytics-grid-line" x1={left} x2={left + plotWidth} y1={y} y2={y} />
            <text className="analytics-axis-label" x={left - 9} y={y + 4} textAnchor="end">
              {metric === 'spent' ? `$${Math.round(value)}` : Math.round(value)}
            </text>
          </g>;
        })}
        {area && <polygon className="analytics-chart-area" points={area} />}
        {pointString && <polyline className="analytics-chart-line" points={pointString} />}
        {points.map((point, index) => <React.Fragment key={point.key}>
          <circle className="analytics-chart-point" cx={point.x} cy={point.y} r="3.5" />
          {(index % labelStep === 0 || index === points.length - 1) &&
            <text className="analytics-axis-label" x={point.x} y={height - 13} textAnchor="middle">
              {shortBucketLabel(point.key, interval)}
            </text>}
        </React.Fragment>)}
      </svg>
      {!rows.length && <div className="analytics-chart-empty">Your activity will appear here after the first cart or checkout.</div>}
    </div>
  );
}

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

export default class Dashboard extends Component {
  state = {
    range: 'all', metric: 'checkouts', interval: 'month', dashboard: null,
    checkouts: [], total: 0, page: 1, pageSize: 12, search: '', loading: true,
    offline: false, pending: 0, error: '', clock: new Date(),
  };

  mounted = false;
  requestId = 0;
  reloadTimer = null;
  searchTimer = null;
  clockTimer = null;

  componentDidMount() {
    this.mounted = true;
    this.load();
    this.clockTimer = setInterval(() => this.setState({ clock: new Date() }), 30000);
    ipcRenderer.on('analyticsUpdated', this.onAnalyticsUpdated);
  }

  componentWillUnmount() {
    this.mounted = false;
    clearTimeout(this.reloadTimer);
    clearTimeout(this.searchTimer);
    clearInterval(this.clockTimer);
    ipcRenderer.removeListener('analyticsUpdated', this.onAnalyticsUpdated);
  }

  onAnalyticsUpdated = () => {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load({ quiet: true }), 400);
  };

  query = () => ({
    ...rangeBounds(this.state.range),
    page: this.state.page,
    pageSize: this.state.pageSize,
    search: this.state.search,
  });

  load = async ({ quiet = false } = {}) => {
    const requestId = ++this.requestId;
    if (!quiet) this.setState({ loading: true, error: '' });
    const query = this.query();
    try {
      const [dashboard, checkouts] = await Promise.all([
        ipcRenderer.invoke('analyticsDashboard', query),
        ipcRenderer.invoke('analyticsCheckouts', query),
      ]);
      if (!this.mounted || requestId !== this.requestId) return;
      const ok = dashboard && dashboard.ok && checkouts && checkouts.ok;
      this.setState({
        dashboard: dashboard && dashboard.ok ? dashboard : this.state.dashboard,
        checkouts: checkouts && checkouts.ok ? checkouts.checkouts || [] : this.state.checkouts,
        total: checkouts && checkouts.ok ? Number(checkouts.total) || 0 : this.state.total,
        offline: Boolean((dashboard && dashboard.offline) || (checkouts && checkouts.offline)),
        pending: Math.max(Number(dashboard && dashboard.pending) || 0, Number(checkouts && checkouts.pending) || 0),
        loading: false,
        error: ok ? '' : String((dashboard && dashboard.message) || (checkouts && checkouts.message) || 'Could not load analytics.'),
      });
    } catch {
      if (this.mounted && requestId === this.requestId) this.setState({ loading: false, error: 'Could not load analytics.' });
    }
  };

  setRange = range => this.setState({ range, page: 1 }, () => this.load());
  setMetric = metric => this.setState({ metric });
  setInterval = interval => this.setState({ interval });
  setPage = page => this.setState({ page }, () => this.load());
  setSearch = event => {
    this.setState({ search: event.target.value, page: 1 });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load({ quiet: true }), 250);
  };

  exportCsv = async () => {
    const result = await ipcRenderer.invoke('analyticsCheckouts', { ...this.query(), page: 1, pageSize: 100 });
    if (!result || !result.ok) return;
    const rows = [['Date', 'Site', 'Product', 'SKU', 'Quantity', 'Unit price', 'Order total', 'Order number']];
    for (const checkout of (result.checkouts || [])) {
      const items = checkout.items && checkout.items.length ? checkout.items : [{}];
      for (const item of items) rows.push([
        new Date(checkout.occurredAt).toLocaleString(), checkout.site, item.name || '', item.sku || '',
        item.quantity || 1, currency(item.unitPriceCents), currency(checkout.totalCents), checkout.orderNumber || '',
      ]);
    }
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `zyn-checkouts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  deleteHistory = async () => {
    if (!window.confirm('Delete all checkout analytics for this Zyn account? This cannot be undone.')) return;
    const result = await ipcRenderer.invoke('deleteAnalytics');
    if (result && result.ok) this.setState({ dashboard: null, checkouts: [], total: 0, page: 1 }, () => this.load());
  };

  render() {
    const { dashboard, metric, interval, range, checkouts, total, page, pageSize, clock } = this.state;
    const summary = dashboard && dashboard.summary ? dashboard.summary : EMPTY_SUMMARY;
    const series = dashboard && dashboard.series ? dashboard.series : [];
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const cards = [
      { label: 'Checkouts', value: summary.checkouts, tone: 'rose', hint: RANGE_LABELS[range] },
      { label: 'Declines', value: summary.declines, tone: 'red', hint: RANGE_LABELS[range] },
      { label: 'Total Spent', value: currency(summary.totalSpentCents), tone: 'gold', hint: RANGE_LABELS[range] },
      { label: 'Stuck In Cart', value: summary.stuckInCart, tone: 'orange', hint: 'No later checkout or decline' },
    ];
    return <div className="analytics-page">
      <div className="page-header analytics-page-header">
        <div className="page-title"><span className="page-title-dot" /> Dashboard</div>
        <div className="analytics-clock">{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>
      </div>
      <div className="page-content analytics-content">
        <section className="analytics-hero">
          <div>
            <h1>{greeting(clock)}, {accountName(this.props.email)}</h1>
            <p>Your Zyn checkout activity, synced across your signed-in devices.</p>
          </div>
          <div className="analytics-ranges">
            {Object.entries(RANGE_LABELS).map(([key, label]) => <button type="button" key={key}
              className={range === key ? 'active' : ''} onClick={() => this.setRange(key)}>{label}</button>)}
          </div>
        </section>

        {(this.state.offline || this.state.pending > 0 || this.state.error) && <div className="analytics-sync-note">
          <span className={this.state.offline ? 'offline' : ''} />
          {this.state.offline ? 'Offline — showing the last synced view.' : this.state.error || 'Analytics syncing.'}
          {this.state.pending > 0 && ` ${this.state.pending} event${this.state.pending === 1 ? '' : 's'} pending.`}
        </div>}

        <div className="analytics-cards">
          {cards.map(card => <article className={`analytics-card tone-${card.tone}`} key={card.label}>
            <span>{card.label}</span><strong>{card.value}</strong><small>{card.hint}</small><i />
          </article>)}
        </div>

        <div className="analytics-grid">
          <section className="analytics-panel analytics-overview">
            <header>
              <div><h2>My Overview</h2><div className="analytics-tabs">
                {[['checkouts', 'Checkouts'], ['spent', 'Total Spent'], ['declines', 'Declines']].map(([key, label]) =>
                  <button type="button" className={metric === key ? 'active' : ''} key={key} onClick={() => this.setMetric(key)}>{label}</button>)}
              </div></div>
              <div className="analytics-intervals">
                {['day', 'week', 'month', 'year'].map(key => <button type="button" key={key}
                  className={interval === key ? 'active' : ''} onClick={() => this.setInterval(key)}>{key[0].toUpperCase() + key.slice(1)}</button>)}
              </div>
            </header>
            <MetricChart series={series} interval={interval} metric={metric} />
          </section>

          <section className="analytics-panel analytics-checkouts">
            <header>
              <h2>Checkouts <span>({total})</span></h2>
              <div className="analytics-table-actions">
                <button className="btn btn-sm btn-icon" type="button" onClick={() => this.load()} title="Refresh"><Icon name="refresh" size={14} /></button>
                <button className="btn btn-sm btn-icon" type="button" onClick={this.exportCsv} title="Export CSV"><Icon name="download" size={14} /></button>
                <label className="analytics-search"><Icon name="search" size={13} />
                  <input value={this.state.search} onChange={this.setSearch} placeholder="Search checkouts" />
                </label>
              </div>
            </header>
            <div className="analytics-checkout-head"><span>Item</span><span>Site</span><span>Date</span><span>Order</span></div>
            <div className="analytics-checkout-list">
              {this.state.loading && !checkouts.length ? <div className="analytics-list-empty">Loading analytics…</div>
                : !checkouts.length ? <div className="analytics-list-empty">No checkouts in this range.</div>
                  : checkouts.map(checkout => {
                    const items = Array.isArray(checkout.items) ? checkout.items : [];
                    const item = items[0] || {};
                    return <div className="analytics-checkout-row" key={checkout.eventId}>
                      <div className="analytics-product-cell">
                        <span className="analytics-product-image">{item.image ? <img src={item.image} alt="" /> : <Icon name="cart" size={14} />}</span>
                        <span><strong>{item.name || item.sku || 'Checkout'}</strong><small>{item.quantity ? `${item.quantity}×` : ''}{items.length > 1 ? ` +${items.length - 1} more` : ''} · {currency(checkout.totalCents)}</small></span>
                      </div>
                      <span>{checkout.site}</span>
                      <span>{new Date(checkout.occurredAt).toLocaleDateString()}</span>
                      <span title={checkout.orderNumber || ''}>{checkout.orderNumber || '—'}</span>
                    </div>;
                  })}
            </div>
            <footer>
              <button className="analytics-delete" type="button" onClick={this.deleteHistory} title="Delete analytics"><Icon name="trash" size={13} /></button>
              <div><button type="button" disabled={page <= 1} onClick={() => this.setPage(page - 1)}>‹</button>
                <span>{page} / {maxPage}</span>
                <button type="button" disabled={page >= maxPage} onClick={() => this.setPage(page + 1)}>›</button></div>
            </footer>
          </section>
        </div>
      </div>
    </div>;
  }
}
