import React, { Component } from 'react';
import { HashRouter, Route, Switch, Redirect } from 'react-router-dom';
import { connect } from 'react-redux';
import TitleBar from './title-bar';
import Sidebar from './sidebar';
import ErrorBoundary from './error-boundary';
import LicenseGate from './license-gate';
import OtpBanner from './otp-banner';
import RuntimeBanner from './runtime-banner';
import Dashboard from './pages/dashboard';
import { isTargetProxyStatus } from './target-proxy-status';
import Modules from './pages/modules';
import TaskGroups from './pages/task-groups';
import Target from './pages/target';
import PokemonCenter from './pages/pokemoncenter';
import Profiles from './pages/profiles';
import Accounts from './pages/accounts';
import Proxies from './pages/proxies';
import Settings from './pages/settings';
const { ipcRenderer } = window.require('electron');

class PageHandler extends Component {
  state = { license: null };   // null = still checking
  targetProxyTimers = {};

  componentDidMount() {
    // License: check on mount, and accept pushes from main (periodic re-check / revoke).
    ipcRenderer.invoke('licenseStatus').then(license => this.setState({ license })).catch(() => {});
    ipcRenderer.on('licenseStatus', (e, license) => this.setState({ license }));
    ipcRenderer.on('runtimeStatus', (e, runtime) => {
      this.props.dispatch({ type: 'update', obj: { runtime } });
    });
    ipcRenderer.invoke('runtimeStatus')
      .then(runtime => this.props.dispatch({ type: 'update', obj: { runtime } }))
      .catch(() => {});
    ipcRenderer.on('proxiesUpdated', (e, proxies) => {
      this.props.dispatch({ type: 'update', obj: { proxies } });
    });
    ipcRenderer.on('managedProxyError', (e, message) => {
      window.alert(String(message || 'This managed proxy list is no longer available.'));
    });

    // Load initial data
    const profiles = ipcRenderer.sendSync('getProfiles');
    const accounts = ipcRenderer.sendSync('getAccounts');
    const proxies = ipcRenderer.sendSync('getProxies');
    const settings = ipcRenderer.sendSync('getSettings');
    const discordStatus = ipcRenderer.sendSync('getDiscordStatus');
    this.props.dispatch({ type: 'update', obj: { profiles, accounts, proxies, settings, discordStatus } });

    ipcRenderer.on('discordStatus', (e, data) => {
      this.props.dispatch({ type: 'update', obj: { discordStatus: data } });
    });

    // Target checkout engine — same page-unmount reasoning as above: the engine runs in main,
    // so its status/log events are handled here and pushed to the store, not on the page.
    // `lines` is a batch (the engine's output is coalesced in main to keep the renderer alive);
    // `line` is still accepted for any single-line sender.
    // taskId MUST be forwarded. Target is multi-task now and the bridge stamps every log line and
    // status with the task it belongs to; destructuring only the old fields silently dropped it, so
    // every update arrived as module-level and each task card sat on "Idle" forever while its real
    // status scrolled past in the engine log.
    ipcRenderer.on('targetLog', (e, { line, lines, taskId }) => {
      this.props.dispatch({ type: 'targetLog', line, lines, taskId, at: Date.now() });
    });
    ipcRenderer.on('targetStatus', (e, { state, label, color, detail, taskId, taskState, running }) => {
      const receivedAt = Date.now();
      this.props.dispatch({ type: 'targetStatus', state, label, color, detail, taskId, taskState, running, receivedAt });
      if (taskId && isTargetProxyStatus(label || state)) {
        clearTimeout(this.targetProxyTimers[taskId]);
        this.targetProxyTimers[taskId] = setTimeout(() => {
          this.props.dispatch({ type: 'targetProxyStatusClear', taskId, at: receivedAt });
          delete this.targetProxyTimers[taskId];
        }, 4000);
      }
    });
    ipcRenderer.on('targetDone', (e, { taskId } = {}) => {
      this.props.dispatch({ type: 'targetDone', taskId });
    });
    ipcRenderer.on('targetRunStarted', (e, { taskIds, startedAt } = {}) => {
      this.props.dispatch({ type: 'targetRunStarted', taskIds: taskIds || [], startedAt });
    });
    ipcRenderer.on('targetMonitorBandwidth', (e, payload = {}) => {
      this.props.dispatch({ type: 'targetMonitorBandwidth', payload });
    });
    ipcRenderer.on('targetOutcome', (e, payload = {}) => {
      this.props.dispatch({ type: 'targetOutcome', ...payload });
    });
    // Logins the engine is blocked on. Sent as the WHOLE list every time it changes, so the
    // reducer can just replace it and never has to reconcile adds against removes.
    ipcRenderer.on('targetOtp', (e, { pending } = {}) => {
      this.props.dispatch({ type: 'targetOtp', pending: pending || [] });
    });

    ipcRenderer.on('pokemonLog', (e, { line, lines, taskId } = {}) => {
      this.props.dispatch({ type: 'pokemonLog', line, lines, taskId, at: Date.now() });
    });
    ipcRenderer.on('pokemonStatus', (e, payload = {}) => {
      this.props.dispatch({ type: 'pokemonStatus', ...payload });
    });
    ipcRenderer.on('pokemonInput', (e, payload = {}) => {
      this.props.dispatch({ type: 'pokemonInput', ...payload });
    });
    ipcRenderer.on('pokemonDone', (e, { taskId } = {}) => {
      this.props.dispatch({ type: 'pokemonDone', taskId });
    });

    // Update status → redux, so the sidebar badge and the Settings "Check for updates" button
    // read one shared source instead of each keeping their own copy.
    ipcRenderer.on('updateStatus', (e, update) => {
      this.props.dispatch({ type: 'update', obj: { update } });
    });

  }

  componentWillUnmount() {
    Object.values(this.targetProxyTimers).forEach(clearTimeout);
    this.targetProxyTimers = {};
    ipcRenderer.removeAllListeners('discordStatus');
    ipcRenderer.removeAllListeners('licenseStatus');
    ipcRenderer.removeAllListeners('runtimeStatus');
    ipcRenderer.removeAllListeners('proxiesUpdated');
    ipcRenderer.removeAllListeners('managedProxyError');
    ipcRenderer.removeAllListeners('targetLog');
    ipcRenderer.removeAllListeners('targetStatus');
    ipcRenderer.removeAllListeners('targetDone');
    ipcRenderer.removeAllListeners('targetRunStarted');
    ipcRenderer.removeAllListeners('targetMonitorBandwidth');
    ipcRenderer.removeAllListeners('targetOutcome');
    ipcRenderer.removeAllListeners('targetOtp');
    ipcRenderer.removeAllListeners('pokemonLog');
    ipcRenderer.removeAllListeners('pokemonStatus');
    ipcRenderer.removeAllListeners('pokemonInput');
    ipcRenderer.removeAllListeners('pokemonDone');
    ipcRenderer.removeAllListeners('updateStatus');
  }

  render() {
    const { license } = this.state;

    // Gate the whole app until the key checks out. TitleBar stays so the window is still
    // movable/closable while locked.
    if (!license || !license.ok) {
      return (
        <>
          <TitleBar />
          <div className="body-wrapper">
            {license
              ? <LicenseGate status={license} onActivated={l => this.setState({ license: l })} />
              : <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 12, color: 'var(--muted)' }}>Checking license…</div>}
          </div>
        </>
      );
    }

    return (
      <HashRouter>
        <TitleBar />
        {/* Outside the router on purpose: a login code blocks a task no matter which page is open,
            and the one place it must never be is only on the page you happen not to be looking at. */}
        <OtpBanner />
        <RuntimeBanner />
        <div className="body-wrapper">
          <Sidebar taskTypes={license.taskTypes || {}} />
          <div className="page-area">
            <ErrorBoundary>
              <Switch>
                <Route exact path="/dashboard" render={() => <Dashboard email={license.email || ''} />} />
                <Route exact path="/modules" render={() => <Modules taskTypes={license.taskTypes || {}} />} />
                <Route path="/task-groups" component={TaskGroups} />
                <Route path="/target" component={Target} />
                <Route path="/pokemoncenter" render={() => license.taskTypes && license.taskTypes.pokemoncenter
                  ? <PokemonCenter /> : <Redirect to="/modules" />} />
                <Route path="/profiles" component={Profiles} />
                <Route path="/accounts" component={Accounts} />
                <Route path="/proxies" component={Proxies} />
                <Route path="/settings" component={Settings} />
                <Redirect to="/dashboard" />
              </Switch>
            </ErrorBoundary>
          </div>
        </div>
      </HashRouter>
    );
  }
}

export default connect()(PageHandler);
