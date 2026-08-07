import React, { Component } from 'react';
import { connect } from 'react-redux';
const { ipcRenderer } = window.require('electron');

// The packaged app's real version — the same value electron-updater compares against.
let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('getAppVersion') || ''; } catch {}

// IMAP host presets — same list the Generate tab uses. All standard IMAPS hosts run on port 993.
const IMAP_PROVIDERS = [
  { value: 'imap.gmail.com', label: 'Gmail' },
  { value: 'outlook.office365.com', label: 'Outlook / Hotmail' },
  { value: 'imap.mail.yahoo.com', label: 'Yahoo' },
  { value: 'imap.mail.me.com', label: 'iCloud' },
];
const IMAP_HOSTS = IMAP_PROVIDERS.map(p => p.value);

class Settings extends Component {
  constructor(props) {
    super(props);
    this.state = {
      discordWebhook: '', lucaApiKey: '', hyperApiKey: '',
      // IMAP: a provider dropdown, port fixed at 993, and per-host credentials so each mailbox keeps
      // its own user/pass (switching Gmail↔iCloud shows that host's own login).
      imapSel: 'imap.gmail.com', imapHostCustom: '', imapUser: '', imapPass: '', imapByHost: {}, showImapPass: false,
      aycdApiKey: '', showAycdKey: false,
      // Target: the engine has always read these five, but no control ever shipped for them, so the
      // harvest ran on hardcoded defaults with no way to change it short of a rebuild.
      targetAtcHarvestTcins: '', targetCookieBank: '', targetHarvestWorkers: '', targetCookieTtlSec: '',
      targetVerboseLogs: false, shapeMethod: 'In Bot',
      // Auto Buy: who runs when a BUY NOW button on a monitor embed is clicked.
      autoBuyGroup: '', autoBuyMax: '5', autoBuyConnection: 'inhouse1',
      saved: false, ioMsg: '', ioColor: 'var(--muted)', importReplace: false,
    };
  }

  syncFromProps(s) {
    // Fall back to the Generate tab's email-auth-code config so an existing setup is pre-filled here
    // (and picked up by the Target OTP login). Saving migrates it to the top-level settings.
    const g = s.generate || {};
    const by = { ...(s.imapByHost || {}) };
    // Migrate the flat top-level / Generate-tab config into the per-host map on first load.
    const flatHost = s.imapHost || g.imapHostCustom || g.imapHost || '';
    const flatUser = s.imapUser || g.imapUser || '';
    const flatPass = s.imapPass || g.imapPass || '';
    const isPreset = IMAP_HOSTS.includes(flatHost);
    const sel = flatHost ? (isPreset ? flatHost : 'custom') : 'imap.gmail.com';
    if (flatHost && flatUser && !by[sel]) by[sel] = { user: flatUser, pass: flatPass };
    const cur = by[sel] || {};
    this.setState({
      discordWebhook: s.discordWebhook || '', lucaApiKey: s.lucaApiKey || '', hyperApiKey: s.hyperApiKey || '',
      imapSel: sel, imapHostCustom: isPreset ? '' : (flatHost || ''),
      imapUser: cur.user || flatUser || '', imapPass: cur.pass || flatPass || '',
      imapByHost: by, showImapPass: false,
      aycdApiKey: s.aycdApiKey || g.aycdApiKey || '',
      // Blank means "use the engine default" — the placeholders show what that default is, so an empty
      // box is never ambiguous. targetAtcHarvestTcin (singular) is the legacy key for the same setting.
      targetAtcHarvestTcins: s.targetAtcHarvestTcins || s.targetAtcHarvestTcin || '',
      targetCookieBank: s.targetCookieBank == null ? '' : String(s.targetCookieBank),
      targetHarvestWorkers: s.targetHarvestWorkers == null ? '' : String(s.targetHarvestWorkers),
      targetCookieTtlSec: s.targetCookieTtlSec == null ? '' : String(s.targetCookieTtlSec),
      targetVerboseLogs: !!s.targetVerboseLogs,
      shapeMethod: /^harvester$/i.test((s.shapeMethod || '').trim()) ? 'Harvester' : 'In Bot',
      autoBuyGroup: (s.autoBuy && s.autoBuy.group) || '',
      autoBuyMax: String((s.autoBuy && s.autoBuy.max) || 5),
      autoBuyConnection: (s.autoBuy && s.autoBuy.connection) || 'inhouse1',
    });
  }

  // Stash the current host's creds, switch, and load the target host's own saved creds.
  changeImapHost = (sel) => this.setState(prev => {
    const by = { ...prev.imapByHost, [prev.imapSel]: { user: prev.imapUser, pass: prev.imapPass } };
    const next = by[sel] || {};
    return { imapSel: sel, imapByHost: by, imapUser: next.user || '', imapPass: next.pass || '', saved: false };
  });
  componentDidMount() { this.syncFromProps(this.props.settings || {}); }
  componentDidUpdate(prev) {
    if (prev.settings !== this.props.settings) this.syncFromProps(this.props.settings || {});
  }

  set = (field, value) => this.setState({ [field]: value, saved: false });

  // Reveal/hide the operator sections. Writes straight through to settings rather than living in
  // component state: this page is unmounted on every tab switch, so component state would forget the
  // moment you navigated away — and the sections must stay open while you actually use them.
  _taps = 0;
  _tapTimer = null;
  bumpOperatorTaps = () => {
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => { this._taps = 0; }, 1200);   // taps must be deliberate, not spread over a minute
    if (++this._taps < 5) return;
    this._taps = 0;
    const next = { ...(this.props.settings || {}), operatorMode: !(this.props.settings || {}).operatorMode };
    try { ipcRenderer.sendSync('saveSettings', next); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings: next } });
  };

  save = () => {
    // Preserve any other stored settings; this screen manages the webhook + antibot solver keys.
    const sel = this.state.imapSel;
    const by = { ...this.state.imapByHost, [sel]: { user: this.state.imapUser.trim(), pass: this.state.imapPass } };
    const effHost = sel === 'custom' ? this.state.imapHostCustom.trim() : sel;
    const settings = {
      ...(this.props.settings || {}),
      discordWebhook: this.state.discordWebhook,
      lucaApiKey: this.state.lucaApiKey.trim(),
      hyperApiKey: this.state.hyperApiKey.trim(),
      imapByHost: by,
      imapHost: effHost,     // active mailbox — Target/Walmart OTP read this
      imapPort: 993,         // every provider here uses 993; never editable
      imapUser: this.state.imapUser.trim(),   // flat active creds, for engine compatibility
      imapPass: this.state.imapPass,
      aycdApiKey: this.state.aycdApiKey.trim(),
      autoBuy: {
        group: this.state.autoBuyGroup,
        // Clamped here AND in main: a hand-edited settings.json is the other way this number
        // arrives, and 500 browsers from one click is not a mistake worth allowing twice.
        max: Math.max(1, Math.min(50, parseInt(this.state.autoBuyMax, 10) || 5)),
        connection: this.state.autoBuyConnection,
      },
      // Normalise the TCIN list to bare comma-separated numbers: the farmer accepts full product URLs
      // too, so a pasted Target link survives, but stray spaces/newlines from a paste would otherwise
      // reach --atcTcins verbatim and break the argument.
      targetAtcHarvestTcins: this.state.targetAtcHarvestTcins.split(/[\s,]+/).filter(Boolean).join(','),
      // Empty stays empty so the engine keeps falling back to its own default rather than to 0.
      targetCookieBank: this.state.targetCookieBank.trim(),
      targetHarvestWorkers: this.state.targetHarvestWorkers.trim(),
      targetCookieTtlSec: this.state.targetCookieTtlSec.trim(),
      targetVerboseLogs: !!this.state.targetVerboseLogs,
      shapeMethod: this.state.shapeMethod,
    };
    ipcRenderer.sendSync('saveSettings', settings);
    this.props.dispatch({ type: 'update', obj: { settings } });
    this.setState({ saved: true });
    setTimeout(() => this.setState({ saved: false }), 2000);
  };

  checkUpdates = () => { try { ipcRenderer.send('checkForUpdates'); } catch {} };
  installUpdate = () => { try { ipcRenderer.send('installUpdate'); } catch {} };

  exportData = async () => {
    if (!window.confirm(
      'The exported file will contain your CARD DETAILS, SITE PASSWORDS, and DISCORD TOKEN in plain text.\n\n' +
      'Anyone who opens the file can read them. Only save it somewhere you trust. Continue?'
    )) return;
    try {
      const r = await ipcRenderer.invoke('exportSettings');
      if (!r || r.canceled) return;
      this.setState(r.ok
        ? { ioMsg: `✓ Exported to ${r.filePath}`, ioColor: '#4ade80' }
        : { ioMsg: `Export failed: ${r.error || 'unknown error'}`, ioColor: '#f87171' });
    } catch (e) { this.setState({ ioMsg: `Export failed: ${e.message}`, ioColor: '#f87171' }); }
  };

  importData = async () => {
    const replace = this.state.importReplace;
    if (!window.confirm(replace
      ? 'REPLACE mode overwrites your current profiles, accounts, proxies and settings with the file. Continue?'
      : 'Import MERGES the file into your current data — nothing is deleted, only new items are added. Continue?'
    )) return;
    try {
      const r = await ipcRenderer.invoke('importSettings', replace ? 'replace' : 'merge');
      if (!r || r.canceled) return;
      if (!r.ok) { this.setState({ ioMsg: `Import failed: ${r.error || 'unknown error'}`, ioColor: '#f87171' }); return; }
      const s = r.summary || {};
      const n = (o) => o ? (o.added ?? o.set ?? ((o.added || 0) + (o.updated || 0)) ?? o.keys) : 0;
      const parts = [];
      if (s.profiles) parts.push(`${n(s.profiles)} profiles`);
      if (s.accounts) parts.push(`${n(s.accounts)} accounts`);
      if (s.proxies)  parts.push(`${(s.proxies.added || 0) + (s.proxies.updated || 0) || s.proxies.set || 0} proxy lists`);
      if (s.settings) parts.push('settings');
      this.setState({ ioMsg: `✓ Imported: ${parts.join(', ') || 'nothing new'}. Reloading…`, ioColor: '#4ade80' });
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) { this.setState({ ioMsg: `Import failed: ${e.message}`, ioColor: '#f87171' }); }
  };

  // Plain-language status. "Nothing happened" is what makes people think updating is broken, so
  // every state says something — including "you're on the latest version".
  updateLine() {
    const u = this.props.update;
    if (!u) return { text: `You're on v${APP_VERSION}. Click Check for Updates to look for a newer one.`, color: 'var(--muted)' };
    switch (u.state) {
      case 'checking':    return { text: 'Checking…', color: '#38bdf8' };
      case 'current':     return { text: `✓ You're on the latest version (v${APP_VERSION}).`, color: '#4ade80' };
      case 'downloading': return { text: `Downloading v${u.version || ''} — ${u.percent || 0}%…`, color: '#38bdf8' };
      case 'ready':       return { text: `v${u.version} is ready — click Restart & Update.`, color: '#4ade80' };
      case 'error':       return { text: `Couldn't check: ${u.message || 'unknown error'}`, color: '#f87171' };
      default:            return { text: '', color: 'var(--muted)' };
    }
  }

  render() {
    const { discordWebhook, lucaApiKey, hyperApiKey, imapSel, imapHostCustom, imapUser, imapPass, showImapPass, aycdApiKey, showAycdKey, saved,
      targetAtcHarvestTcins, targetCookieBank, targetHarvestWorkers, targetCookieTtlSec,
      targetVerboseLogs, shapeMethod, autoBuyGroup, autoBuyMax, autoBuyConnection } = this.state;

    // Groups come from the profiles themselves, so the list can never drift from what exists.
    const allProfiles = this.props.profiles || [];
    const profileGroups = [...new Set(allProfiles.flatMap(p => p.groups || []))].sort((a, b) => a.localeCompare(b));
    const matchingProfiles = autoBuyGroup
      ? allProfiles.filter(p => (p.groups || []).includes(autoBuyGroup)).length
      : allProfiles.length;
    const autoBuyCap = Math.max(1, Math.min(50, parseInt(autoBuyMax, 10) || 5));
    const proxyLists = ((this.props.proxies || {}).lists) || [];
    // From props, not state: syncFromProps only runs when props change, so a freshly-toggled value
    // would not reach a state copy until the next settings update.
    const operatorMode = !!(this.props.settings || {}).operatorMode;
    const u = this.props.update;
    const line = this.updateLine();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          {/* Five clicks on the title toggles the operator sections. A gesture rather than a visible
              switch: a visible one is an invitation, and the point is that a tester never wonders
              what is behind it. Persisted, so it survives a restart once you have opened it. */}
          <div className="page-title" onClick={this.bumpOperatorTaps} style={{ cursor: 'default', userSelect: 'none' }}>
            <span className="page-title-dot" /> Settings
            {operatorMode && <span style={{ fontSize: 11, color: '#e0b050', marginLeft: 10, fontWeight: 400 }}>operator</span>}
          </div>
          <div className="page-actions">
            <button className={`btn btn-sm ${saved ? 'btn-success' : 'btn-primary'}`} onClick={this.save}>
              {saved ? '✓ Saved' : 'Save Settings'}
            </button>
          </div>
        </div>

        <div className="page-content">
          <div className="settings-section">
            <div className="settings-section-title">Updates</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={this.checkUpdates}
                disabled={u && (u.state === 'checking' || u.state === 'downloading')}
              >
                <i className="ion-md-refresh" style={{ fontSize: 12 }} />{' '}
                {u && u.state === 'checking' ? 'Checking…' : 'Check for Updates'}
              </button>
              {u && u.state === 'ready' && (
                <button
                  className="btn btn-sm"
                  onClick={this.installUpdate}
                  style={{ background: '#34d399', color: '#0b0d10', fontWeight: 700 }}
                >
                  ⟳ Restart &amp; Update to v{u.version}
                </button>
              )}
              <span style={{ fontSize: 11, color: line.color }}>{line.text}</span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Discord</div>
            <div className="form-group">
              <label className="form-label">Success Webhook URL (optional)</label>
              <input
                className="form-input monospace"
                placeholder="https://discord.com/api/webhooks/..."
                value={discordWebhook}
                onChange={e => this.set('discordWebhook', e.target.value)}
              />
            </div>
          </div>

          {/* Who runs when BUY NOW is clicked on a monitor embed. The SKU and quantity come off the
              embed itself (PID and Cart Limit); this is the only part that is a choice. */}
          <div className="settings-section">
            <div className="settings-section-title">Auto Buy Profiles</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
              Clicking <b>Buy Now</b> on a P-Bandai restock embed launches these profiles straight at
              that SKU. Quantity follows the embed&apos;s Cart Limit. Only a click from the Discord
              account this licence belongs to will do anything on this machine.
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '1 1 220px', minWidth: 0 }}>
                <label className="form-label">Profile group</label>
                <select
                  className="form-select"
                  value={autoBuyGroup}
                  onChange={e => this.set('autoBuyGroup', e.target.value)}
                >
                  <option value="">All profiles</option>
                  {profileGroups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
                  {matchingProfiles} profile{matchingProfiles === 1 ? '' : 's'} match
                </div>
              </div>
              <div className="form-group" style={{ flex: '0 0 150px' }}>
                <label className="form-label">Max at once</label>
                <input
                  className="form-input"
                  type="number"
                  min="1"
                  max="50"
                  value={autoBuyMax}
                  onChange={e => this.set('autoBuyMax', e.target.value)}
                />
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
                  one browser each
                </div>
              </div>
              <div className="form-group" style={{ flex: '1 1 200px', minWidth: 0 }}>
                <label className="form-label">Connection</label>
                <select
                  className="form-select"
                  value={autoBuyConnection}
                  onChange={e => this.set('autoBuyConnection', e.target.value)}
                >
                  <option value="inhouse1">In-House 1</option>
                  <option value="inhouse2">In-House 2</option>
                  <option value="inhousemix">In-House Mix</option>
                  <option value="none">No proxy</option>
                  {proxyLists.map(l => <option key={l.name} value={`list:${l.name}`}>{l.name}</option>)}
                </select>
              </div>
            </div>
            {matchingProfiles > autoBuyCap && (
              <div style={{ fontSize: 11, color: '#ff8a5a', marginTop: 6 }}>
                Only the first {autoBuyCap} of {matchingProfiles} will launch — one click, {autoBuyCap} browsers.
              </div>
            )}
          </div>

          {/* Operator-only from here. Solver keys are the operator's paid accounts — a beta tester
              seeing them can copy them, and a tester CHANGING them silently breaks Walmart for
              themselves with no error that points back here. Same for the harvest settings: wrong
              TCINs starve the cookie bank and the symptom shows up as unexplained checkout failures
              hours later. Hidden, not removed — see the operatorMode note by the page title. */}
          {operatorMode && (<>
          <div className="settings-section">
            <div className="settings-section-title">Antibots / Solver Keys</div>
            <div className="form-group">
              <label className="form-label">Luca (PerimeterX) API Key — Walmart</label>
              <input
                className="form-input monospace"
                placeholder="paste your ParallaxAPIs / Luca key"
                value={lucaApiKey}
                onChange={e => this.set('lucaApiKey', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Hyper Solutions API Key (optional)</label>
              <input
                className="form-input monospace"
                placeholder="paste your Hyper Solutions key"
                value={hyperApiKey}
                onChange={e => this.set('hyperApiKey', e.target.value)}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Required for Walmart checkout — the engine solves PerimeterX with this key. Without it, Walmart tasks stall at “px init failed”.
            </div>
          </div>

          {/* The Target engine has read all five of these since it shipped; none had a control, so the
              Shape harvest ran on hardcoded defaults. Every one is applied on the next farmer spawn. */}
          <div className="settings-section">
            <div className="settings-section-title">Target — Shape Cookie Harvest</div>
            <div style={{ fontSize: 11, color: '#e0b050', marginBottom: 10 }}>
              Operator settings — leave these alone unless you know why you are changing them.
            </div>
            <div className="form-group">
              <label className="form-label">Harvest products (TCINs or Target links, comma-separated)</label>
              <textarea
                className="form-input monospace"
                rows={3}
                placeholder="leave blank for the built-in list — 22 trading-card TCINs"
                value={targetAtcHarvestTcins}
                onChange={e => this.set('targetAtcHarvestTcins', e.target.value)}
              />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                The farmer carts these to make Target sign an add-to-cart request; nothing is ever bought. Pick
                <b> cheap, always-in-stock, everyday items</b>. The built-in list is trading cards, and Target gates
                add-to-cart on those behind sign-in — a signed-out harvest gets bounced to the login page and banks
                no cookie. An out-of-stock item renders no button and harvests nothing either.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Cookie bank size</label>
                <input
                  className="form-input" type="number" min="1" placeholder="blank = no limit"
                  value={targetCookieBank}
                  onChange={e => this.set('targetCookieBank', e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Harvest workers</label>
                <input
                  className="form-input" type="number" min="1" placeholder="one per browser"
                  value={targetHarvestWorkers}
                  onChange={e => this.set('targetHarvestWorkers', e.target.value)}
                />
              </div>
              {/* How long a banked cookie is kept. Ours to choose — nothing tells us when Shape
                  actually stops honouring a header, so it is a bet in both directions. */}
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Cookie TTL (seconds)</label>
                <input
                  className="form-input" type="number" min="30" placeholder="600 (default)"
                  value={targetCookieTtlSec}
                  onChange={e => this.set('targetCookieTtlSec', e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Shape method</label>
                <select
                  className="form-input"
                  value={shapeMethod}
                  onChange={e => this.set('shapeMethod', e.target.value)}
                >
                  <option value="In Bot">In Bot</option>
                  <option value="Harvester">Harvester (+ extension)</option>
                </select>
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={targetVerboseLogs}
                  onChange={e => this.set('targetVerboseLogs', e.target.checked)}
                />
                Verbose Target logs
              </label>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                Shows every engine and harvester line instead of just errors and outcomes. Noisy — turn it on when
                something is failing and you need the step-by-step, off again afterwards.
              </div>
            </div>
          </div>
          </>)}

          <div className="settings-section">
            <div className="settings-section-title">Email / OTP (IMAP)</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">IMAP Host</label>
                <select
                  className="form-select"
                  value={imapSel}
                  onChange={e => this.changeImapHost(e.target.value)}
                >
                  {IMAP_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 0.4 }}>
                <label className="form-label">Port</label>
                <input className="form-input monospace" value="993" disabled readOnly title="Fixed — all IMAPS providers use 993" />
              </div>
            </div>
            {imapSel === 'custom' && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Custom Host</label>
                  <input
                    className="form-input monospace"
                    placeholder="imap.example.com"
                    value={imapHostCustom}
                    onChange={e => this.set('imapHostCustom', e.target.value)}
                  />
                </div>
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Mailbox User</label>
                <input
                  className="form-input monospace"
                  placeholder="catch-all@yourdomain.com"
                  value={imapUser}
                  onChange={e => this.set('imapUser', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Mailbox Password (app password)</label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="form-input monospace"
                    style={{ paddingRight: 30 }}
                    type={showImapPass ? 'text' : 'password'}
                    placeholder="app-specific password"
                    value={imapPass}
                    onChange={e => this.set('imapPass', e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => this.setState(s => ({ showImapPass: !s.showImapPass }))}
                    title={showImapPass ? 'Hide' : 'Show'}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: 4, lineHeight: 1 }}
                  >
                    {showImapPass ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>
            </div>
            <div className="form-row" style={{ marginTop: 6 }}>
              <div className="form-group">
                <label className="form-label">AYCD Inbox API Key <span style={{ color: 'var(--accent)', fontWeight: 400 }}>— preferred, tried before IMAP</span></label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="form-input monospace"
                    style={{ paddingRight: 30 }}
                    type={showAycdKey ? 'text' : 'password'}
                    placeholder="AYCD Inbox API key"
                    value={aycdApiKey}
                    onChange={e => this.set('aycdApiKey', e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => this.setState(s => ({ showAycdKey: !s.showAycdKey }))}
                    title={showAycdKey ? 'Hide' : 'Show'}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: 4, lineHeight: 1 }}
                  >
                    {showAycdKey ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Target &amp; Walmart pull each account’s OTP / 2FA code here, filtered by the account’s own email as the To:. <strong>AYCD Inbox</strong> (set the key above) is tried first — that’s where Target codes come from if your mailboxes are AYCD-connected. The <strong>IMAP</strong> mailbox is the fallback; Gmail/iCloud need an app-specific password.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Backup &amp; Restore</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={this.exportData}>
                <i className="ion-md-download" style={{ fontSize: 12 }} /> Export all data
              </button>
              <button className="btn btn-secondary btn-sm" onClick={this.importData}>
                <i className="ion-md-open" style={{ fontSize: 12 }} /> Import from file
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={this.state.importReplace}
                  onChange={e => this.setState({ importReplace: e.target.checked })}
                />
                Import replaces existing (instead of merging)
              </label>
            </div>
            <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 8 }}>
              ⚠ The export is plain text — it holds your card details, site passwords, and Discord token. Store it somewhere safe.
            </div>
            {this.state.ioMsg
              ? <div style={{ fontSize: 11, color: this.state.ioColor, marginTop: 6 }}>{this.state.ioMsg}</div>
              : null}
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({ settings: s.settings, update: s.update, profiles: s.profiles, proxies: s.proxies }))(Settings);
