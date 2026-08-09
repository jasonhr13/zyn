import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyLabel, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

const uid = () => 'pc_' + Math.random().toString(36).slice(2, 10);
const MAX_PRODUCTS = 3;
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

function validateProducts(value) {
  const entries = String(value || '').split(/[\n,]/).map(line => line.trim()).filter(Boolean);
  const normalized = entries.map(normalizeProductInput);
  return {
    inputs: [...new Set(normalized.filter(Boolean))],
    invalid: entries.filter((entry, index) => !normalized[index]),
  };
}

const parseInputs = value => validateProducts(value).inputs;

function profileList(profiles) {
  return (profiles && (profiles.list || profiles.profiles)) || (Array.isArray(profiles) ? profiles : []);
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
  state = { draftProfiles: [], draftProxy: '', draftCount: '2', expanded: null, notice: '' };

  componentDidMount() {
    try {
      const saved = ipcRenderer.sendSync('getPokemonCenterTasks') || {};
      this.props.dispatch({ type: 'pokemonSet', obj: {
        inputs: typeof saved.inputs === 'string' ? saved.inputs : '',
        tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
        quantity: String(saved.quantity || '1'),
        monitorDelay: String(saved.monitorDelay || '3000'),
        retryDelay: String(saved.retryDelay || '3000'),
        loopCheckout: !!saved.loopCheckout,
        waitForQueue: !!saved.waitForQueue,
        queueEntryDelay: String(saved.queueEntryDelay || '0'),
        allInstock: !!saved.allInstock,
      } });
    } catch {}
  }

  componentWillUnmount() { clearTimeout(this.editTimer); clearTimeout(this.noticeTimer); }

  persist = (over = {}) => {
    const payload = { ...this.props.pokemon, ...over };
    const saved = {
      inputs: payload.inputs, tasks: payload.tasks, quantity: payload.quantity,
      monitorDelay: payload.monitorDelay, retryDelay: payload.retryDelay,
      loopCheckout: payload.loopCheckout, waitForQueue: payload.waitForQueue,
      queueEntryDelay: payload.queueEntryDelay, allInstock: payload.allInstock,
    };
    try { ipcRenderer.sendSync('savePokemonCenterTasks', saved); } catch {}
  };

  setModule = (key, value, live = true) => {
    this.props.dispatch({ type: 'pokemonSet', obj: { [key]: value } });
    this.persist({ [key]: value });
    if (live) this.queueLiveEdit({ [key]: value });
  };

  sharedConfig = (over = {}) => {
    const p = { ...this.props.pokemon, ...over };
    return {
      inputs: parseInputs(p.inputs).slice(0, MAX_PRODUCTS), quantity: String(p.quantity || '1'),
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
      const validation = validateProducts(({ ...this.props.pokemon, ...over }).inputs);
      if (validation.invalid.length) {
        this.flash('Use a Pokémon Center SKU, product URL, or placeholder');
        return;
      }
      if (validation.inputs.length > MAX_PRODUCTS) {
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
    const tasks = this.props.pokemon.tasks.map(value => value.id === task.id ? updated : value);
    this.props.dispatch({ type: 'pokemonTaskUpdate', id: task.id, obj });
    this.persist({ tasks });
    if (!this.props.pokemon.taskStatus[task.id]) return;
    if (Object.prototype.hasOwnProperty.call(obj, 'proxyListName')) {
      const ok = ipcRenderer.sendSync('setPokemonCenterTaskProxy', task.id, obj.proxyListName);
      this.flash(ok ? 'Proxy update sent to the running task' : 'Proxy update could not reach the engine');
      return;
    }
    const result = ipcRenderer.sendSync('editPokemonCenter', { ...this.sharedConfig(), tasks: [updated] });
    this.flash(result && result.ok ? 'Running task updated' : ((result && result.error) || 'Task update failed'));
  };

  removeTask = task => {
    if (this.props.pokemon.taskStatus[task.id]) ipcRenderer.sendSync('stopPokemonCenter', task.id);
    const tasks = this.props.pokemon.tasks.filter(value => value.id !== task.id);
    this.props.dispatch({ type: 'pokemonTaskDelete', id: task.id });
    this.persist({ tasks });
  };

  start = tasks => {
    const validation = validateProducts(this.props.pokemon.inputs);
    const inputs = validation.inputs;
    if (validation.invalid.length) { this.flash('Use a Pokémon Center SKU, product URL, or placeholder'); return; }
    if (!inputs.length) { this.flash('Add at least one product slug or URL'); return; }
    if (inputs.length > MAX_PRODUCTS) { this.flash(`Use no more than ${MAX_PRODUCTS} products per task`); return; }
    const profiles = profileList(this.props.profiles);
    const validIds = new Set(profiles.map(profile => String(profile.id)));
    const launch = tasks.filter(task => validIds.has(String(task.profileId)));
    if (!launch.length) { this.flash('Select a valid checkout profile'); return; }
    const ok = ipcRenderer.sendSync('startPokemonCenter', { ...this.sharedConfig(), tasks: launch });
    if (ok) this.props.dispatch({ type: 'pokemonLaunch', taskIds: launch.map(task => task.id) });
    else this.flash('The native Pokémon Center engine did not start');
  };

  stop = taskId => { ipcRenderer.sendSync('stopPokemonCenter', taskId); };

  render() {
    const { pokemon, profiles, proxies } = this.props;
    const { draftProfiles, draftProxy, draftCount, expanded, notice } = this.state;
    const list = profileList(profiles);
    const proxyLists = (proxies && proxies.lists) || [];
    const inputs = parseInputs(pokemon.inputs);

    return (
      <div className="page" style={{ padding: '16px 20px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="page-header" style={{ marginBottom: 14 }}>
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>Pokémon Center US</h1>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
              Native guest checkout · manual captcha windows open automatically
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notice && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{notice}</span>}
            <button className="btn btn-primary" onClick={() => this.start(pokemon.tasks)} disabled={!pokemon.tasks.length}>Start All</button>
            <button className="btn btn-secondary" onClick={() => this.stop()}>Stop All</button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(290px, .9fr) minmax(340px, 1.1fr)', gap: 14, marginBottom: 14 }}>
            <div className="panel" style={{ margin: 0, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 12 }}>Products</strong>
                <span style={{ fontSize: 11, color: inputs.length > MAX_PRODUCTS ? '#fb5454' : 'var(--muted)' }}>
                  {inputs.length}/{MAX_PRODUCTS} products
                </span>
              </div>
              <textarea
                className="form-input"
                value={pokemon.inputs}
                onChange={event => this.setModule('inputs', event.target.value)}
                placeholder={'10-10451-115\nhttps://www.pokemoncenter.com/product/10-10451-115\nplaceholder'}
                style={{ minHeight: 128, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
              />
              <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.45, color: 'var(--muted)' }}>
                SKU, full product URL, or <b>placeholder</b>. Placeholder passes the queue and waits for a live edit. Multi-cart supports up to three products.
                Requested quantity is automatically reduced to the product's purchase limit.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
                <label className="form-group" style={{ margin: 0 }}>
                  <span className="form-label">Quantity</span>
                  <input className="form-input" value={pokemon.quantity} onChange={e => this.setModule('quantity', e.target.value.replace(/\D/g, '').slice(0, 4) || '1')} />
                </label>
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
                <label title="Idle until the existing Polar queue-status service detects a queue or site protection."><input type="checkbox" checked={pokemon.waitForQueue} onChange={e => this.setModule('waitForQueue', e.target.checked)} /> Wait for queue (24/7)</label>
                <label title="With multiple inputs, do not cart until every product is in stock."><input type="checkbox" checked={pokemon.allInstock} onChange={e => this.setModule('allInstock', e.target.checked)} /> Require all in stock</label>
                <label title="After checkout or decline, rotate to another profile in the selected profile's first group."><input type="checkbox" checked={pokemon.loopCheckout} onChange={e => this.setModule('loopCheckout', e.target.checked)} /> Loop checkout</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Queue delay
                  <input className="form-input" title="Applied the next time a task starts." value={pokemon.queueEntryDelay} onChange={e => this.setModule('queueEntryDelay', e.target.value.replace(/\D/g, '').slice(0, 6), false)} style={{ width: 66, padding: '3px 6px' }} />
                </label>
              </div>
              <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.4 }}>
                Wait for queue keeps tasks idle until Railway reports a Pokémon Center queue or other site protection, then starts checkout automatically.
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
                    const used = pokemon.tasks.filter(task => String(task.profileId) === String(profile.id)).length;
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
                    Polar recommends 2–6 tasks per profile. Loop Checkout rotates through the profile's first group. No Pokémon Center account is required.
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div className="panel" style={{ margin: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(170px, 1fr) 190px 165px 112px', gap: 10, padding: '9px 12px', borderBottom: '1px solid var(--panel-border)', color: 'var(--muted)', fontSize: 10.5, fontWeight: 650 }}>
              <span>PROFILE</span><span>PRODUCT</span><span>PROXY</span><span>STATUS</span><span>ACTIONS</span>
            </div>
            {!pokemon.tasks.length && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>No Pokémon Center tasks yet.</div>}
            {pokemon.tasks.map(task => {
              const profile = list.find(value => String(value.id) === String(task.profileId));
              const status = pokemon.taskStatus[task.id];
              const active = status && status.running !== false;
              const input = pokemon.taskInputs[task.id];
              const logs = pokemon.taskLogs[task.id] || [];
              const open = expanded === task.id;
              return (
                <div key={task.id} style={{ borderBottom: '1px solid var(--panel-border)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1fr) minmax(170px, 1fr) 190px 165px 112px', gap: 10, padding: '10px 12px', alignItems: 'center', fontSize: 11 }}>
                    <select className="form-select" value={task.profileId} onChange={e => this.updateTask(task, { profileId: e.target.value })}>
                      <option value="">Select profile</option>
                      {list.map(value => <option key={value.id} value={value.id}>{profileName(value)}</option>)}
                    </select>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(input && input.productName) || ''}>
                      {(input && input.productName) || `${inputs.length} product${inputs.length === 1 ? '' : 's'} watched`}
                    </span>
                    <select className="form-select" value={task.proxyListName || ''} onChange={e => this.updateTask(task, { proxyListName: e.target.value })}>
                      <option value="">Local (no proxy)</option>
                      {proxyLists.map(proxy => <option key={proxyRef(proxy)} value={proxyRef(proxy)}>{proxyLabel(proxy)}</option>)}
                    </select>
                    <Status value={status} />
                    <span style={{ display: 'flex', gap: 5 }}>
                      {active
                        ? <button className="btn btn-secondary btn-sm" onClick={() => this.stop(task.id)}>Stop</button>
                        : <button className="btn btn-primary btn-sm" onClick={() => this.start([task])} disabled={!profile}>Start</button>}
                      <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ expanded: open ? null : task.id })} title="Task log">Log</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => this.removeTask(task)} title="Delete task">×</button>
                    </span>
                  </div>
                  {open && <div style={{ padding: '0 12px 12px' }}>
                    <div style={{ background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: 7, padding: 9, minHeight: 52, maxHeight: 180, overflowY: 'auto' }}>
                      {!logs.length ? <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>No task output yet.</span>
                        : logs.map((line, index) => <div className="log-line" key={index}>{line}</div>)}
                    </div>
                  </div>}
                </div>
              );
            })}
          </div>

          {pokemon.logs.length > 0 && <div className="panel" style={{ marginTop: 14, padding: 12 }}>
            <strong style={{ fontSize: 11 }}>Engine log</strong>
            <div style={{ marginTop: 8, maxHeight: 140, overflowY: 'auto' }}>
              {pokemon.logs.map((line, index) => <div className="log-line" key={index}>{line}</div>)}
            </div>
          </div>}
        </div>
      </div>
    );
  }
}

export default connect(state => ({
  pokemon: state.pokemon, profiles: state.profiles, proxies: state.proxies,
}))(PokemonCenter);
