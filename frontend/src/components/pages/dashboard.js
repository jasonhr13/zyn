import React, { Component, useEffect, useRef, useState } from 'react';
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

function MetricChart({ series, interval, metric, loading }) {
  const rows = chartRows(series, interval, metric);
  const canvas = useRef(null);
  const [width, setWidth] = useState(760);
  const height = 230;
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, entries[0].contentRect.width)));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  const left = 48;
  const right = 18;
  const top = 18;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const peak = Math.max(1, ...rows.map(row => row.value));
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak / 4)));
  const step = Math.max(1, [1, 2, 5, 10].find(value => value * magnitude >= peak / 4) * magnitude);
  const max = Math.ceil(peak / step) * step;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step);
  const points = rows.map((row, index) => ({
    ...row,
    x: left + (rows.length <= 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1)),
    y: top + plotHeight - row.value / max * plotHeight,
  }));
  const pointString = points.map(point => `${point.x},${point.y}`).join(' ');
  const area = points.length > 1
    ? `${points[0].x},${top + plotHeight} ${pointString} ${points[points.length - 1].x},${top + plotHeight}` : '';
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  return (
    <div className="analytics-chart-canvas" ref={canvas} aria-busy={loading}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} analytics chart`}>
        <defs>
          <linearGradient id="zyn-chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity=".18" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map(value => {
          const y = top + plotHeight - value / max * plotHeight;
          return <g key={value}>
            <line className="analytics-grid-line" x1={left} x2={left + plotWidth} y1={y} y2={y} />
            <text className="analytics-axis-label" x={left - 9} y={y + 4} textAnchor="end">
              {metric === 'spent' ? `$${Math.round(value)}` : Math.round(value)}
            </text>
          </g>;
        })}
        {area && <polygon className="analytics-chart-area" points={area} />}
        {pointString && <polyline className="analytics-chart-line" points={pointString} />}
        {points.map((point, index) => <React.Fragment key={point.key}>
          <circle className="analytics-chart-point" cx={point.x} cy={point.y} r="3.5">
            <title>{shortBucketLabel(point.key, interval)}: {metric === 'spent' ? currency(point.value * 100) : point.value}</title>
          </circle>
          {(index % labelStep === 0 || index === points.length - 1) &&
            <text className="analytics-axis-label" x={point.x} y={height - 13} textAnchor="middle">
              {shortBucketLabel(point.key, interval)}
            </text>}
        </React.Fragment>)}
      </svg>
      {!rows.length && <div className="analytics-chart-empty">
        {loading
          ? <p role="status">Loading activity…</p>
          : <><span><Icon name="activity" size={22} /></span><strong>A fresh start</strong><p>Your activity will appear here after the first cart or checkout.</p></>}
      </div>}
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
    const rows = [['Date', 'Site', 'Account', 'Profile', 'Product', 'SKU', 'Quantity', 'Unit price', 'Order total', 'Order number']];
    for (const checkout of (result.checkouts || [])) {
      const items = checkout.items && checkout.items.length ? checkout.items : [{}];
      for (const item of items) rows.push([
        new Date(checkout.occurredAt).toLocaleString(), checkout.site, checkout.account || '',
        checkout.profile || '', item.name || '', item.sku || '',
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

  render() {
    const { dashboard, metric, interval, range, checkouts, total, page, pageSize, clock } = this.state;
    const summary = dashboard && dashboard.summary ? dashboard.summary : EMPTY_SUMMARY;
    const series = dashboard && dashboard.series ? dashboard.series : [];
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const cards = [
      { label: 'Checkouts', value: summary.checkouts, tone: 'rose', icon: 'check', hint: 'Successful orders' },
      { label: 'Total Spent', value: currency(summary.totalSpentCents), tone: 'gold', icon: 'cart', hint: 'Across your checkouts' },
      { label: 'Declines', value: summary.declines, tone: 'red', icon: 'close', hint: 'Declined checkouts' },
      { label: 'Stuck In Cart', value: summary.stuckInCart, tone: 'orange', icon: 'layers', hint: 'No checkout or decline yet' },
    ];
    return <div className="analytics-page">
      <div className="page-header analytics-page-header">
        <div className="page-title"><span className="page-title-dot" /> Dashboard</div>
        <div className="analytics-clock"><Icon name="calendar" size={14} />{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}<span />{clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      </div>
      <div className="page-content analytics-content">
        <section className="analytics-hero">
          <div>
            <span className="analytics-eyebrow">Your workspace, at a glance</span>
            <h1>{greeting(clock)}, {accountName(this.props.email)}</h1>
            <p>Every drop. Every checkout. All in one place.</p>
          </div>
          <div className="analytics-ranges">
            {Object.entries(RANGE_LABELS).map(([key, label]) => <button type="button" key={key}
              className={range === key ? 'active' : ''} aria-pressed={range === key} onClick={() => this.setRange(key)}>{label}</button>)}
          </div>
        </section>

        {(this.state.offline || this.state.pending > 0 || this.state.error) && <div className="analytics-sync-note">
          <span className={this.state.offline ? 'offline' : ''} />
          {this.state.offline ? 'Offline — showing the last synced view.' : this.state.error || 'Analytics syncing.'}
          {this.state.pending > 0 && ` ${this.state.pending} event${this.state.pending === 1 ? '' : 's'} pending.`}
        </div>}

        <div className="analytics-cards">
          {cards.map(card => <article className={`analytics-card tone-${card.tone}`} key={card.label}>
            <div className="analytics-card-label"><span>{card.label}</span><span className="analytics-card-icon"><Icon name={card.icon} size={16} /></span></div>
            <strong>{this.state.loading && !dashboard ? '—' : card.value}</strong><small>{card.hint}</small>
          </article>)}
        </div>

          <section className="analytics-panel analytics-overview">
            <header>
              <div><h2>Activity overview</h2><p className="analytics-panel-subtitle">{RANGE_LABELS[range]} · Your checkout performance</p></div>
              <div className="analytics-intervals">
                {['day', 'week', 'month', 'year'].map(key => <button type="button" key={key}
                  className={interval === key ? 'active' : ''} aria-pressed={interval === key} onClick={() => this.setInterval(key)}>{key[0].toUpperCase() + key.slice(1)}</button>)}
              </div>
            </header>
            <div className="analytics-chart-toolbar"><div className="analytics-tabs">
                {[['checkouts', 'Checkouts'], ['spent', 'Total Spent'], ['declines', 'Declines']].map(([key, label]) =>
                  <button type="button" className={metric === key ? 'active' : ''} aria-pressed={metric === key} key={key} onClick={() => this.setMetric(key)}>{label}</button>)}
              </div><span className="analytics-chart-legend"><i />{metric === 'spent' ? 'Total Spent' : metric === 'declines' ? 'Declines' : 'Checkouts'}</span></div>
            <MetricChart series={series} interval={interval} metric={metric} loading={this.state.loading && !dashboard} />
          </section>
          <section className="analytics-panel analytics-checkouts">
            <header>
              <h2>Recent checkouts <span>{total}</span></h2>
              <div className="analytics-table-actions">
                <label className="analytics-search"><Icon name="search" size={13} />
                  <input value={this.state.search} onChange={this.setSearch} placeholder="Search account, product, order" aria-label="Search checkouts" />
                </label>
                <button className="btn btn-sm btn-icon" type="button" onClick={() => this.load()} title="Refresh" aria-label="Refresh analytics"><Icon name="refresh" size={14} /></button>
                <button className="btn btn-sm" type="button" onClick={this.exportCsv} title="Export CSV"><Icon name="download" size={14} />Export</button>
              </div>
            </header>
            <div className="analytics-checkout-head"><span>Item</span><span>Account</span><span>Site</span><span>Date</span><span>Order</span></div>
            <div className="analytics-checkout-list">
              {this.state.loading && !checkouts.length ? <div className="analytics-list-empty">Loading analytics…</div>
                : !checkouts.length ? <div className="analytics-list-empty"><Icon name="cart" size={22} /><strong>{this.state.search ? 'No matching checkouts' : 'Your checkouts will land here'}</strong><span>{this.state.search ? 'Try another account, product, or order.' : 'Completed orders appear here automatically.'}</span></div>
                  : checkouts.map(checkout => {
                    const items = Array.isArray(checkout.items) ? checkout.items : [];
                    const item = items[0] || {};
                    const account = String(checkout.account || '').trim();
                    const profile = String(checkout.profile || '').trim();
                    return <div className="analytics-checkout-row" key={checkout.eventId}>
                      <div className="analytics-product-cell">
                        <span className="analytics-product-image">{item.image ? <img src={item.image} alt="" /> : <Icon name="cart" size={14} />}</span>
                        <span><strong>{item.name || item.sku || 'Checkout'}</strong><small>{item.quantity ? `${item.quantity}×` : ''}{items.length > 1 ? ` +${items.length - 1} more` : ''} · {currency(checkout.totalCents)}</small></span>
                      </div>
                      <span className="analytics-account-cell" title={[account, profile].filter(Boolean).join(' · ')}>
                        <span>{account || '—'}</span>
                        {profile && profile !== account ? <small>{profile}</small> : null}
                      </span>
                      <span><span className={`analytics-site analytics-site-${checkout.site}`}>{checkout.site === 'pokemoncenter' ? 'Pokémon Center' : checkout.site === 'target' ? 'Target' : checkout.site === 'walmart' ? 'Walmart' : checkout.site}</span></span>
                      <span>{new Date(checkout.occurredAt).toLocaleDateString()}</span>
                      <span title={checkout.orderNumber || ''}>{checkout.orderNumber || '—'}</span>
                    </div>;
                  })}
            </div>
            <footer>
              <span>{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} checkouts` : '0 checkouts'}</span>
              <div><button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => this.setPage(page - 1)}>‹</button>
                <span>{page} / {maxPage}</span>
                <button type="button" aria-label="Next page" disabled={page >= maxPage} onClick={() => this.setPage(page + 1)}>›</button></div>
            </footer>
          </section>
      </div>
    </div>;
  }
}
