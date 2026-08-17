import React, { Component } from 'react';
import {
  DEVELOPER_URL,
  MAX_GENERATE_QUANTITY,
  MAX_TOPUP_GB,
  MIN_TOPUP_GB,
  billingHint,
  countryLabel,
  emptyResiFactoryStatus,
  estimateCost,
  formatGb,
  formatUsd,
  generateBlockedReason,
  stateLabel,
} from '../resifactory-format.mjs';

const { ipcRenderer, shell } = window.require('electron');

const TOPUP_PRESETS = [0.5, 1, 2, 5, 10];

const openExternal = (event, url) => {
  if (event) event.preventDefault();
  const target = String(url || '').trim();
  if (!target) return;
  try { shell.openExternal(target); } catch {}
};

const stickyType = value => value === 'sticky' || value === 'mobile_sticky';

export const RESIFACTORY_PROVIDER = {
  id: 'resifactory',
  label: 'ResiFactory',
  ipcPrefix: 'resiFactory',
  updatedEvent: 'resiFactoryUpdated',
  dashboardUrl: DEVELOPER_URL,
  keyPlaceholder: 'rf_live_…',
  supportsBilling: true,
  maxQuantity: MAX_GENERATE_QUANTITY,
  defaultQuantity: '50',
  connectCopy: 'Link an API key to see remaining GB, generate lists, and add data without leaving Zyn.',
};

export const EVOMI_PROVIDER = {
  id: 'evomi',
  label: 'Evomi',
  ipcPrefix: 'evomi',
  updatedEvent: 'evomiUpdated',
  dashboardUrl: 'https://my.evomi.com',
  keyPlaceholder: 'Evomi API key',
  supportsBilling: false,
  maxQuantity: 100,
  defaultQuantity: '50',
  connectCopy: 'Link an API key to see remaining data and generate lists. Buy bandwidth on the Evomi dashboard.',
};

export const IPFIST_PROVIDER = {
  id: 'ipfist',
  label: 'IPFist',
  ipcPrefix: 'ipfist',
  updatedEvent: 'ipfistUpdated',
  dashboardUrl: 'https://www.ipfist.com',
  keyPlaceholder: 'ak_…',
  supportsBilling: false,
  maxQuantity: 100,
  defaultQuantity: '10',
  connectCopy: 'Link a residential API key to see remaining data and generate lists. Buy bandwidth on the IPFist dashboard.',
};

const lastStatusById = {};

class ResiFactoryPanel extends Component {
  provider = () => this.props.provider || RESIFACTORY_PROVIDER;

  channel = (name) => `${this.provider().ipcPrefix}${name}`;

  state = {
    status: lastStatusById[(this.props.provider || RESIFACTORY_PROVIDER).id] || emptyResiFactoryStatus(),
    ready: Boolean(lastStatusById[(this.props.provider || RESIFACTORY_PROVIDER).id]),
    keyInput: '',
    showKey: false,
    busy: '',
    notice: '',
    generateOpen: false,
    generatePool: '',
    generateCountry: 'us',
    generateState: '',
    generateType: 'sticky',
    generateDuration: '30',
    generateQuantity: '50',
    generateName: '',
    topupOpen: false,
    topupPool: '',
    topupGb: '1',
  };

  pollTimer = null;

  componentDidMount() {
    ipcRenderer.on(this.provider().updatedEvent, this.applyPushedStatus);
    this.hydrate();
  }

  componentWillUnmount() {
    ipcRenderer.removeListener(this.provider().updatedEvent, this.applyPushedStatus);
    this.stopPolling();
  }

  applyPushedStatus = (_event, status) => {
    if (status && typeof status === 'object') this.applyStatus(status);
  };

  applyStatus = (status) => {
    const next = status && typeof status === 'object' ? status : emptyResiFactoryStatus();
    lastStatusById[this.provider().id] = next;
    this.setState({ status: next, ready: true });
    if (this.provider().supportsBilling && next.pendingTopup) this.startPolling();
    else this.stopPolling();
  };

  hydrate = async () => {
    try {
      const cached = await ipcRenderer.invoke(this.channel('Status'));
      if (cached && cached.status && cached.status.connected) this.applyStatus(cached.status);
    } catch {}
    try {
      const live = await ipcRenderer.invoke(this.channel('Refresh'));
      if (live && live.status) this.applyStatus(live.status);
    } catch {}
    this.setState({ ready: true });
  };

  startPolling = () => {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      ipcRenderer.invoke(this.channel('PollTopup')).then(result => {
        if (result && result.ok && result.status) this.applyStatus(result.status);
      }).catch(() => {});
    }, 3000);
  };

  stopPolling = () => {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  };

  call = async (channel, payload, busy) => {
    this.setState({ busy, notice: '' });
    try {
      const result = await ipcRenderer.invoke(channel, payload);
      if (!result || result.ok !== true) {
        this.setState({ notice: (result && result.error) || `${this.provider().label} request failed.` });
        return result || { ok: false };
      }
      if (result.status) this.applyStatus(result.status);
      return result;
    } catch (error) {
      this.setState({ notice: error.message || `${this.provider().label} request failed.` });
      return { ok: false, error: error.message };
    } finally {
      this.setState({ busy: '' });
    }
  };

  refresh = () => this.call(this.channel('Refresh'), undefined, 'refresh');

  connect = async () => {
    const result = await this.call(this.channel('Connect'), { apiKey: this.state.keyInput }, 'connect');
    if (result && result.ok) this.setState({ keyInput: '', showKey: false, notice: `${this.provider().label} linked.` });
  };

  disconnect = async () => {
    if (!window.confirm(`Unlink the ${this.provider().label} key from this machine? Existing generated lists stay.`)) return;
    const result = await this.call(this.channel('Disconnect'), undefined, 'disconnect');
    if (result && result.ok) this.setState({ notice: `${this.provider().label} unlinked.` });
  };

  poolById = (id) => (this.state.status.pools || []).find(pool => pool.id === id) || null;

  openGenerate = (pool) => {
    const chosen = pool || (this.state.status.pools || []).find(item => item.granted && !item.comingSoon) || null;
    const types = (chosen && chosen.proxyTypes) || ['rotating', 'sticky'];
    const proxyType = types.includes('sticky') ? 'sticky' : (types[0] || 'rotating');
    const countries = (chosen && chosen.countries) || ['us'];
    const country = countries.includes('us') ? 'us' : (countries[0] || 'us');
    this.setState({
      generateOpen: true,
      generatePool: chosen ? chosen.id : '',
      generateCountry: country,
      generateState: '',
      generateType: proxyType,
      generateDuration: '30',
      generateQuantity: (this.props.provider || RESIFACTORY_PROVIDER).defaultQuantity,
      generateName: '',
    });
  };

  generate = async () => {
    const { generatePool, generateCountry, generateState, generateType, generateDuration, generateQuantity, generateName } = this.state;
    const pool = this.poolById(generatePool);
    const blocked = generateBlockedReason(pool, this.state.status, this.provider().label);
    if (blocked) { this.setState({ notice: blocked }); return; }
    const result = await this.call(this.channel('Generate'), {
      pool: generatePool,
      country: generateCountry,
      state: generateCountry === 'us' ? generateState : '',
      proxyType: generateType,
      sessionDuration: Number.parseInt(generateDuration, 10) || 30,
      quantity: Number.parseInt(generateQuantity, 10) || 0,
      name: generateName.trim(),
    }, 'generate');
    if (!result || result.ok !== true) return;
    if (result.proxies) this.props.onCatalog(result.proxies);
    if (result.listName && this.props.activeGroup && this.props.onAssignGroup) {
      this.props.onAssignGroup(result.listName);
    }
    this.setState({
      generateOpen: false,
      notice: `Created “${result.listName}” with ${Number(result.count || 0).toLocaleString()} proxies.`,
    });
  };

  openTopup = (pool) => {
    const chosen = pool || (this.state.status.pools || []).find(item => item.granted) || null;
    this.setState({
      topupOpen: true,
      topupPool: chosen ? chosen.id : '',
      topupGb: '1',
    });
  };

  startTopup = async () => {
    const gb = Number(this.state.topupGb);
    if (!Number.isFinite(gb) || gb < MIN_TOPUP_GB || gb > MAX_TOPUP_GB) {
      this.setState({ notice: `Enter an amount between ${MIN_TOPUP_GB} and ${MAX_TOPUP_GB} GB.` });
      return;
    }
    const result = await this.call(this.channel('StartTopup'), {
      pool: this.state.topupPool,
      gb,
    }, 'topup');
    if (!result || result.ok !== true) return;
    this.setState({
      topupOpen: false,
      notice: result.topup && result.topup.checkoutUrl
        ? `Checkout opened for ${formatGb(result.topup.gb)} · ${formatUsd(result.topup.amountUsd)}. Complete payment in the browser.`
        : 'Top-up started. Complete payment in the browser.',
    });
  };

  renderPending() {
    return (
      <div className="resifactory-card resifactory-pending-card">
        <div className="resifactory-kicker">{this.provider().label}</div>
        <h3>Checking account…</h3>
        <p>Loading the linked key and remaining data.</p>
      </div>
    );
  }

  renderConnect() {
    const { keyInput, showKey, busy } = this.state;
    const provider = this.provider();
    return (
      <div className="resifactory-card">
        <div className="resifactory-head">
          <div>
            <div className="resifactory-kicker">Provider</div>
            <h3>{provider.label}</h3>
            <p>{provider.connectCopy}</p>
          </div>
          <a className="resifactory-docs" href={provider.dashboardUrl} onClick={event => openExternal(event, provider.dashboardUrl)}>
            Dashboard
          </a>
        </div>
        <div className="resifactory-connect">
          <input
            className="form-input monospace"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder={provider.keyPlaceholder}
            value={keyInput}
            onChange={event => this.setState({ keyInput: event.target.value })}
            onKeyDown={event => { if (event.key === 'Enter') this.connect(); }}
          />
          <button type="button" className="resifactory-reveal" onClick={() => this.setState(state => ({ showKey: !state.showKey }))}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'connect' || !keyInput.trim()} onClick={this.connect}>
            {busy === 'connect' ? 'Linking…' : 'Link key'}
          </button>
        </div>
      </div>
    );
  }

  renderPools() {
    const { status, busy } = this.state;
    const provider = this.provider();
    const hint = provider.supportsBilling ? billingHint(status) : '';
    return (
      <div className="resifactory-card connected">
        <div className="resifactory-head">
          <div>
            <div className="resifactory-kicker">{provider.label}</div>
            <h3>{status.username || 'Connected'}</h3>
            <p>
              Key {status.keyLast4 ? `…${status.keyLast4}` : 'linked'}
              {status.keyName ? ` · ${status.keyName}` : ''}
              {status.billingReady ? ` · spend cap ${formatUsd(status.spendCapUsd)}` : ''}
            </p>
          </div>
          <div className="resifactory-head-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={this.refresh}>
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!status.canGenerate} onClick={() => this.openGenerate()}>
              Generate
            </button>
            {provider.supportsBilling
              ? <button type="button" className="btn btn-primary btn-sm" disabled={!status.billingReady} onClick={() => this.openTopup()}
                title={hint || 'Add bandwidth to a pool'}>Add data</button>
              : <button type="button" className="btn btn-primary btn-sm" onClick={event => openExternal(event, provider.dashboardUrl)}>Buy data</button>}
            <button type="button" className="resifactory-unlink" onClick={this.disconnect}>Unlink</button>
          </div>
        </div>
        {hint && <div className="resifactory-hint">{hint} <a href={status.developerUrl || provider.dashboardUrl} onClick={event => openExternal(event, status.developerUrl || provider.dashboardUrl)}>Open Developer tab</a></div>}
        {status.pendingTopup && (
          <div className="resifactory-pending">
            Waiting on checkout for {formatGb(status.pendingTopup.gb)} on {status.pendingTopup.pool}
            {status.pendingTopup.amountUsd ? ` · ${formatUsd(status.pendingTopup.amountUsd)}` : ''}.
          </div>
        )}
        <div className="resifactory-pools">
          {(status.pools || []).map(pool => {
            const generateReason = generateBlockedReason(pool, status, this.provider().label);
            return (
              <div className={`resifactory-pool${!pool.granted || pool.comingSoon ? ' locked' : ''}`} key={pool.id}>
                <div>
                  <strong>{pool.label}</strong>
                  <small>
                    {pool.comingSoon ? 'Not live yet' : pool.granted ? 'Ready' : 'Unlock required'}
                    {pool.host ? ` · ${pool.host}` : ''}
                  </small>
                </div>
                <div className="resifactory-pool-gb">
                  <strong>{formatGb(pool.gb)}</strong>
                  <small>{pool.pricePerGb ? `${formatUsd(pool.pricePerGb)}/GB` : 'bandwidth'}</small>
                </div>
                <div className="resifactory-pool-actions">
                  {!pool.granted && pool.claimUrl
                    ? <button type="button" className="btn btn-secondary btn-sm" onClick={event => openExternal(event, pool.claimUrl)}>Unlock</button>
                    : <>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!generateReason} title={generateReason} onClick={() => this.openGenerate(pool)}>Generate</button>
                      {this.provider().supportsBilling
                        ? <button type="button" className="btn btn-secondary btn-sm" disabled={!status.billingReady || !pool.granted} onClick={() => this.openTopup(pool)}>Add</button>
                        : <button type="button" className="btn btn-secondary btn-sm" onClick={event => openExternal(event, this.provider().dashboardUrl)}>Buy</button>}
                    </>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  renderGenerate() {
    if (!this.state.generateOpen) return null;
    const pool = this.poolById(this.state.generatePool);
    const countries = (pool && pool.countries.length) ? pool.countries : ['us'];
    const types = (pool && pool.proxyTypes.length) ? pool.proxyTypes : ['rotating', 'sticky'];
    const showState = this.state.generateCountry === 'us' && pool && pool.usStates.length;
    const blocked = generateBlockedReason(pool, this.state.status, this.provider().label);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.setState({ generateOpen: false })}>
        <div className="modal proxy-editor-modal resifactory-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">Generate {this.provider().label} list</div><p>Lines are saved as a normal local proxy list you can assign to tasks.</p></div>
            <button className="modal-close" onClick={() => this.setState({ generateOpen: false })}>×</button>
          </div>
          <div className="modal-body resifactory-modal-body">
            <div className="form-group">
              <label className="form-label">Pool</label>
              <select className="form-select" value={this.state.generatePool} onChange={event => {
                const next = this.poolById(event.target.value);
                const types = (next && next.proxyTypes.length) ? next.proxyTypes : ['rotating', 'sticky'];
                const countries = (next && next.countries.length) ? next.countries : ['us'];
                this.setState({
                  generatePool: event.target.value,
                  generateState: '',
                  generateType: types.includes(this.state.generateType)
                    ? this.state.generateType
                    : (types.includes('sticky') ? 'sticky' : types[0]),
                  generateCountry: countries.includes(this.state.generateCountry)
                    ? this.state.generateCountry
                    : (countries.includes('us') ? 'us' : countries[0]),
                });
              }}>
                {(this.state.status.pools || []).map(item => (
                  <option key={item.id} value={item.id}>{item.label} · {formatGb(item.gb)}</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Country</label>
                <select className="form-select" value={this.state.generateCountry} onChange={event => this.setState({ generateCountry: event.target.value, generateState: '' })}>
                  {countries.map(code => <option key={code} value={code}>{countryLabel(code)}</option>)}
                </select>
              </div>
              {showState ? (
                <div className="form-group">
                  <label className="form-label">State</label>
                  <select className="form-select" value={this.state.generateState} onChange={event => this.setState({ generateState: event.target.value })}>
                    <option value="">Any state</option>
                    {pool.usStates.map(value => <option key={value} value={value}>{stateLabel(value)}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-select" value={this.state.generateType} onChange={event => this.setState({ generateType: event.target.value })}>
                  {types.map(type => <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              {stickyType(this.state.generateType) && (
                <div className="form-group">
                  <label className="form-label">Sticky minutes</label>
                  <input className="form-input" type="number" min="1" max="1440" value={this.state.generateDuration}
                    onChange={event => this.setState({ generateDuration: event.target.value })} />
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Quantity</label>
                <input className="form-input" type="number" min="1" max={this.provider().maxQuantity} value={this.state.generateQuantity}
                  onChange={event => this.setState({ generateQuantity: event.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">List name</label>
              <input className="form-input" value={this.state.generateName} placeholder="Leave blank to name from the pool"
                onChange={event => this.setState({ generateName: event.target.value })} />
            </div>
            {blocked && <div className="resifactory-hint">{blocked}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => this.setState({ generateOpen: false })}>Cancel</button>
            <button className="btn btn-primary" disabled={!!blocked || this.state.busy === 'generate'} onClick={this.generate}>
              {this.state.busy === 'generate' ? 'Generating…' : 'Create list'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  renderTopup() {
    if (!this.provider().supportsBilling || !this.state.topupOpen) return null;
    const pool = this.poolById(this.state.topupPool);
    const estimate = estimateCost(this.state.topupGb, pool && pool.pricePerGb);
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.setState({ topupOpen: false })}>
        <div className="modal proxy-editor-modal resifactory-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">Add ResiFactory data</div><p>Zyn opens ResiFactory’s checkout. The charge is calculated there from the live price per GB.</p></div>
            <button className="modal-close" onClick={() => this.setState({ topupOpen: false })}>×</button>
          </div>
          <div className="modal-body resifactory-modal-body">
            <div className="form-group">
              <label className="form-label">Pool</label>
              <select className="form-select" value={this.state.topupPool} onChange={event => this.setState({ topupPool: event.target.value })}>
                {(this.state.status.pools || []).filter(item => item.granted).map(item => (
                  <option key={item.id} value={item.id}>{item.label} · {formatGb(item.gb)}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Gigabytes</label>
              <div className="resifactory-presets">
                {TOPUP_PRESETS.map(value => (
                  <button type="button" key={value} className={`resifactory-preset${Number(this.state.topupGb) === value ? ' active' : ''}`}
                    onClick={() => this.setState({ topupGb: String(value) })}>{value} GB</button>
                ))}
              </div>
              <input className="form-input" type="number" min={MIN_TOPUP_GB} max={MAX_TOPUP_GB} step="0.1" value={this.state.topupGb}
                onChange={event => this.setState({ topupGb: event.target.value })} />
              <div className="form-hint">
                {estimate != null
                  ? `About ${formatUsd(estimate)} at the current ${formatUsd(pool.pricePerGb)}/GB. Minimum charge is $0.50.`
                  : `Between ${MIN_TOPUP_GB} and ${MAX_TOPUP_GB} GB.`}
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => this.setState({ topupOpen: false })}>Cancel</button>
            <button className="btn btn-primary" disabled={this.state.busy === 'topup' || !this.state.status.billingReady} onClick={this.startTopup}>
              {this.state.busy === 'topup' ? 'Opening checkout…' : 'Open checkout'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const { status, notice } = this.state;
    return (
      <section className={`resifactory-panel${this.props.standalone ? ' standalone' : ''}`}>
        {status.connected ? this.renderPools() : this.state.ready ? this.renderConnect() : this.renderPending()}
        {status.error && !notice && <div className="resifactory-notice">{status.error}</div>}
        {notice && <div className="resifactory-notice">{notice}<button type="button" onClick={() => this.setState({ notice: '' })}>Dismiss</button></div>}
        {this.renderGenerate()}
        {this.renderTopup()}
      </section>
    );
  }
}

export default ResiFactoryPanel;
