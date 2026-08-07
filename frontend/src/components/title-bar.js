import React, { Component } from 'react';
const { ipcRenderer } = window.require('electron');

class TitleBar extends Component {
  state = { night: false };

  componentDidMount() {
    // Default to day (A). Only go night if explicitly saved.
    this.applyTheme(localStorage.getItem('hope-theme') === 'night');
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
          <span className="title-bar-name">Hope</span>
        </div>
        <div className="title-bar-controls">
          <button
            className="theme-toggle"
            onClick={this.toggleTheme}
            title={night ? 'Switch to day' : 'Switch to night'}
          >
            <i className={night ? 'ion-md-sunny' : 'ion-md-moon'} />
          </button>
          <button className="win-btn" onClick={this.minimize} title="Minimize">
            <i className="ion-md-remove" />
          </button>
          <button className="win-btn" onClick={this.maximize} title="Maximize">
            <span className="win-box" />
          </button>
          <button className="win-btn win-btn-close" onClick={this.close} title="Close">
            <i className="ion-md-close" />
          </button>
        </div>
      </div>
    );
  }
}

export default TitleBar;
