import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
import VirtualList, { TASK_ROW_HEIGHT } from '../virtual-list';
import InlineSelect from '../inline-select';
import { connectEngineLog, connectTaskLog, indexById, pickTableState } from '../module-table-state';
import { showOperatorLogs } from '../operator-logs';
const { ipcRenderer } = window.require('electron');

const POKEMON_TABLE_KEYS = Object.freeze([
  'products', 'tasks', 'taskStatus', 'taskInputs', 'monitorDelay', 'retryDelay',
  'loopCheckout', 'waitForQueue', 'queueEntryDelay', 'allInstock',
]);
const PokemonEngineLog = connectEngineLog('pokemon');
const PokemonTaskLog = connectTaskLog('pokemon');
const uid = () => 'pc_' + Math.random().toString(36).slice(2, 10);
const productUid = () => 'pc_product_' + Math.random().toString(36).slice(2, 10);
const MAX_PRODUCTS = 3;
const blankProduct = () => ({ id: productUid(), input: '', quantity: '1' });
const normalizeQuantity = value => String(Math.max(1, parseInt(value, 10) || 1));
function normalizeProductInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.toLowerCase() === 'placeholder') return 'placeholder';
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!(parsed.hostname === 'pokemoncenter.com' || parsed.hostname.endsWith('.pokemoncenter.com'))) return '';
      const product = parsed.pathname.match(/\/product\/([^/]+)/);
      return product && product[1] ? `https://www.pokemoncenter.com/product/${product[1]}` : '';
    } catch { return ''; }
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) ? input : '';
}

function migrateProductRows(products, legacyInputs = '', legacyQuantity = '1') {
  if (Array.isArray(products) && products.length) {
    return products.slice(0, MAX_PRODUCTS).map(product => ({
      id: String((product && product.id) || productUid()),
      input: String((product && product.input) || ''),
      quantity: normalizeQuantity(product && product.quantity),
    }));
  }
  const legacy = String(legacyInputs || '').split(/[\n,]/).map(input => input.trim()).filter(Boolean);
  return legacy.length
    ? legacy.slice(0, MAX_PRODUCTS).map(input => ({ id: productUid(), input, quantity: normalizeQuantity(legacyQuantity) }))
    : [blankProduct()];
}

function validateProducts(value) {
  const rows = Array.isArray(value) ? value : [];
  const entries = rows.map(row => ({ row: row || {}, input: String((row && row.input) || '').trim() }))
    .filter(entry => entry.input);
  const normalized = entries.map(entry => normalizeProductInput(entry.input));
  const seen = new Set();
  const products = [];
  entries.forEach((entry, index) => {
    const input = normalized[index];
    if (!input || seen.has(input)) return;
    seen.add(input);
    products.push({ input, quantity: normalizeQuantity(entry.row.quantity) });
  });
  return {
    products,
    invalid: entries.filter((entry, index) => !normalized[index]).map(entry => entry.input),
    tooMany: entries.length > MAX_PRODUCTS || products.length > MAX_PRODUCTS,
  };
}

function profileList(profiles) {
  const value = (profiles && (profiles.list || profiles.profiles)) || (Array.isArray(profiles) ? profiles : []);
  return value.filter(profile => profile && profile.profileType === 'pokemoncenter');
}

function profileName(profile) {
  return profile ? (profile.profileName || profile.email || 'Unnamed profile') : 'Missing profile';
}

function Status({ value }) {
  const color = (value && value.color) || '#6b7280';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color, fontSize: 11, fontWeight: 650 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {(value && (value.label || value.state)) || 'Idle'}
    </span>
  );
}

class PokemonCenter extends Component {
  state = {
    draftProfiles: [], draftProxy: '', draftCount: '2', expanded: null, notice: '',
    editingProductsTask: null, productDraft: [], setupOpen: true,
  };

  componentDidMount() {
    try {
      const saved = ipcRenderer.sendSync('getPokemonCenterTasks') || {};
      this.props.dispatch({ type: 'pokemonSet', obj: {
        products: migrateProductRows(saved.products, saved.inputs, saved.quantity),
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        monitorDelay: String(saved.monitorDelay || '3000'),
        retryDelay: String(saved.retryDelay || '3000'),
        loopCheckout: !!saved.loopCheckout,
        waitForQueue: !!saved.waitForQueue,
        queueEntryDelay: String(saved.queueEntryDelay || '0'),
        allInstock: !!saved.allInstock,
      } });
      this.setState({ setupOpen: saved.setupOpen !== false });
    } catch {}
  }

  componentWillUnmount() {
    this.flushPersist();
    clearTimeout(this.editTimer);
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
    const payload = { ...this.props.pokemon, ...over };
    const saved = {
      products: payload.products, tasks: payload.tasks,
      monitorDelay: payload.monitorDelay, retryDelay: payload.retryDelay,
      loopCheckout: payload.loopCheckout, waitForQueue: payload.waitForQueue,
      queueEntryDelay: payload.queueEntryDelay, allInstock: payload.allInstock,
      setupOpen: payload.setupOpen !== undefined ? payload.setupOpen !== false : this.state.setupOpen !== false,
    };
    try { ipcRenderer.sendSync('savePokemonCenterTasks', saved); } catch {}
  };

  setModule = (key, value, live = true) => {
    this.props.dispatch({ type: 'pokemonSet', obj: { [key]: value } });
    this.persist({ [key]: value });
    if (live) this.queueLiveEdit({ [key]: value });
  };

  updateProduct = (id, obj) => {
    const products = this.props.pokemon.products.map(product => product.id === id ? { ...product, ...obj } : product);
    this.setModule('products', products);
  };

  addProduct = () => {
    if (this.props.pokemon.products.length >= MAX_PRODUCTS) return;
    this.setModule('products', [...this.props.pokemon.products, blankProduct()]);
  };

  removeProduct = id => {
    const products = this.props.pokemon.products.filter(product => product.id !== id);
    this.setModule('products', products.length ? products : [blankProduct()]);
  };

  cloneProducts = products => migrateProductRows(products)
    .filter(product => String(product.input || '').trim())
    .map(product => ({ ...product, id: productUid() }));

  applyProductsToAllTasks = () => {
    const validation = validateProducts(this.props.pokemon.products);
    if (validation.invalid.length) {
      this.flash('Use a Pokémon Center SKU, product URL, or placeholder');
      return;
    }
    if (!validation.products.length) {
      this.flash('Add at least one product SKU or placeholder');
      return;
    }
    if (validation.tooMany) {
      this.flash(`Pokémon Center supports up to ${MAX_PRODUCTS} products per task`);
      return;
    }
    const tasks = this.props.pokemon.tasks || [];
    if (!tasks.length) {
      this.flash('Create tasks first');
      return;
    }
    const count = tasks.length;
    if (!window.confirm(`Set these products on all ${count} task${count === 1 ? '' : 's'}? Task-specific SKUs will be replaced.`)) return;
    const next = tasks.map(task => ({ ...task, products: this.cloneProducts(this.props.pokemon.products) }));
    this.props.dispatch({ type: 'pokemonSet', obj: { tasks: next } });
    this.persist({ tasks: next });
    const running = this.runningTasks().map(task => next.find(value => value.id === task.id)).filter(Boolean);
    if (running.length) {
      const result = ipcRenderer.sendSync('editPokemonCenter', { ...this.sharedConfig(), tasks: running });
      this.flash(result && result.ok
        ? `Set products on ${count} task${count === 1 ? '' : 's'} · ${result.updated} running`
        : ((result && result.error) || 'Saved on tasks, but the running engine did not take the update'));
      return;
    }
    this.flash(`Set products on ${count} task${count === 1 ? '' : 's'}`);
  };

  productsForTask = task => (Array.isArray(task && task.products) && task.products.length
    ? task.products : this.props.pokemon.products);

  configuredProductCount = products => (Array.isArray(products) ? products : [])
    .filter(product => String((product && product.input) || '').trim()).length;

  toggleSetup = () => {
    const setupOpen = this.state.setupOpen === false;
    this.setState({ setupOpen });
    this.persist({ setupOpen });
  };

  setupSummary = () => {
    const { pokemon } = this.props;
    const productCount = this.configuredProductCount(pokemon.products);
    const taskCount = (pokemon.tasks || []).length;
    const parts = [
      `${productCount} product${productCount === 1 ? '' : 's'}`,
      pokemon.waitForQueue ? 'Wait for queue' : 'Queue off',
      `Queue delay ${String(pokemon.queueEntryDelay || '0')}`,
      `${taskCount} task${taskCount === 1 ? '' : 's'}`,
    ];
    if (pokemon.loopCheckout) parts.push('Loop checkout');
    return parts.join(' · ');
  };

  openTaskProducts = task => {
    const source = this.productsForTask(task);
    this.setState({
      editingProductsTask: task,
      productDraft: migrateProductRows(source).map(product => ({ ...product, id: productUid() })),
    });
  };

  closeTaskProducts = () => this.setState({ editingProductsTask: null, productDraft: [] });

  updateTaskProductDraft = (id, obj) => this.setState(state => ({
    productDraft: state.productDraft.map(product => product.id === id ? { ...product, ...obj } : product),
  }));

  addTaskProductDraft = () => this.setState(state => state.productDraft.length >= MAX_PRODUCTS ? null : ({
    productDraft: [...state.productDraft, blankProduct()],
  }));

  removeTaskProductDraft = id => this.setState(state => {
    const productDraft = state.productDraft.filter(product => product.id !== id);
    return { productDraft: productDraft.length ? productDraft : [blankProduct()] };
  });

  saveTaskProducts = () => {
    const { editingProductsTask, productDraft } = this.state;
    if (!editingProductsTask) return;
    const validation = validateProducts(productDraft);
    if (validation.invalid.length) { this.flash('Use a Pokémon Center SKU, product URL, or placeholder'); return; }
    if (!validation.products.length) { this.flash('Add at least one product SKU or placeholder'); return; }
    const products = productDraft.map(product => ({
      id: String(product.id || productUid()),
      input: String(product.input || '').trim(),
      quantity: normalizeQuantity(product.quantity),
    })).filter(product => product.input).slice(0, MAX_PRODUCTS);
    this.updateTask(editingProductsTask, { products });
    this.closeTaskProducts();
  };

  useSharedTaskProducts = () => {
    if (!this.state.editingProductsTask) return;
    this.updateTask(this.state.editingProductsTask, { products: undefined });
    this.closeTaskProducts();
  };

  sharedConfig = (over = {}) => {
    const p = { ...this.props.pokemon, ...over };
    return {
      products: validateProducts(p.products).products.slice(0, MAX_PRODUCTS),
      monitorDelay: String(p.monitorDelay || '3000'), retryDelay: String(p.retryDelay || '3000'),
      loopCheckout: !!p.loopCheckout, waitForQueue: !!p.waitForQueue,
      queueEntryDelay: String(p.queueEntryDelay || '0'), allInstock: !!p.allInstock,
    };
  };

  runningTasks = () => this.props.pokemon.tasks.filter(task => {
    const status = this.props.pokemon.taskStatus[task.id];
    return status && status.running !== false;
  });

  queueLiveEdit = (over = {}) => {
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      const tasks = this.runningTasks();
      if (!tasks.length) return;
      const validation = validateProducts(({ ...this.props.pokemon, ...over }).products);
      if (validation.invalid.length) {
        this.flash('Use a Pokémon Center SKU, product URL, or placeholder');
        return;
      }
      if (validation.tooMany) {
        this.flash(`Pokémon Center supports up to ${MAX_PRODUCTS} products per task`);
        return;
      }
      const result = ipcRenderer.sendSync('editPokemonCenter', { ...this.sharedConfig(over), tasks });
      this.flash(result && result.ok ? `Updated ${result.updated} running task${result.updated === 1 ? '' : 's'}`
        : ((result && result.error) || 'Live update failed'));
    }, 350);
  };

  flash = notice => {
    this.setState({ notice });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.setState({ notice: '' }), 3500);
  };

  toggleDraftProfile = id => {
    const selected = this.state.draftProfiles.includes(id)
      ? this.state.draftProfiles.filter(value => value !== id)
      : [...this.state.draftProfiles, id];
    this.setState({ draftProfiles: selected });
  };

  createTasks = () => {
    const { draftProfiles, draftProxy, draftCount } = this.state;
    if (!draftProfiles.length) return;
    const count = Math.max(1, Math.min(20, parseInt(draftCount, 10) || 1));
    const tasks = draftProfiles.flatMap(profileId => Array.from({ length: count }, () => ({
      id: uid(), profileId, proxyListName: draftProxy,
    })));
    const next = [...this.props.pokemon.tasks, ...tasks];
    this.props.dispatch({ type: 'pokemonTasksAdd', tasks });
    this.persist({ tasks: next });
    this.setState({ draftProfiles: [] });
  };

  updateTask = (task, obj) => {
    const updated = { ...task, ...obj };
    const resetsProducts = Object.prototype.hasOwnProperty.call(obj, 'products') && obj.products == null;
    if (resetsProducts) delete updated.products;
    const tasks = this.props.pokemon.tasks.map(value => value.id === task.id ? updated : value);
    this.props.dispatch({ type: 'pokemonSet', obj: { tasks } });
    this.persist({ tasks });
    if (!this.props.pokemon.taskStatus[task.id]) return;
    if (Object.prototype.hasOwnProperty.call(obj, 'proxyListName')) {
      const ok = ipcRenderer.sendSync('setPokemonCenterTaskProxy', task.id, obj.proxyListName);
      this.flash(ok ? 'Proxy update sent to the running task' : 'Proxy update could not reach the engine');
      return;
    }
    const engineUpdated = resetsProducts ? { ...updated, products: this.props.pokemon.products } : updated;
    const result = ipcRenderer.sendSync('editPokemonCenter', { ...this.sharedConfig(), tasks: [engineUpdated] });
    this.flash(result && result.ok ? 'Running task updated' : ((result && result.error) || 'Task update failed'));
  };

  removeTask = task => {
    if (this.props.pokemon.taskStatus[task.id]) ipcRenderer.sendSync('stopPokemonCenter', task.id);
    const tasks = this.props.pokemon.tasks.filter(value => value.id !== task.id);
    this.props.dispatch({ type: 'pokemonTaskDelete', id: task.id });
    this.persist({ tasks });
  };

  start = tasks => {
    const profiles = profileList(this.props.profiles);
    const validIds = new Set(profiles.map(profile => String(profile.id)));
    const launch = tasks.filter(task => validIds.has(String(task.profileId)));
    if (!launch.length) { this.flash('Select a valid checkout profile'); return; }
    const validations = launch.map(task => validateProducts(this.productsForTask(task)));
    if (validations.some(validation => validation.invalid.length)) {
      this.flash('Use a Pokémon Center SKU, product URL, or placeholder');
      return;
    }
    if (validations.some(validation => !validation.products.length)) {
      this.flash('Add at least one product SKU or placeholder');
      return;
    }
    if (validations.some(validation => validation.tooMany)) {
      this.flash(`Use no more than ${MAX_PRODUCTS} products per task`);
      return;
    }
    const ok = ipcRenderer.sendSync('startPokemonCenter', { ...this.sharedConfig(), tasks: launch });
    if (ok) this.props.dispatch({ type: 'pokemonLaunch', taskIds: launch.map(task => task.id) });
    else this.flash('The native Pokémon Center engine did not start');
  };

  stop = taskId => { ipcRenderer.sendSync('stopPokemonCenter', taskId); };

  renderTaskRow = (task, { profilesById, profileOptions, proxyOptions }) => {
    const profile = profilesById.get(String(task.profileId));
    const status = this.props.pokemon.taskStatus[task.id];
    const active = status && status.running !== false;
    const input = this.props.pokemon.taskInputs[task.id];
    const open = this.state.expanded === task.id;
    const taskProducts = this.productsForTask(task);
    const taskProductCount = this.configuredProductCount(taskProducts);
    const customProducts = Array.isArray(task.products) && task.products.length > 0;
    return (
      <div key={task.id} className="site-task-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(170px, 1fr) 190px 165px 185px', gap: 10 }}>
        <InlineSelect
          className="form-select"
          value={task.profileId}
          placeholder="Select profile"
          options={profileOptions}
          onChange={value => this.updateTask(task, { profileId: value })}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(input && input.productName) || ''}>
          {`${taskProductCount} product${taskProductCount === 1 ? '' : 's'} configured`}
          {customProducts && <small style={{ marginLeft: 5, color: 'var(--muted)' }}>task-specific</small>}
          {input && input.productName && <small style={{ marginLeft: 5, color: 'var(--muted)' }}>· {input.productName}</small>}
        </span>
        <InlineSelect
          className="form-select"
          value={task.proxyListName || ''}
          placeholder="Local (no proxy)"
          options={proxyOptions}
          onChange={value => this.updateTask(task, { proxyListName: value })}
        />
        <Status value={status} />
        <span style={{ display: 'flex', gap: 5 }}>
          {active
            ? <button className="btn btn-secondary btn-sm" onClick={() => this.stop(task.id)}>Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={() => this.start([task])} disabled={!profile}>Start</button>}
          <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.openTaskProducts(task)} title="Edit task products"><i className="ion-md-create" /></button>
          {showOperatorLogs(this.props.settings) && (
            <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ expanded: open ? null : task.id })} title="Task log">Log</button>
          )}
          <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeTask(task)} title="Delete task"><i className="ion-md-trash" /></button>
        </span>
      </div>
    );
  };

  render() {
    const { pokemon, profiles, proxies } = this.props;
    const { draftProfiles, draftProxy, draftCount, expanded, notice, editingProductsTask, productDraft, setupOpen } = this.state;
    const list = profileList(profiles);
    const proxyLists = (proxies && proxies.lists) || [];
    const profilesById = indexById(list);
    const usedByProfile = new Map();
    for (const task of pokemon.tasks || []) {
      const id = String(task.profileId || '');
      if (id) usedByProfile.set(id, (usedByProfile.get(id) || 0) + 1);
    }
    const profileOptions = list.map(value => ({ value: value.id, label: profileName(value) }));
    const proxyOptions = [{ value: '', label: 'Local (no proxy)' }, ...proxyLists.map(proxy => ({ value: proxyRef(proxy), label: proxyLabel(proxy) }))];

    return (
      <div className="page" style={{ padding: '16px 20px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="page-header" style={{ marginBottom: 14 }}>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}><span className="page-title-dot" /> Pokémon Center US</h1>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Native guest checkout · manual captcha windows open automatically
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notice && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{notice}</span>}
            <button className="btn btn-secondary" onClick={this.toggleSetup}>
              {setupOpen ? 'Hide setup' : 'Show setup'}
            </button>
            <button className="btn btn-primary" onClick={() => this.start(pokemon.tasks)} disabled={!pokemon.tasks.length}>Start All</button>
            <button className="btn btn-secondary" onClick={() => this.stop()}>Stop All</button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!setupOpen && (
            <button
              type="button"
              className="panel"
              onClick={this.toggleSetup}
              title="Show setup"
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', margin: '0 0 14px',
                padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
              }}
            >
              <strong style={{ fontSize: 12 }}>Setup</strong>
              <span style={{ flex: 1, color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {this.setupSummary()}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}>Show setup</span>
            </button>
          )}
          {setupOpen && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(290px, .9fr) minmax(340px, 1.1fr)', gap: 14, marginBottom: 14 }}>
            <div className="panel" style={{ margin: 0, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
                <strong style={{ fontSize: 12 }}>Products</strong>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={this.applyProductsToAllTasks}
                    disabled={!pokemon.tasks.length}
                    title="Replace every task's SKUs with these products, including running tasks"
                  >
                    Apply to all tasks
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={this.addProduct} disabled={pokemon.products.length >= MAX_PRODUCTS}>
                    <i className="ion-md-add" style={{ marginRight: 5 }} />Add product
                  </button>
                </span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {pokemon.products.map((product, index) => (
                  <div key={product.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 72px 30px', gap: 7, alignItems: 'end' }}>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">SKU or product URL {index + 1}</span>
                      <input
                        className="form-input"
                        value={product.input}
                        onChange={event => this.updateProduct(product.id, { input: event.target.value })}
                        placeholder={index === 0 ? '10-10451-115' : 'SKU, URL, or placeholder'}
                      />
                    </label>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">Qty</span>
                      <input
                        className="form-input"
                        inputMode="numeric"
                        value={product.quantity}
                        onChange={event => this.updateProduct(product.id, { quantity: event.target.value.replace(/\D/g, '').slice(0, 4) || '1' })}
                      />
                    </label>
                    <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeProduct(product.id)} title="Remove product">
                      <i className="ion-md-trash" />
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.45, color: 'var(--muted)' }}>
                Add up to three SKUs, full product URLs, or <b>placeholder</b>. Each product has its own quantity; the engine reduces it to the site's purchase limit when necessary.
                Use <b>Apply to all tasks</b> when SKUs drop so every task, including ones already waiting in queue, watches the same products.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 12 }}>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Monitor ms</span>
                  <input className="form-input" value={pokemon.monitorDelay} onChange={e => this.setModule('monitorDelay', e.target.value.replace(/\D/g, '').slice(0, 6))} />
                </label>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Retry ms</span>
                  <input className="form-input" value={pokemon.retryDelay} onChange={e => this.setModule('retryDelay', e.target.value.replace(/\D/g, '').slice(0, 6))} />
                </label>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 14px', marginTop: 12, fontSize: 11 }}>
                <label title="Idle until the queue-status service detects a queue or site protection."><input type="checkbox" checked={pokemon.waitForQueue} onChange={e => this.setModule('waitForQueue', e.target.checked)} /> Wait for queue (24/7)</label>
                <label title="With multiple inputs, do not cart until every product is in stock."><input type="checkbox" checked={pokemon.allInstock} onChange={e => this.setModule('allInstock', e.target.checked)} /> Require all in stock</label>
                <label title="After checkout or decline, rotate to another profile in the selected profile's first group."><input type="checkbox" checked={pokemon.loopCheckout} onChange={e => this.setModule('loopCheckout', e.target.checked)} /> Loop checkout</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Queue delay
                  <input className="form-input" title="Applied the next time a task starts." value={pokemon.queueEntryDelay} onChange={e => this.setModule('queueEntryDelay', e.target.value.replace(/\D/g, '').slice(0, 6), false)} style={{ width: 66, padding: '3px 6px' }} />
                </label>
              </div>
              <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.4 }}>
                Wait for queue checks the HTTPS queue-status endpoint every three seconds. Open a task’s Log to see the first healthy response,
                30-second heartbeats, failures/recovery, and the event that moves it into the queue.
              </div>
            </div>

            <div className="panel" style={{ margin: 0, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 12 }}>Create profile tasks</strong>
                <button className="btn btn-primary btn-sm" onClick={this.createTasks} disabled={!draftProfiles.length}>
                  Create {draftProfiles.length ? draftProfiles.length * (parseInt(draftCount, 10) || 1) : ''} Task{draftProfiles.length * (parseInt(draftCount, 10) || 1) === 1 ? '' : 's'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 190px', gap: 12 }}>
                <div style={{ height: 184, overflowY: 'auto', border: '1px solid var(--panel-border)', borderRadius: 7, padding: 4 }}>
                  {!list.length && <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>Add a checkout profile first.</div>}
                  {list.map(profile => {
                    const selected = draftProfiles.includes(profile.id);
                    const used = usedByProfile.get(String(profile.id)) || 0;
                    return (
                      <div key={profile.id} onClick={() => this.toggleDraftProfile(profile.id)} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5,
                        cursor: 'pointer', background: selected ? 'var(--accent-soft)' : 'transparent', fontSize: 11,
                      }}>
                        <input type="checkbox" readOnly checked={selected} style={{ pointerEvents: 'none' }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{profileName(profile)}</span>
                        {used > 0 && <span style={{ color: 'var(--muted)', fontSize: 10 }}>{used} task{used === 1 ? '' : 's'}</span>}
                      </div>
                    );
                  })}
                </div>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Proxy</span>
                  <select className="form-select" value={draftProxy} onChange={e => this.setState({ draftProxy: e.target.value })}>
                    <option value="">Local (no proxy)</option>
                    {proxyLists.map(proxy => <option key={proxyRef(proxy)} value={proxyRef(proxy)}>{proxyLabel(proxy)}</option>)}
                  </select>
                  <span className="form-label" style={{ display: 'block', marginTop: 10 }}>Tasks per profile</span>
                  <input className="form-input" value={draftCount} onChange={e => this.setState({ draftCount: e.target.value.replace(/\D/g, '').slice(0, 2) || '1' })} />
                  <span style={{ display: 'block', marginTop: 9, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.45 }}>
                    Recommended: 2–6 tasks per profile. Loop Checkout rotates through the profile's first group. No Pokémon Center account is required.
                  </span>
                </label>
              </div>
            </div>
          </div>}

          <div className="panel site-task-panel">
            <div className="site-task-head" style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(170px, 1fr) 190px 165px 185px', gap: 10 }}>
              <span>PROFILE</span><span>PRODUCTS</span><span>PROXY</span><span>STATUS</span><span>ACTIONS</span>
            </div>
            {!pokemon.tasks.length && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>No Pokémon Center tasks yet.</div>}
            {!!pokemon.tasks.length && (
              <VirtualList
                className="virtual-list site-task-virtual"
                count={pokemon.tasks.length}
                rowHeight={TASK_ROW_HEIGHT}
                estimatedHeight={480}
                renderRow={index => this.renderTaskRow(pokemon.tasks[index], {
                  profilesById, profileOptions, proxyOptions,
                })}
              />
            )}
            {showOperatorLogs(this.props.settings) && expanded && (
              <div className="site-task-log-dock">
                <PokemonTaskLog
                  className="task-log-view"
                  taskId={expanded}
                  estimatedHeight={160}
                  empty={<span style={{ color: 'var(--muted)', fontSize: 10.5 }}>No task output yet.</span>}
                />
              </div>
            )}
          </div>

          {showOperatorLogs(this.props.settings) && (
          <div className="panel" style={{ marginTop: 14, padding: 12 }}>
            <strong style={{ fontSize: 11 }}>Engine log</strong>
            <PokemonEngineLog
              className="task-log-view"
              estimatedHeight={180}
              empty={<span style={{ color: 'var(--muted)', fontSize: 10.5 }}>Task and monitor output will appear here.</span>}
            />
          </div>
          )}
        </div>

        {editingProductsTask && <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeTaskProducts()}>
          <div className="modal" style={{ width: 620 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Edit task products</div>
                <p style={{ margin: '3px 0 0', color: 'var(--muted)', fontSize: 10.5 }}>
                  Changes are sent to this task immediately, including while it is waiting for or passing a queue.
                </p>
              </div>
              <button className="modal-close" onClick={this.closeTaskProducts}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gap: 9 }}>
                {productDraft.map((product, index) => (
                  <div key={product.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 82px 32px', gap: 8, alignItems: 'end' }}>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">SKU or product URL {index + 1}</span>
                      <input
                        className="form-input"
                        autoFocus={index === 0}
                        value={product.input}
                        onChange={event => this.updateTaskProductDraft(product.id, { input: event.target.value })}
                        placeholder="SKU, URL, or placeholder"
                      />
                    </label>
                    <label className="form-group" style={{ margin: 0 }}>
                      <span className="form-label">Qty</span>
                      <input
                        className="form-input"
                        inputMode="numeric"
                        value={product.quantity}
                        onChange={event => this.updateTaskProductDraft(product.id, { quantity: event.target.value.replace(/\D/g, '').slice(0, 4) || '1' })}
                      />
                    </label>
                    <button className="btn btn-secondary btn-sm btn-icon" onClick={() => this.removeTaskProductDraft(product.id)} title="Remove product">
                      <i className="ion-md-trash" />
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={this.addTaskProductDraft} disabled={productDraft.length >= MAX_PRODUCTS}>
                <i className="ion-md-add" style={{ marginRight: 5 }} />Add product
              </button>
            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              <button className="btn btn-secondary" onClick={this.useSharedTaskProducts}>Use shared products</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" onClick={this.closeTaskProducts}>Cancel</button>
                <button className="btn btn-primary" onClick={this.saveTaskProducts}>Save &amp; update task</button>
              </div>
            </div>
          </div>
        </div>}
      </div>
    );
  }
}

export default connect(state => ({
  pokemon: pickTableState(state.pokemon, POKEMON_TABLE_KEYS),
  profiles: state.profiles, proxies: state.proxies,
  settings: state.settings,
}))(PokemonCenter);
