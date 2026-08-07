import React, { Component } from 'react';
import { HashRouter, Route, Switch, Redirect } from 'react-router-dom';
import { connect } from 'react-redux';
import TitleBar from './title-bar';
import Sidebar from './sidebar';
import ErrorBoundary from './error-boundary';
import LicenseGate from './license-gate';
import OtpBanner from './otp-banner';
import Modules from './pages/modules';
import Tasks from './pages/tasks';
import Pbandai from './pages/pbandai';
import Round1 from './pages/round1';
import RiotGames from './pages/priotgames';
import PokemonCenter from './pages/pokemoncenter';
import Target from './pages/target';
import Walmart from './pages/walmart';
import Profiles from './pages/profiles';
import Accounts from './pages/accounts';
import Proxies from './pages/proxies';
import Settings from './pages/settings';
import Generate from './pages/generate';
import { pushLinks } from './queue-pass-client';
const { ipcRenderer } = window.require('electron');

class PageHandler extends Component {
  state = { license: null };   // null = still checking

  componentDidMount() {
    // License: check on mount, and accept pushes from main (periodic re-check / revoke).
    ipcRenderer.invoke('licenseStatus').then(license => this.setState({ license })).catch(() => {});
    ipcRenderer.on('licenseStatus', (e, license) => this.setState({ license }));

    // Load initial data
    const tasks = ipcRenderer.sendSync('getTasks');
    const profiles = ipcRenderer.sendSync('getProfiles');
    const accounts = ipcRenderer.sendSync('getAccounts');
    const proxies = ipcRenderer.sendSync('getProxies');
    const settings = ipcRenderer.sendSync('getSettings');
    const discordStatus = ipcRenderer.sendSync('getDiscordStatus');
    let lastOrders = {};
    try { lastOrders = ipcRenderer.sendSync('getLastOrders') || {}; } catch {}
    let channel = 'dev';
    try { channel = ipcRenderer.sendSync('getChannel') || 'dev'; } catch {}
    this.props.dispatch({ type: 'update', obj: { tasks, profiles, accounts, proxies, settings, discordStatus, lastOrders, channel } });

    // Task IPC events
    ipcRenderer.on('taskStarted', (e, { taskId }) => {
      this.props.dispatch({ type: 'taskStarted', taskId });
    });

    ipcRenderer.on('taskStopped', (e, { taskId }) => {
      this.props.dispatch({ type: 'taskStopped', taskId });
    });

    ipcRenderer.on('taskDone', (e, { taskId }) => {
      this.props.dispatch({ type: 'taskDone', taskId });
    });

    ipcRenderer.on('taskThreadStatus', (e, { taskId, threadId, status }) => {
      this.props.dispatch({ type: 'taskThreadStatus', taskId, threadId, status });
    });

    ipcRenderer.on('taskThreadDone', (e, { taskId, threadId, code }) => {
      this.props.dispatch({
        type: 'taskThreadStatus',
        taskId,
        threadId,
        status: code === 0 ? 'done' : 'error',
      });
    });

    ipcRenderer.on('taskLog', (e, { taskId, threadId, line }) => {
      this.props.dispatch({ type: 'taskLog', taskId, threadId, line });
    });

    ipcRenderer.on('discordStatus', (e, data) => {
      this.props.dispatch({ type: 'update', obj: { discordStatus: data } });
    });

    ipcRenderer.on('queuePass', (e, { cartUrl, proxy, sim }) => {
      this.props.dispatch({ type: 'queuePass', cartUrl, proxy, sim });
      // Also contribute it to the shared pool so other users' bots can claim it. Fire-and-forget;
      // the server dedupes on qitq, so every client reporting every link it sees is correct.
      // Simulated replays stay local — pushing rehearsal links would poison the real shared pool.
      if (!sim) pushLinks([{ cartUrl, proxy }]);
    });

    // P-Bandai events are handled HERE, not on the P-Bandai page: that page unmounts on a tab
    // switch, which used to tear down these listeners and silently drop every restock/checkout
    // event that arrived while you were elsewhere.
    ipcRenderer.on('pbandaiLog', (e, { tag, line }) => {
      this.props.dispatch({ type: 'pbandaiLog', tag, line });
    });
    ipcRenderer.on('pbandaiStatus', (e, { instanceId, tag, state, detail }) => {
      this.props.dispatch({ type: 'pbandaiStatus', instanceId, tag, state, detail });
    });
    ipcRenderer.on('pbandaiDone', (e, msg) => {
      this.props.dispatch({ type: 'pbandaiDone', instanceId: msg && msg.instanceId });
    });
    ipcRenderer.on('pbandaiLastOrder', (e, { profileId, ts }) => {
      this.props.dispatch({ type: 'pbandaiLastOrder', profileId, ts });
    });

    ipcRenderer.on('pbandaiRotateDone', () => {
      this.props.dispatch({ type: 'pbandaiSet', obj: { rotate: false } });
    });

    // Same page-unmount reasoning as P-Bandai above — keep listeners here, not on the page.
    ipcRenderer.on('pokemonLog', (e, { line }) => {
      this.props.dispatch({ type: 'pokemonLog', line });
    });
    ipcRenderer.on('pokemonStatus', (e, { state, detail }) => {
      this.props.dispatch({ type: 'pokemonStatus', state, detail });
    });
    ipcRenderer.on('pokemonDone', () => {
      this.props.dispatch({ type: 'pokemonDone' });
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
      this.props.dispatch({ type: 'targetLog', line, lines, taskId });
    });
    ipcRenderer.on('targetStatus', (e, { state, label, color, detail, taskId, taskState, running }) => {
      this.props.dispatch({ type: 'targetStatus', state, label, color, detail, taskId, taskState, running });
    });
    ipcRenderer.on('targetDone', (e, { taskId } = {}) => {
      this.props.dispatch({ type: 'targetDone', taskId });
    });
    // Logins the engine is blocked on. Sent as the WHOLE list every time it changes, so the
    // reducer can just replace it and never has to reconcile adds against removes.
    ipcRenderer.on('targetOtp', (e, { pending } = {}) => {
      this.props.dispatch({ type: 'targetOtp', pending: pending || [] });
    });

    // Walmart checkout engine — same page-unmount reasoning as Target above.
    ipcRenderer.on('walmartLog', (e, { line }) => {
      this.props.dispatch({ type: 'walmartLog', line });
    });
    ipcRenderer.on('walmartStatus', (e, { state, label, color, detail }) => {
      this.props.dispatch({ type: 'walmartStatus', state, label, color, detail });
    });
    ipcRenderer.on('walmartDone', () => {
      this.props.dispatch({ type: 'walmartDone' });
    });

    // Riot Games events — same page-unmount reasoning as above
    ipcRenderer.on('riotgamesLog', (e, { tag, line }) => {
      this.props.dispatch({ type: 'riotgamesLog', tag, line });
    });
    ipcRenderer.on('riotgamesStatus', (e, { instanceId, tag, state, detail }) => {
      this.props.dispatch({ type: 'riotgamesStatus', instanceId, tag, state, detail });
    });
    ipcRenderer.on('riotgamesDone', (e, msg) => {
      this.props.dispatch({ type: 'riotgamesDone', instanceId: msg && msg.instanceId });
    });

    // Update status → redux, so the sidebar badge and the Settings "Check for updates" button
    // read one shared source instead of each keeping their own copy.
    ipcRenderer.on('updateStatus', (e, update) => {
      this.props.dispatch({ type: 'update', obj: { update } });
    });

    // Watchlist is persisted in main; seed it once at startup.
    try {
      const saved = ipcRenderer.sendSync('getWatchlist');
      if (typeof saved === 'string' && saved.length) {
        this.props.dispatch({ type: 'pbandaiSet', obj: { watchlist: saved } });
      }
    } catch {}
  }

  componentWillUnmount() {
    ipcRenderer.removeAllListeners('taskStarted');
    ipcRenderer.removeAllListeners('taskStopped');
    ipcRenderer.removeAllListeners('taskDone');
    ipcRenderer.removeAllListeners('taskThreadStatus');
    ipcRenderer.removeAllListeners('taskThreadDone');
    ipcRenderer.removeAllListeners('taskLog');
    ipcRenderer.removeAllListeners('discordStatus');
    ipcRenderer.removeAllListeners('queuePass');
    ipcRenderer.removeAllListeners('licenseStatus');
    ipcRenderer.removeAllListeners('pbandaiLog');
    ipcRenderer.removeAllListeners('pbandaiStatus');
    ipcRenderer.removeAllListeners('pbandaiDone');
    ipcRenderer.removeAllListeners('pbandaiLastOrder');
    ipcRenderer.removeAllListeners('pbandaiRotateDone');
    ipcRenderer.removeAllListeners('pokemonLog');
    ipcRenderer.removeAllListeners('pokemonStatus');
    ipcRenderer.removeAllListeners('pokemonDone');
    ipcRenderer.removeAllListeners('targetLog');
    ipcRenderer.removeAllListeners('targetStatus');
    ipcRenderer.removeAllListeners('targetDone');
    ipcRenderer.removeAllListeners('targetOtp');
    ipcRenderer.removeAllListeners('walmartLog');
    ipcRenderer.removeAllListeners('walmartStatus');
    ipcRenderer.removeAllListeners('walmartDone');
    ipcRenderer.removeAllListeners('riotgamesLog');
    ipcRenderer.removeAllListeners('riotgamesStatus');
    ipcRenderer.removeAllListeners('riotgamesDone');
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
        <div className="body-wrapper">
          <Sidebar />
          <div className="page-area">
            <ErrorBoundary>
              <Switch>
                <Route path="/modules" component={Modules} />
                <Route path="/tasks" component={Tasks} />
                <Route path="/generate" component={Generate} />
                <Route path="/pbandai" component={Pbandai} />
                <Route path="/round1" component={Round1} />
                <Route path="/riotgames" component={RiotGames} />
                <Route path="/pokemoncenter" component={PokemonCenter} />
                <Route path="/target" component={Target} />
                <Route path="/walmart" component={Walmart} />
                <Route path="/profiles" component={Profiles} />
                <Route path="/accounts" component={Accounts} />
                <Route path="/proxies" component={Proxies} />
                <Route path="/settings" component={Settings} />
                <Redirect from="/" to="/modules" />
              </Switch>
            </ErrorBoundary>
          </div>
        </div>
      </HashRouter>
    );
  }
}

export default connect()(PageHandler);
