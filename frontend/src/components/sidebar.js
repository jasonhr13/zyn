import React, { Component } from 'react';
import { NavLink } from 'react-router-dom';
import { connect } from 'react-redux';
import Icon from './icon';

const { ipcRenderer } = window.require('electron');

let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('getAppVersion') || ''; } catch {}

function readEngineInfo() {
  try { return ipcRenderer.sendSync('getEngineInfo') || null; } catch { return null; }
}

const NAV_ITEMS = [
  { to: '/dashboard', icon: 'activity', label: 'Dashboard', section: 'Overview' },
  { to: '/task-groups', icon: 'target', label: 'Target', section: 'Tasks', activeRoutes: ['/task-groups', '/target'] },
  { to: '/pokemoncenter', icon: 'ticket', label: 'Pokémon Center', section: 'Tasks', taskType: 'pokemoncenter' },
  { to: '/walmart', icon: 'cart', label: 'Walmart', section: 'Tasks', taskType: 'walmart' },
  { to: '/profiles', icon: 'user', label: 'Profiles', section: 'Workspace' },
  { to: '/accounts', icon: 'key', label: 'Accounts', section: 'Workspace' },
  { to: '/proxies', icon: 'network', label: 'Proxies', section: 'Workspace' },
  { to: '/settings', icon: 'settings', label: 'Settings', section: 'Workspace' },
];

class Sidebar extends Component {
  state = { engine: readEngineInfo() };

  componentDidUpdate(prevProps) {
    if (prevProps.runtime !== this.props.runtime) {
      this.setState({ engine: readEngineInfo() });
    }
  }

  install = () => { try { ipcRenderer.send('installUpdate'); } catch {} };

  renderEngineVersion() {
    const engine = this.state.engine || (this.props.runtime && this.props.runtime.engine);
    const running = engine && engine.running;
    const installed = engine && engine.installed;
    if (!running && !installed) return <div>Engine —</div>;
    if (engine && engine.pendingRestart && installed && running !== installed) {
      return (
        <div className="sidebar-engine-pending" title="Stop tasks or restart Zyn to use the downloaded engine">
          Engine v{running} → v{installed}
        </div>
      );
    }
    return <div>Engine v{running || installed}</div>;
  }

  renderUpdate() {
    const update = this.props.update;
    if (!update || ['current', 'error', 'checking'].includes(update.state)) return null;
    if (update.state === 'downloading') {
      return <div className="sidebar-version" style={{ color: 'var(--info)' }}>↓ update {update.percent || 0}%</div>;
    }
    if (update.state === 'ready') {
      return (
        <button
          type="button"
          className="btn btn-sm"
          onClick={this.install}
          title={`v${update.version} downloaded — restart to apply`}
          style={{ background: 'var(--ok)', color: '#000', fontWeight: 700, width: '100%', marginBottom: 6 }}
        >
          <Icon name="refresh" size={13} /> Update to v{update.version}
        </button>
      );
    }
    return null;
  }

  render() {
    let lastSection = null;
    const taskTypes = this.props.taskTypes || {};
    const navItems = NAV_ITEMS.filter(item => !item.taskType || taskTypes[item.taskType] === true);
    return (
      <div className="sidebar">
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {navItems.map(({ to, icon, label, section, activeRoutes }) => {
            const heading = section && section !== lastSection
              ? <div className="sidebar-section-label">{section}</div>
              : null;
            lastSection = section;
            return (
              <React.Fragment key={to}>
                {heading}
                <NavLink
                  to={to}
                  exact
                  className="sidebar-link"
                  activeClassName="active"
                  isActive={activeRoutes
                    ? (_match, location) => activeRoutes.some(route => location.pathname === route || location.pathname.startsWith(`${route}/`))
                    : undefined}
                  title={label}
                >
                  <span className="sidebar-icon"><Icon name={icon} size={17} /></span>
                  <span className="sidebar-label">{label}</span>
                </NavLink>
              </React.Fragment>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          {this.renderUpdate()}
          <div className="sidebar-account" title={this.props.email || 'Your account'}>
            <span className="sidebar-avatar">{(this.props.email || 'Z').slice(0, 1).toUpperCase()}</span>
            <span><strong>{(this.props.email || 'Your account').split('@')[0]}</strong><small>Signed in</small></span>
          </div>
          <div className="sidebar-version">
            <div>{APP_VERSION ? `App v${APP_VERSION}` : 'Zyn'}</div>
            {this.renderEngineVersion()}
          </div>
        </div>
      </div>
    );
  }
}

export default connect(state => ({ update: state.update, runtime: state.runtime }))(Sidebar);
