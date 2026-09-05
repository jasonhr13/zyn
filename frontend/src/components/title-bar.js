import React, { Component } from 'react';
import Icon from './icon';

const { ipcRenderer } = window.require('electron');
const THEME_KEY = 'zyn-theme';
const PREVIOUS_THEME_KEY = `${String.fromCharCode(104, 111, 112, 101)}-theme`;
let IS_DEV = false;
try { IS_DEV = ipcRenderer.sendSync('getChannel') === 'dev'; } catch {}

const savedNightMode = () => {
  try {
    const current = localStorage.getItem(THEME_KEY);
    const previous = current == null ? localStorage.getItem(PREVIOUS_THEME_KEY) : null;
    if (current == null && previous != null) {
      localStorage.setItem(THEME_KEY, previous);
      localStorage.removeItem(PREVIOUS_THEME_KEY);
    }
    return (current == null ? previous : current) !== 'day';
  }
  catch { return true; }
};

class TitleBar extends Component {
  state = { night: savedNightMode() };

  componentDidMount() {
    this.applyTheme(this.state.night);
  }

  applyTheme = (night) => {
    document.body.classList.toggle('theme-night', night);
    localStorage.setItem(THEME_KEY, night ? 'night' : 'day');
    this.setState({ night });
  };

  toggleTheme = () => this.applyTheme(!this.state.night);

  minimize = () => ipcRenderer.send('minimize');
  maximize = () => ipcRenderer.send('maximize');
  close = () => ipcRenderer.send('close');

  render() {
    const { night } = this.state;
    return (
      <div className="title-bar">
        <div className="title-bar-left">
          <span className="title-bar-mark" aria-hidden="true">
            <img className="title-bar-logo" src={`${process.env.PUBLIC_URL}/zyn-icon.png`} alt="" />
          </span>
          <span className="title-bar-name" aria-label="ZynAIO">Zyn<span className="aio-mark">AIO</span></span>
          {IS_DEV && <span className="title-bar-dev">DEV DATA</span>}
        </div>
        <div className="title-bar-caption" aria-hidden="true">Personal workspace</div>
        <div className="title-bar-controls">
          <button
            type="button"
            className="theme-toggle"
            onClick={this.toggleTheme}
            title={night ? 'Switch to day' : 'Switch to night'}
            aria-label={night ? 'Switch to day theme' : 'Switch to night theme'}
          >
            <Icon name={night ? 'sun' : 'moon'} size={15} />
          </button>
          <button type="button" className="win-btn" onClick={this.minimize} title="Minimize" aria-label="Minimize">
            <Icon name="minus" size={15} />
          </button>
          <button type="button" className="win-btn" onClick={this.maximize} title="Maximize" aria-label="Maximize">
            <Icon name="maximize" size={13} />
          </button>
          <button type="button" className="win-btn win-btn-close" onClick={this.close} title="Close" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
    );
  }
}

export default TitleBar;
