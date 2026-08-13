import React, { Component } from 'react';
import { validTargetOtp } from './target-otp';

export { targetOtpForTask, validTargetOtp } from './target-otp';

const { ipcRenderer } = window.require('electron');

export default class TargetOtpInput extends Component {
  state = { code: '' };

  componentDidUpdate(previous) {
    if (previous.request && this.props.request
      && (previous.request.email !== this.props.request.email
        || previous.request.since !== this.props.request.since)) {
      this.setState({ code: '' });
    }
  }

  submit = event => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const { request } = this.props;
    const code = this.state.code.trim();
    if (!request || !validTargetOtp(code)) return;
    try {
      const accepted = ipcRenderer.sendSync('targetSubmitOtp', { email: request.email, code });
      if (accepted) this.setState({ code: '' });
    } catch {}
  };

  render() {
    const { request, large = false } = this.props;
    if (!request) return null;
    const code = this.state.code;
    return (
      <form
        className={`target-otp-inline${large ? ' target-otp-inline-large' : ''}`}
        title={`Enter the Target login code for ${request.email}`}
        aria-label={`Login code needed for ${request.email}`}
        onSubmit={this.submit}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
      >
        <span className="target-otp-inline-key" aria-hidden="true">OTP</span>
        <input
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          aria-label={`Code for ${request.email}`}
          onChange={event => this.setState({ code: event.target.value.replace(/\D/g, '').slice(0, 6) })}
        />
        <button type="submit" disabled={!validTargetOtp(code)} title="Submit login code" aria-label="Submit login code">→</button>
      </form>
    );
  }
}
