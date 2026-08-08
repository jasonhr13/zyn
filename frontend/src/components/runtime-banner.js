import React from 'react';
import { connect } from 'react-redux';
import Icon from './icon';

const { ipcRenderer } = window.require('electron');

function runtimePhase(runtime, failed) {
  const items = Object.values(runtime.items || {});
  if (failed || items.some(item => item.state === 'blocked' || item.state === 'error')) {
    return { state: 'error', status: 'Needs attention' };
  }
  if (runtime.state === 'installing' || items.some(item => item.state === 'installing')) {
    return { state: 'installing', status: 'Installing' };
  }
  if (runtime.state === 'downloading' || items.some(item => item.state === 'downloading')) {
    return { state: 'downloading', status: `${runtime.percent || 0}%` };
  }
  return { state: 'pending', status: 'Checking' };
}

function runtimeMessage(runtime, failed) {
  if (failed) {
    if (/rosetta/i.test(String(runtime.error || runtime.message || ''))) {
      return 'The checkout engine requires Rosetta 2. Install Rosetta, then click Retry.';
    }
    return 'Runtime setup could not finish. Check your connection, then click Retry.';
  }
  if (runtime.state === 'installing') return 'Installing the verified runtime in the background.';
  if (runtime.state === 'downloading') return 'Downloading the verified runtime in the background.';
  if (runtime.state === 'idle') return 'The runtime will download after sign-in.';
  return 'Checking the required runtime files.';
}

function RuntimeBanner({ runtime }) {
  if (!runtime || !runtime.enabled || runtime.ready) return null;
  const failed = runtime.state === 'error';
  const phase = runtimePhase(runtime, failed);

  return (
    <section className={`runtime-banner${failed ? ' runtime-banner-error' : ''}`} aria-live="polite">
      <div className="runtime-banner-icon">
        <Icon name={failed ? 'warning' : 'download'} size={16} />
      </div>
      <div className="runtime-banner-copy">
        <div className="runtime-banner-title">
          {failed ? 'Runtime setup paused' : 'Finishing Zyn setup'}
          <span>{runtime.percent || 0}%</span>
        </div>
        <div className="runtime-banner-subtitle">
          {runtimeMessage(runtime, failed)}
          {!failed && ' You can keep setting up accounts and profiles while this finishes.'}
        </div>
        <div className="runtime-overall-track">
          <span style={{ width: `${runtime.percent || 0}%` }} />
        </div>
      </div>
      <div className="runtime-items">
        <div className="runtime-item">
          <span className={`runtime-item-dot runtime-item-${phase.state}`} />
          <span className="runtime-item-name">Runtime</span>
          <span className="runtime-item-progress">{phase.status}</span>
        </div>
      </div>
      {failed && (
        <button
          className="btn btn-sm runtime-retry"
          onClick={() => ipcRenderer.invoke('retryRuntimeSetup').catch(() => {})}
        >
          Retry
        </button>
      )}
    </section>
  );
}

export default connect(state => ({ runtime: state.runtime }))(RuntimeBanner);
