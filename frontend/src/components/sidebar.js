import React, { Component } from 'react';
import { NavLink, withRouter } from 'react-router-dom';
import { connect } from 'react-redux';
const { ipcRenderer } = window.require('electron');

// Read from the packaged app's own version so it can never drift out of sync with the build
// (it was hardcoded to "v1.0" through six releases).
let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('getAppVersion') || ''; } catch {}

// The two store modules use colour emoji — ionicons has no glyph for a dragon or a playing card,
// and the mono icon font renders black-and-white anyway. Route paths stay as-is
// (/tasks is internal); only the label changed.
const NAV_ITEMS = [
  { to: '/pbandai',  emoji: '🃏',             label: 'Bandai' },
  { to: '/target',   emoji: '🎯',             label: 'Target' },
  { to: '/walmart',  emoji: '🛒',             label: 'Walmart', hidden: true },
  { to: '/tasks',    emoji: '🐉',             label: 'Secret Lair' },
  { to: '/round1',   emoji: '🎯',             label: 'Round1' },
  { to: '/generate', emoji: '⚙️',             label: 'Generate' },
  // Walmart, Riot Games + Pokémon Center are hidden from the sidebar (routes still exist). Set
  // hidden:false to bring any of them back.
  { to: '/riotgames', emoji: '🎮',            label: 'Riot Games', hidden: true },
  { to: '/pokemoncenter', emoji: '🎫',        label: 'Pokémon Center', hidden: true },
  { to: '/profiles', icon: 'ion-md-person',   label: 'Profiles' },
  { to: '/accounts', icon: 'ion-md-key',      label: 'Accounts' },
  { to: '/proxies',  icon: 'ion-md-globe',    label: 'Proxies'  },
  { to: '/settings', icon: 'ion-md-settings', label: 'Settings' },
];

class Sidebar extends Component {
  // Stops monitors, then quits and installs — the update is already downloaded by this point.
  install = () => { try { ipcRenderer.send('installUpdate'); } catch {} };

  renderUpdate() {
    const u = this.props.update;   // from redux (page-handler owns the listener)
    if (!u || u.state === 'current' || u.state === 'error' || u.state === 'checking') return null;
    if (u.state === 'downloading') {
      return <div className="sidebar-version" style={{ color: '#38bdf8' }}>↓ update {u.percent || 0}%</div>;
    }
    if (u.state === 'ready') {
      return (
        <button
          className="btn btn-sm"
          onClick={this.install}
          title={`v${u.version} downloaded — restart to apply`}
          style={{ background: '#34d399', color: '#0b0d10', fontWeight: 700, width: '100%', marginBottom: 6 }}
        >
          ⟳ Update to v{u.version}
        </button>
      );
    }
    return null;
  }

  render() {
    return (
      <div className="sidebar">
        <nav className="sidebar-nav">
          {NAV_ITEMS.filter(item => !item.hidden && (!item.devOnly || this.props.channel === 'dev')).map(({ to, icon, emoji, label, disabled }) => {
            // An item is either an icon-font glyph or a colour emoji (no glyph exists for some, e.g. a
            // bowling pin), so render whichever it declares.
            const glyph = emoji
              ? <span style={{ fontSize: 15, lineHeight: 1, width: 16, textAlign: 'center' }}>{emoji}</span>
              : <i className={icon} />;
            return disabled ? (
              <div
                key={to}
                className="sidebar-link"
                title={`${label} (disabled)`}
                style={{ opacity: 0.3, cursor: 'not-allowed', pointerEvents: 'none' }}
              >
                {glyph}
                <span className="sidebar-label">{label}</span>
              </div>
            ) : (
              <NavLink key={to} to={to} className="sidebar-link" activeClassName="active" title={label}>
                {glyph}
                <span className="sidebar-label">{label}</span>
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          {this.renderUpdate()}
          <div className="sidebar-version">{APP_VERSION ? `v${APP_VERSION}` : ''}</div>
        </div>
      </div>
    );
  }
}

export default withRouter(connect(s => ({ update: s.update, channel: s.channel }))(Sidebar));
