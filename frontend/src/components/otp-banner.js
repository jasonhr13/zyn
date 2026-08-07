import React, { Component } from 'react';
import { connect } from 'react-redux';
const { ipcRenderer } = window.require('electron');

// The login-code prompt, pinned to the top of the app on EVERY page.
//
// It used to live inside the Target page only, part way down the normal document flow. Two ways that
// lost people: if you were on Tasks or Profiles when a code was needed you never saw it at all, and
// even on Target it read as just another panel. A Target code expires in minutes, and a task blocked
// on one is a task doing nothing, so this is worth interrupting for.
//
// Sits above modals deliberately (z 1200 vs 1000). Being told "type this code now" is more urgent
// than whatever dialog happens to be open, and it is a slim bar rather than an overlay.
//
// It also announces its own exit. The mailbox poll runs in parallel and clears the row the moment a
// code arrives, so the prompt would simply vanish mid-typing and leave people wondering whether they
// had missed it. Now it says the code arrived, then goes.
class OtpBanner extends Component {
  state = { draft: {}, resolved: [], now: Date.now() };

  componentDidMount() {
    // Drives the "waiting Ns" counter; 1s is enough for a number nobody reads precisely.
    this.timer = setInterval(() => this.setState({ now: Date.now() }), 1000);
  }

  componentWillUnmount() {
    clearInterval(this.timer);
    (this.clears || []).forEach(clearTimeout);
  }

  componentDidUpdate(prev) {
    const before = prev.otpPending || [];
    const after = this.props.otpPending || [];
    const gone = before.filter(p => !after.some(q => q.email === p.email));
    if (!gone.length) return;
    this.clears = this.clears || [];
    for (const p of gone) {
      // Only worth announcing if we did NOT just submit it by hand — in that case the user already
      // knows, and a confirmation they caused themselves is noise.
      if (this.submitted && this.submitted[p.email]) { delete this.submitted[p.email]; continue; }
      this.setState(s => ({ resolved: [...s.resolved.filter(r => r.email !== p.email), { email: p.email, at: Date.now() }] }));
      this.clears.push(setTimeout(() => {
        this.setState(s => ({ resolved: s.resolved.filter(r => r.email !== p.email) }));
      }, 6000));
    }
  }

  submit = (email) => {
    const code = (this.state.draft[email] || '').trim();
    if (!code) return;
    this.submitted = this.submitted || {};
    this.submitted[email] = true;
    try { ipcRenderer.sendSync('targetSubmitOtp', { email, code }); } catch {}
    const next = { ...this.state.draft };
    delete next[email];
    this.setState({ draft: next });
  };

  render() {
    const pending = this.props.otpPending || [];
    const { draft, resolved, now } = this.state;
    if (!pending.length && !resolved.length) return null;

    return (
      <div style={{
        position: 'fixed', top: 38, left: 0, right: 0, zIndex: 1200,
        display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none',
      }}>
        {pending.length > 0 && (
          <div className="otp-banner" style={{
            pointerEvents: 'auto',
            width: 'min(760px, calc(100% - 28px))',
            marginTop: 10, borderRadius: 10, overflow: 'hidden',
            border: '2px solid #f5a623', background: 'var(--modal-bg)',
            backdropFilter: 'var(--blur)', WebkitBackdropFilter: 'var(--blur)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: 'rgba(245,166,35,0.16)',
              borderBottom: '1px solid rgba(245,166,35,0.35)',
            }}>
              <span style={{ fontSize: 15 }} role="img" aria-label="key">🔑</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#f5a623', letterSpacing: 0.3 }}>
                Login code needed{pending.length > 1 ? ` — ${pending.length} accounts` : ''}
              </span>
            </div>

            {pending.map((p, i) => (
              <div key={p.email} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                borderTop: i ? '1px solid var(--panel-border)' : 'none',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.email}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                    Target emailed a 6-digit code · waiting {Math.max(0, Math.round((now - p.since) / 1000))}s
                    {p.waiting > 1 && (
                      // Several tasks share this account and each needs its own code, so the prompt
                      // stays up after the first one is entered. Saying so stops it looking stuck.
                      <span style={{ color: '#f5a623' }}> · {p.waiting} tasks on this account</span>
                    )}
                  </div>
                </div>
                <input
                  className="form-input"
                  autoFocus={i === 0}
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="123456"
                  value={draft[p.email] || ''}
                  onChange={e => this.setState({ draft: { ...draft, [p.email]: e.target.value.replace(/\D/g, '') } })}
                  onKeyDown={e => { if (e.key === 'Enter') this.submit(p.email); }}
                  style={{ width: 118, fontFamily: 'monospace', fontSize: 15, letterSpacing: 2, textAlign: 'center' }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => this.submit(p.email)}
                  disabled={!(draft[p.email] || '').trim()}
                >
                  Submit
                </button>
              </div>
            ))}
          </div>
        )}

        {resolved.map(r => (
          <div key={r.email} style={{
            pointerEvents: 'auto', marginTop: 8, borderRadius: 8,
            padding: '6px 14px', fontSize: 11.5,
            border: '1px solid rgba(52,199,89,0.5)', background: 'var(--modal-bg)',
            backdropFilter: 'var(--blur)', WebkitBackdropFilter: 'var(--blur)',
            color: '#34c759', maxWidth: 'min(760px, calc(100% - 28px))',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            ✓ code arrived from the mailbox for {r.email} — no typing needed
          </div>
        ))}
      </div>
    );
  }
}

export default connect(s => ({ otpPending: (s.target && s.target.otpPending) || [] }))(OtpBanner);
