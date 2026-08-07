import React, { Component } from 'react';
import { NavLink, withRouter } from 'react-router-dom';
import { connect } from 'react-redux';
import Icon from './icon';

const { ipcRenderer } = window.require('electron');

let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('getAppVersion') || ''; } catch {}

const MODULE_ROUTES = ['/modules', '/task-groups', '/pbandai', '/target', '/tasks', '/round1', '/riotgames', '/pokemoncenter', '/walmart'];
const NAV_ITEMS = [
  { to: '/modules', icon: 'layers', label: 'Tasks', section: null, modules: true },
  { to: '/profiles', icon: 'user', label: 'Profiles', section: 'Workspace' },
  { to: '/accounts', icon: 'key', label: 'Accounts', section: 'Workspace' },
  { to: '/proxies', icon: 'network', label: 'Proxies', section: 'Workspace' },
  { to: '/generate', icon: 'wand', label: 'Generate', section: 'Workspace' },
  { to: '/settings', icon: 'settings', label: 'Settings', section: 'Workspace' },
];

class Sidebar extends Component {
  install = () => { try { ipcRenderer.send('installUpdate'); } catch {} };

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
          style={{ background: 'var(--ok)', color: 'var(--accent-on)', fontWeight: 700, width: '100%', marginBottom: 6 }}
        >
          <Icon name="refresh" size={13} /> Update to v{update.version}
        </button>
      );
    }
    return null;
  }

  render() {
    let lastSection = null;
    return (
      <div className="sidebar">
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map(({ to, icon, label, section, modules }) => {
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
                  isActive={modules
                    ? (_match, location) => MODULE_ROUTES.some(route => location.pathname === route || location.pathname.startsWith(`${route}/`))
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
          <div className="sidebar-version">{APP_VERSION ? `v${APP_VERSION} · control plane R3` : 'control plane R3'}</div>
        </div>
      </div>
    );
  }
}

export default withRouter(connect(state => ({ update: state.update }))(Sidebar));
