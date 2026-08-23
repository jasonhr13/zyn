import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
import TargetOtpInput, { targetOtpForTask } from '../target-otp-input';
import VirtualList, { TASK_ROW_HEIGHT } from '../virtual-list';
import InlineSelect from '../inline-select';
import { connectEngineLog, connectTaskLog, indexByEmail, indexById, pickTableState } from '../module-table-state';
const { ipcRenderer } = window.require('electron');

const WALMART_TABLE_KEYS = Object.freeze([
  'products', 'tasks', 'taskStatus', 'monitorDelay', 'retryDelay', 'endless',
]);
const WalmartEngineLog = connectEngineLog('walmart');
const WalmartTaskLog = connectTaskLog('walmart');
const uid = () => 'wm_' + Math.random().toString(36).slice(2, 10);
const productUid = () => 'wm_product_' + Math.random().toString(36).slice(2, 10);
const MAX_PRODUCTS = 10;
const blankProduct = () => ({ id: productUid(), input: 'placeholder', quantity: '1', maxPrice: '' });

function isWalmartOfferId(value) {
  return /^[A-Za-z0-9]{32}$/.test(String(value || '').trim());
}

function normalizeWalmartInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.toLowerCase() === 'placeholder') return 'placeholder';
  if (isWalmartOfferId(input)) return input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!(parsed.hostname === 'walmart.com' || parsed.hostname.endsWith('.walmart.com'))) return '';
      return input;
    } catch { return ''; }
  }
  return /^\d{6,}$/.test(input) ? input : '';
}

function migrateProducts(products, legacyInput = '', legacyQuantity = '1', legacyMaxPrice = '') {
  if (Array.isArray(products) && products.length) {
    return products.slice(0, MAX_PRODUCTS).map(product => ({
      id: String((product && product.id) || productUid()),
      input: String((product && product.input) || ''),
      quantity: String(Math.max(1, parseInt(product && product.quantity, 10) || 1)),
      maxPrice: String((product && product.maxPrice) || ''),
    }));
  }
  const input = String(legacyInput || '').trim();
  return input
    ? [{ id: productUid(), input, quantity: String(Math.max(1, parseInt(legacyQuantity, 10) || 1)), maxPrice: String(legacyMaxPrice || '') }]
    : [blankProduct()];
}

function validateProducts(products) {
  const rows = Array.isArray(products) ? products : [];
  const populated = rows.map(row => ({
    input: String((row && row.input) || '').trim(),
    quantity: String(Math.max(1, parseInt(row && row.quantity, 10) || 1)),
    maxPrice: String((row && row.maxPrice) || '').trim(),
  })).filter(row => row.input);
  const normalized = populated.map(row => normalizeWalmartInput(row.input));
  const seen = new Set();
  const valid = [];
  populated.forEach((row, index) => {
    const input = normalized[index];
    if (!input || seen.has(input)) return;
    seen.add(input);
    valid.push({ input, quantity: row.quantity, maxPrice: row.maxPrice });
  });
  if (!populated.length) {
    return { products: [{ input: 'placeholder', quantity: '1', maxPrice: '' }], invalid: [], tooMany: false };
  }
  return {
    products: valid.slice(0, MAX_PRODUCTS),
    invalid: populated.filter((row, index) => !normalized[index]).map(row => row.input),
    tooMany: valid.length > MAX_PRODUCTS || populated.length > MAX_PRODUCTS,
  };
}

function checkoutProfiles(profiles) {
  const value = (profiles && (profiles.list || profiles.profiles)) || (Array.isArray(profiles) ? profiles : []);
  return value.filter(profile => String((profile && profile.profileType) || '').toLowerCase() === 'walmart');
}

function walmartAccounts(accounts) {
  return (accounts || []).filter(account => String((account && account.site) || '').trim().toLowerCase() === 'walmart');
}

function profileName(profile) {
  return profile ? (profile.profileName || profile.email || 'Unnamed profile') : 'Missing profile';
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

class Walmart extends Component {
  state = {
    draftAccountIds: [], draftProxy: '',
    expanded: null, notice: '', setupOpen: true,
  };

  componentDidMount() {
    try {
      const saved = ipcRenderer.sendSync('getWalmartTasks') || {};
      this.props.dispatch({ type: 'walmartSet', obj: {
        products: migrateProducts(saved.products, saved.input, saved.quantity, saved.maxPrice),
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        monitorDelay: String(saved.monitorDelay || '3000'),
        retryDelay: String(saved.retryDelay || '3000'),
        endless: !!saved.endless,
      } });
      this.setState({ setupOpen: saved.setupOpen !== false });
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
    const payload = { ...this.props.walmart, ...over };
    try {
      ipcRenderer.sendSync('saveWalmartTasks', {
        products: payload.products,
        tasks: payload.tasks, monitorDelay: payload.monitorDelay, retryDelay: payload.retryDelay,
        endless: payload.endless,
        setupOpen: payload.setupOpen !== undefined ? payload.setupOpen !== false : this.state.setupOpen !== false,
      });
    } catch {}
  };

  setModule = (key, value) => {
    this.props.dispatch({ type: 'walmartSet', obj: { [key]: value } });
    this.persist({ [key]: value });
  };

  flash = notice => {
    this.setState({ notice });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.setState({ notice: '' }), 3500);
  };

  toggleSetup = () => {
    const setupOpen = this.state.setupOpen === false;
    this.setState({ setupOpen });
    this.persist({ setupOpen });
  };

  sharedConfig = (over = {}) => {
    const w = { ...this.props.walmart, ...over };
    return {
      products: validateProducts(w.products).products,
      monitorDelay: String(w.monitorDelay || '3000'),
      retryDelay: String(w.retryDelay || '3000'),
      endless: !!w.endless,
    };
  };

  updateProduct = (id, obj) => {
    const products = this.props.walmart.products.map(product => product.id === id ? { ...product, ...obj } : product);
    this.setModule('products', products);
  };

  addProduct = () => {
    if (this.props.walmart.products.length >= MAX_PRODUCTS) return;
    this.setModule('products', [...this.props.walmart.products, blankProduct()]);
  };

  removeProduct = id => {
    const products = this.props.walmart.products.filter(product => product.id !== id);
    this.setModule('products', products.length ? products : [blankProduct()]);
  };

  accountLookup = () => {
    const loginAccounts = walmartAccounts(this.props.accounts);
    const list = checkoutProfiles(this.props.profiles);
    return {
      loginAccounts,
      list,
      accountsById: indexById(loginAccounts),
      profilesById: indexById(list),
      profilesByEmail: indexByEmail(list),
    };
  };

  profileForAccount = (accountId, lookup = this.accountLookup()) => {
    const account = lookup.accountsById.get(String(accountId));
    if (!account) return null;
    if (account.profileId) {
      const linked = lookup.profilesById.get(String(account.profileId));
      if (linked) return linked;
    }
    const email = String(account.email || '').trim().toLowerCase();
    if (!email) return null;
    return lookup.profilesByEmail.get(email) || null;
  };

  toggleDraftAccount = id => {
    const ids = this.state.draftAccountIds;
    const draftAccountIds = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    this.setState({ draftAccountIds });
  };

  toggleAllAccounts = () => {
    const loginAccounts = walmartAccounts(this.props.accounts);
    const used = new Set((this.props.walmart.tasks || []).map(task => String(task.accountId)));
    const available = loginAccounts.filter(account => !used.has(String(account.id)));
    const allOn = available.length > 0 && available.every(account => this.state.draftAccountIds.includes(account.id));
    this.setState({ draftAccountIds: allOn ? [] : available.map(account => account.id) });
  };

  runningTasks = () => (this.props.walmart.tasks || []).filter(task => {
    const status = this.props.walmart.taskStatus[task.id];
    return status && status.running !== false;
  });

  applyProductsToAllTasks = () => {
    const validation = validateProducts(this.props.walmart.products);
    if (validation.invalid.length) {
      this.flash('Use a Walmart product URL, item ID, offer ID, or placeholder');
      return;
    }
    const tasks = this.props.walmart.tasks || [];
    if (!tasks.length) {
      this.flash('Create tasks first');
      return;
    }
    if (!window.confirm(`Set these products on all ${tasks.length} task${tasks.length === 1 ? '' : 's'}?`)) return;
    this.props.dispatch({ type: 'walmartSet', obj: { tasks } });
    this.persist({ tasks, products: this.props.walmart.products });
    const running = this.runningTasks();
    if (running.length) {
      const result = ipcRenderer.sendSync('editWalmart', { ...this.sharedConfig(), tasks: running });
      this.flash(result && result.ok
        ? `Set products on ${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${result.updated} running`
        : ((result && result.error) || 'Saved, but running tasks did not take the update'));
      return;
    }
    this.flash(`Set products on ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  };

  createTasks = () => {
    const { draftAccountIds, draftProxy } = this.state;
    if (!draftAccountIds.length) {
      this.flash('Select at least one Walmart account');
      return;
    }
    const used = new Set((this.props.walmart.tasks || []).map(task => String(task.accountId)));
    const lookup = this.accountLookup();
    const tasks = [];
    for (const accountId of draftAccountIds) {
      if (used.has(String(accountId))) continue;
      const profile = this.profileForAccount(accountId, lookup);
      if (!profile) {
        this.flash('Each Walmart account needs a matching Walmart profile (same email)');
        return;
      }
      tasks.push({
        id: uid(), accountId, profileId: profile.id, proxyListName: draftProxy,
      });
      used.add(String(accountId));
    }
    if (!tasks.length) {
      this.flash('Those accounts already have a Walmart task');
      return;
    }
    const next = [...this.props.walmart.tasks, ...tasks];
    this.props.dispatch({ type: 'walmartTasksAdd', tasks });
    this.persist({ tasks: next });
    this.setState({ draftAccountIds: [] });
  };

  updateTask = (task, obj) => {
    const tasks = this.props.walmart.tasks.map(value => value.id === task.id ? { ...value, ...obj } : value);
    this.props.dispatch({ type: 'walmartSet', obj: { tasks } });
    this.persist({ tasks });
    if (!this.props.walmart.taskStatus[task.id]) return;
    const result = ipcRenderer.sendSync('editWalmart', { ...this.sharedConfig(), tasks: [{ ...task, ...obj }] });
    this.flash(result && result.ok ? 'Running task updated' : ((result && result.error) || 'Task update failed'));
  };

  removeTask = task => {
    if (this.props.walmart.taskStatus[task.id]) ipcRenderer.sendSync('stopWalmart', task.id);
    const tasks = this.props.walmart.tasks.filter(value => value.id !== task.id);
    this.props.dispatch({ type: 'walmartTaskDelete', id: task.id });
    this.persist({ tasks });
  };

  start = tasks => {
    const accounts = walmartAccounts(this.props.accounts);
    const profiles = checkoutProfiles(this.props.profiles);
    const accountIds = new Set(accounts.map(account => String(account.id)));
    const profileIds = new Set(profiles.map(profile => String(profile.id)));
    const launch = tasks.filter(task => accountIds.has(String(task.accountId)) && profileIds.has(String(task.profileId)));
    if (!launch.length) { this.flash('Each task needs a Walmart account and checkout profile'); return; }
    const validation = validateProducts(this.props.walmart.products);
    if (validation.invalid.length) {
      this.flash('Use a Walmart product URL, item ID, offer ID, or placeholder');
      return;
    }
    if (!validation.products.length) {
      this.flash('Add at least one product or placeholder');
      return;
    }
    const ok = ipcRenderer.sendSync('startWalmart', { ...this.sharedConfig(), products: validation.products, tasks: launch });
    if (ok) {
      this.props.dispatch({ type: 'walmartLaunch', taskIds: launch.map(task => task.id) });
      this.setState({ expanded: launch[0] && launch[0].id });
    } else this.flash('The native Walmart engine did not start');
  };

  stop = taskId => { ipcRenderer.sendSync('stopWalmart', taskId); };

  renderTaskRow = (task, { accountsById, profilesById, otpList, accountOptions, profileOptions, proxyOptions }) => {
    const account = accountsById.get(String(task.accountId));
    const profile = profilesById.get(String(task.profileId));
    const status = this.props.walmart.taskStatus[task.id];
    const active = status && status.running !== false;
    const open = this.state.expanded === task.id;
    const otpRequest = targetOtpForTask(otpList, task.id, account && account.email);
    return (
      <div key={task.id} className="site-task-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(160px, 1fr) 170px 150px 170px', gap: 10 }}>
        <InlineSelect
          className="form-select"
          value={task.accountId}
          placeholder="Select account"
          options={accountOptions}
          onChange={value => this.updateTask(task, { accountId: value })}
        />
        <InlineSelect
          className="form-select"
          value={task.profileId}
          placeholder="Select profile"
          options={profileOptions}
          onChange={value => this.updateTask(task, { profileId: value })}
        />
        <InlineSelect
          className="form-select"
          value={task.proxyListName || ''}
          placeholder="Local (no proxy)"
          options={proxyOptions}
          onChange={value => this.updateTask(task, { proxyListName: value })}
        />
        {otpRequest ? <TargetOtpInput request={otpRequest} /> : <Status value={status} />}
        <span style={{ display: 'flex', gap: 5 }}>
          {active
            ? <button className="btn btn-secondary btn-sm" onClick={() => this.stop(task.id)}>Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={() => this.start([task])} disabled={!account || !profile}>Start</button>}
          <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ expanded: open ? null : task.id })}>Log</button>
          <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeTask(task)} title="Delete task"><i className="ion-md-trash" /></button>
        </span>
      </div>
    );
  };

  render() {
    const { walmart, proxies, otpPending } = this.props;
    const { draftAccountIds, draftProxy, expanded, notice, setupOpen } = this.state;
    const lookup = this.accountLookup();
    const { list, loginAccounts, accountsById, profilesById } = lookup;
    const usedAccountIds = new Set((walmart.tasks || []).map(task => String(task.accountId)));
    const availableAccounts = loginAccounts.filter(account => !usedAccountIds.has(String(account.id)));
    const allAvailablePicked = availableAccounts.length > 0
      && availableAccounts.every(account => draftAccountIds.includes(account.id));
    const proxyLists = (proxies && proxies.lists) || [];
    const otpList = otpPending || [];
    const accountOptions = loginAccounts.map(value => ({ value: value.id, label: value.email || value.id }));
    const profileOptions = list.map(value => ({ value: value.id, label: profileName(value) }));
    const proxyOptions = [{ value: '', label: 'Local (no proxy)' }, ...proxyLists.map(proxy => ({ value: proxyRef(proxy), label: proxyLabel(proxy) }))];

    return (
      <div className="page" style={{ padding: '16px 20px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="page-header" style={{ marginBottom: 14 }}>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}><span className="page-title-dot" /> Walmart</h1>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              One task per account. Start on placeholder to log in, then apply SKUs before the drop.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notice && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{notice}</span>}
            <button className="btn btn-secondary" onClick={this.toggleSetup}>
              {setupOpen ? 'Hide setup' : 'Show setup'}
            </button>
            <button className="btn btn-primary" onClick={() => this.start(walmart.tasks)} disabled={!walmart.tasks.length}>Start All</button>
            <button className="btn btn-secondary" onClick={() => this.stop()}>Stop All</button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {setupOpen && <div style={{ display: 'flex', gap: 14, marginBottom: 14, alignItems: 'stretch' }}>
            <div className="panel" style={{ flex: '0 0 320px', minWidth: 0, margin: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 14px', height: 40, boxSizing: 'border-box', borderBottom: '1px solid var(--panel-border)' }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={this.createTasks}
                  disabled={!draftAccountIds.length}
                >
                  Create {draftAccountIds.length || ''} Task{draftAccountIds.length === 1 ? '' : 's'}
                </button>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {draftAccountIds.length} selected — one task each
                </span>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Proxy</span>
                  <select className="form-select" value={draftProxy} onChange={e => this.setState({ draftProxy: e.target.value })}>
                    <option value="">Local (no proxy)</option>
                    {proxyLists.map(proxy => <option key={proxyRef(proxy)} value={proxyRef(proxy)}>{proxyLabel(proxy)}</option>)}
                  </select>
                </label>
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <span className="form-label" style={{ marginBottom: 0 }}>Walmart accounts</span>
                    {availableAccounts.length > 0 && (
                      <button className="btn btn-secondary btn-sm" style={{ padding: '1px 8px', fontSize: 10.5 }} onClick={this.toggleAllAccounts}>
                        {allAvailablePicked ? 'Clear' : `All (${availableAccounts.length})`}
                      </button>
                    )}
                  </div>
                  <div style={{ height: 172, overflowY: 'auto', border: '1px solid var(--panel-border)', borderRadius: 6, padding: 4 }}>
                    {!loginAccounts.length && (
                      <div style={{ padding: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                        Add logins on Accounts → the Walmart tab.
                      </div>
                    )}
                    {loginAccounts.map(account => {
                      const on = draftAccountIds.includes(account.id);
                      const inUse = usedAccountIds.has(String(account.id));
                      const matched = !!this.profileForAccount(account.id, lookup);
                      return (
                        <div
                          key={account.id}
                          onClick={() => !inUse && this.toggleDraftAccount(account.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                            borderRadius: 4, cursor: inUse ? 'default' : 'pointer', fontSize: 12,
                            background: on ? 'var(--accent-soft)' : 'transparent',
                            opacity: inUse ? 0.55 : 1,
                          }}
                        >
                          <input type="checkbox" readOnly checked={on} disabled={inUse} style={{ pointerEvents: 'none' }} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{account.email}</span>
                          {!matched && <span style={{ color: 'var(--danger)', fontSize: 10 }}>no profile</span>}
                          {inUse && <span style={{ color: 'var(--muted)', fontSize: 10 }}>in use</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="panel" style={{ flex: 1, minWidth: 0, margin: 0, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 12 }}>Products</strong>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={this.applyProductsToAllTasks} disabled={!walmart.tasks.length}>
                    Apply to all tasks
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={this.addProduct} disabled={walmart.products.length >= MAX_PRODUCTS}>
                    Add product
                  </button>
                </span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {(walmart.products || []).map((product, index) => (
                  <div key={product.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 72px 90px 30px', gap: 7, alignItems: 'end' }}>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">{index === 0 ? 'SKU, URL, offer ID, or placeholder' : `Product ${index + 1}`}</span>
                      <input
                        className="form-input"
                        value={product.input}
                        onChange={e => this.updateProduct(product.id, { input: e.target.value })}
                        placeholder="placeholder"
                      />
                    </label>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">Qty</span>
                      <input className="form-input" value={product.quantity}
                        onChange={e => this.updateProduct(product.id, { quantity: e.target.value.replace(/\D/g, '').slice(0, 4) || '1' })} />
                    </label>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">Max $</span>
                      <input className="form-input" value={product.maxPrice}
                        onChange={e => this.updateProduct(product.id, { maxPrice: e.target.value })} placeholder="none" />
                    </label>
                    <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeProduct(product.id)} title="Remove product">
                      <i className="ion-md-trash" />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.45 }}>
                Leave <b>placeholder</b> to log in first. When SKUs land, paste them here and Apply to all tasks.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 110px 1fr', gap: 10, marginTop: 12, alignItems: 'end' }}>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Monitor ms</span>
                  <input className="form-input" value={walmart.monitorDelay}
                    onChange={e => this.setModule('monitorDelay', e.target.value.replace(/\D/g, '').slice(0, 6) || '3000')} />
                </label>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Retry ms</span>
                  <input className="form-input" value={walmart.retryDelay}
                    onChange={e => this.setModule('retryDelay', e.target.value.replace(/\D/g, '').slice(0, 6) || '3000')} />
                </label>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!walmart.endless} onChange={e => this.setModule('endless', e.target.checked)} />
                  Loop after a successful order
                </label>
              </div>
            </div>
          </div>}

          <div className="panel site-task-panel">
            <div className="site-task-head" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(160px, 1fr) 170px 150px 170px', gap: 10 }}>
              <span>ACCOUNT</span><span>PROFILE</span><span>PROXY</span><span>STATUS</span><span>ACTIONS</span>
            </div>
            {!walmart.tasks.length && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>No Walmart tasks yet.</div>}
            {!!walmart.tasks.length && (
              <VirtualList
                className="virtual-list site-task-virtual"
                count={walmart.tasks.length}
                rowHeight={TASK_ROW_HEIGHT}
                estimatedHeight={480}
                renderRow={index => this.renderTaskRow(walmart.tasks[index], {
                  accountsById, profilesById, otpList, accountOptions, profileOptions, proxyOptions,
                })}
              />
            )}
            {expanded && (
              <div className="site-task-log-dock">
                <WalmartTaskLog
                  className="task-log-view"
                  taskId={expanded}
                  estimatedHeight={160}
                  empty={<span style={{ color: 'var(--muted)', fontSize: 10.5 }}>No task output yet.</span>}
                />
              </div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 14, padding: 12 }}>
            <strong style={{ fontSize: 11 }}>Engine log</strong>
            <WalmartEngineLog
              className="task-log-view"
              estimatedHeight={180}
              empty={<span style={{ color: 'var(--muted)', fontSize: 10.5 }}>Task and monitor output will appear here.</span>}
            />
          </div>
        </div>
      </div>
    );
  }
}

export default connect(state => ({
  walmart: pickTableState(state.walmart, WALMART_TABLE_KEYS),
  profiles: state.profiles, proxies: state.proxies,
  accounts: state.accounts, otpPending: state.target.otpPending,
}))(Walmart);
