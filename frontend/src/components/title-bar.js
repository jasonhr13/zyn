import React, { Component } from 'react';
import Icon from './icon';

const { ipcRenderer } = window.require('electron');
let IS_DEV = false;
try { IS_DEV = ipcRenderer.sendSync('getChannel') === 'dev'; } catch {}

const savedNightMode = () => {
  try { return localStorage.getItem('hope-theme') !== 'day'; }
  catch { return true; }
};

class TitleBar extends Component {
  state = { night: savedNightMode() };

  componentDidMount() {
    this.applyTheme(this.state.night);
  }

  applyTheme = (night) => {
    document.body.classList.toggle('theme-night', night);
    localStorage.setItem('hope-theme', night ? 'night' : 'day');
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
            <Icon name="hope" size={18} />
          </span>
          <span className="title-bar-name">Hope</span>
          {IS_DEV && <span className="title-bar-dev">DEV DATA</span>}
        </div>
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
