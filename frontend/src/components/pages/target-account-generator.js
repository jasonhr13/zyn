import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyCount, proxyLabel, proxyRef } from '../proxy-options';
import { parseProxyLine } from '../proxy-line.mjs';
import { timestampLogLine } from '../log-timestamp';
import {
  generatedProfilesFromTemplate,
  isTargetProfile,
  targetProfileTemplateReady,
} from '../generated-profile-template.mjs';

const { ipcRenderer, clipboard } = window.require('electron');

const IMAP_PROVIDERS = [
  { value: 'imap.gmail.com', label: 'Gmail' },
  { value: 'imap.mail.yahoo.com', label: 'Yahoo' },
  { value: 'outlook.office365.com', label: 'Outlook / Hotmail' },
  { value: 'imap.mail.me.com', label: 'iCloud Mail' },
  { value: 'custom', label: 'Custom host' },
];
const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Parker', 'Cameron', 'Reese'];
const LAST_NAMES = ['Smith', 'Morgan', 'Brown', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin'];
const MAX_CONCURRENCY = 50;

const randomPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let value = 'Zy9!';
  for (let i = 0; i < 10; i++) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
};

const targetAccounts = accounts => (Array.isArray(accounts) ? accounts : [])
  .filter(account => String((account && account.site) || '').toLowerCase() === 'target');

export class TargetAccountGenerator extends Component {
  constructor(props) {
    super(props);
    const saved = (props.settings || {}).targetAccountGenerator || {};
    this.state = {
      emails: '',
      password: randomPassword(),
      showPassword: false,
      randomizeName: saved.randomizeName !== false,
      firstName: saved.firstName || '',
      lastName: saved.lastName || '',
      imapHost: saved.imapHost || 'imap.gmail.com',
      imapHostCustom: saved.imapHostCustom || '',
      imapUser: saved.imapUser || '',
      imapPass: '',
      showImapPass: false,
      proxyListName: saved.proxyListName || '',
      profileTemplateId: saved.profileTemplateId || '',
      jigShipping: saved.jigShipping !== false,
      concurrency: String(saved.concurrency || '1'),
      catchallDomain: '',
      catchallCount: '20',
      isRunning: false,
      progress: 0,
      logs: [],
      summary: null,
    };
    this.activeRunIds = new Set();
    this.runLabels = {};
    this.stopRequested = false;
    this.unmounted = false;
  }

  componentDidMount() {
    this.onBotLog = (event, { runId, line } = {}) => {
      const label = this.runLabels[runId];
      this.addLog(label ? `[${label}] ${line}` : line);
    };
    ipcRenderer.on('botScriptLog', this.onBotLog);
  }

  componentWillUnmount() {
    this.unmounted = true;
    clearTimeout(this.persistTimer);
    ipcRenderer.removeListener('botScriptLog', this.onBotLog);
    for (const runId of this.activeRunIds) {
      try { ipcRenderer.sendSync('stopBotScript', runId); } catch {}
    }
  }

  addLog = message => {
    if (this.unmounted) return;
    this.setState(previous => ({ logs: [...previous.logs, timestampLogLine(message)] }));
  };

  persistConfig = () => {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const targetAccountGenerator = {
        randomizeName: this.state.randomizeName,
        firstName: this.state.firstName,
        lastName: this.state.lastName,
        imapHost: this.state.imapHost,
        imapHostCustom: this.state.imapHostCustom,
        imapUser: this.state.imapUser,
        proxyListName: this.state.proxyListName,
        profileTemplateId: this.state.profileTemplateId,
        jigShipping: this.state.jigShipping,
        concurrency: this.state.concurrency,
      };
      const settings = { ...(this.props.settings || {}), targetAccountGenerator };
      try { ipcRenderer.sendSync('saveSettings', settings); } catch {}
      this.props.dispatch({ type: 'update', obj: { settings } });
    }, 300);
  };

  setPersisted = (field, value) => this.setState({ [field]: value }, this.persistConfig);

  selectedProxyList = () => ((this.props.proxies || {}).lists || [])
    .find(list => proxyRef(list) === this.state.proxyListName);

  targetProfileTemplates = () => (Array.isArray(this.props.profiles) ? this.props.profiles : [])
    .filter(isTargetProfile);

  selectedProfileTemplate = () => this.targetProfileTemplates()
    .find(profile => String(profile.id) === String(this.state.profileTemplateId));

  effectiveImapHost = () => this.state.imapHost === 'custom'
    ? this.state.imapHostCustom.trim() : this.state.imapHost;

  addCatchallEmails = () => {
    let domain = this.state.catchallDomain.trim().replace(/^@/, '');
    const count = Math.min(500, Math.max(1, parseInt(this.state.catchallCount, 10) || 0));
    if (!domain || !domain.includes('.')) {
      this.addLog('Enter a valid catchall domain first.');
      return;
    }
    const existing = new Set(this.state.emails.split(/\s+/).map(value => value.toLowerCase()).filter(Boolean));
    const created = [];
    let guard = 0;
    while (created.length < count && guard++ < count * 20) {
      const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
      const email = `${first}${last}${Math.floor(10 + Math.random() * 90)}@${domain}`;
      if (existing.has(email.toLowerCase())) continue;
      existing.add(email.toLowerCase());
      created.push(email);
    }
    this.setState(previous => ({
      emails: [previous.emails.trim(), created.join('\n')].filter(Boolean).join('\n'),
    }));
    this.addLog(`Added ${created.length} catchall email${created.length === 1 ? '' : 's'} for @${domain}.`);
  };

  saveGeneratedAccount = (email, password) => {
    const accounts = ipcRenderer.sendSync('addGeneratedAccount', { email, password, site: 'target' }) || [];
    const group = String(this.props.accountGroup || '').trim();
    if (group) {
      const account = targetAccounts(accounts)
        .find(item => String(item.email || '').toLowerCase() === email.toLowerCase());
      if (account) ipcRenderer.sendSync('addAccountsToGroup', { ids: [account.id], group });
    }
    return targetAccounts(accounts)
      .find(item => String(item.email || '').toLowerCase() === email.toLowerCase()) || null;
  };

  start = async () => {
    if (this.state.isRunning) return;
    const requested = this.state.emails.split(/\s+/).map(value => value.trim()).filter(Boolean);
    const valid = [...new Set(requested.filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).map(email => email.toLowerCase()))];
    const savedEmails = new Set(targetAccounts(this.props.accounts).map(account => String(account.email || '').toLowerCase()));
    const emails = valid.filter(email => !savedEmails.has(email));
    const invalidCount = requested.length - valid.length;
    const skippedCount = valid.length - emails.length;
    const selectedProxy = this.selectedProxyList();
    const rawProxyLines = selectedProxy && !selectedProxy.managed
      ? String(selectedProxy.raw || '').split('\n').map(line => line.trim()).filter(Boolean) : [];
    const proxyLines = rawProxyLines.map(parseProxyLine).filter(Boolean);
    const managedProxyRef = selectedProxy && selectedProxy.managed ? proxyRef(selectedProxy) : '';
    const profileTemplate = this.selectedProfileTemplate();

    if (!emails.length) {
      this.addLog(valid.length ? 'Every valid email already has a saved Target account.' : 'Add at least one valid email address.');
      return;
    }
    if (!this.state.password) { this.addLog('Enter a password for the generated accounts.'); return; }
    if (!selectedProxy) { this.addLog('Target generation requires a proxy list.'); return; }
    if (!managedProxyRef && !proxyLines.length) { this.addLog('The selected proxy list has no valid entries.'); return; }
    if (this.state.profileTemplateId && !targetProfileTemplateReady(profileTemplate)) {
      this.addLog('Choose a complete Target profile template with shipping and payment details.');
      return;
    }
    if (!this.state.randomizeName && (!this.state.firstName.trim() || !this.state.lastName.trim())) {
      this.addLog('Enter a first and last name or enable randomized names.');
      return;
    }
    if ((this.state.imapUser && !this.state.imapPass) || (!this.state.imapUser && this.state.imapPass)) {
      this.addLog('Enter both the IMAP user and password, or leave both blank.');
      return;
    }

    this.stopRequested = false;
    this.activeRunIds = new Set();
    this.runLabels = {};
    this.setState({ isRunning: true, progress: 0, logs: [], summary: null });
    if (invalidCount) this.addLog(`Ignored ${invalidCount} invalid email entr${invalidCount === 1 ? 'y' : 'ies'}.`);
    if (skippedCount) this.addLog(`Skipped ${skippedCount} email${skippedCount === 1 ? '' : 's'} already saved as Target accounts.`);
    this.addLog(`Starting ${emails.length} Target account${emails.length === 1 ? '' : 's'} with ${proxyLabel(selectedProxy)}.`);

    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, parseInt(this.state.concurrency, 10) || 1));
    const settings = this.props.settings || {};
    let completed = 0;
    let nextIndex = 0;
    const successfulEmails = [];

    const runOne = async index => {
      const email = emails[index];
      const runId = `target-account-${Date.now()}-${index}-${email}`;
      const args = [
        `--email=${email}`,
        `--password=${this.state.password}`,
        `--id=${email.split('@')[0]}-${index}`,
        ...(!this.state.randomizeName ? [
          `--firstName=${this.state.firstName.trim()}`,
          `--lastName=${this.state.lastName.trim()}`,
        ] : []),
        ...(settings.accountGenWebhook ? [`--webhook=${settings.accountGenWebhook}`] : []),
        ...(settings.aycdApiKey ? [`--aycdApiKey=${settings.aycdApiKey}`] : []),
        ...(this.state.imapUser && this.state.imapPass ? [
          `--imapHost=${this.effectiveImapHost()}`,
          '--imapPort=993',
          `--imapUser=${this.state.imapUser.trim()}`,
          `--imapPass=${this.state.imapPass}`,
        ] : []),
      ];
      if (proxyLines.length) {
        const proxy = proxyLines[Math.floor(Math.random() * proxyLines.length)];
        args.push(`--proxyServer=${proxy.server}`);
        if (proxy.username) args.push(`--proxyUser=${proxy.username}`);
        if (proxy.password) args.push(`--proxyPass=${proxy.password}`);
      }

      this.activeRunIds.add(runId);
      this.runLabels[runId] = email;
      this.addLog(`[${email}] Launching browser…`);
      try {
        const result = await ipcRenderer.invoke('runBotScript', 'target-register.mjs', args, runId, managedProxyRef);
        if (result && result.success) {
          this.saveGeneratedAccount(email, this.state.password);
          successfulEmails.push(email);
          this.addLog(`[${email}] Account created and saved.`);
        } else {
          this.addLog(`[${email}] ${(result && result.error) || 'Generation failed.'}`);
        }
      } catch (error) {
        this.addLog(`[${email}] ${error.message}`);
      } finally {
        this.activeRunIds.delete(runId);
        delete this.runLabels[runId];
        completed++;
        if (!this.unmounted) this.setState({ progress: completed / emails.length * 100 });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, emails.length) }, async () => {
      while (!this.stopRequested) {
        const index = nextIndex++;
        if (index >= emails.length) return;
        await runOne(index);
      }
    });
    await Promise.all(workers);

    if (this.unmounted) return;
    let profilesCreated = 0;
    let profilesSkipped = 0;
    if (profileTemplate && successfulEmails.length) {
      const profileDrafts = generatedProfilesFromTemplate(profileTemplate, successfulEmails, this.props.profiles, {
        jigShipping: this.state.jigShipping,
      });
      profilesSkipped = successfulEmails.length - profileDrafts.length;
      if (profileDrafts.length) {
        try {
          const created = ipcRenderer.sendSync('createProfilesBulk', profileDrafts) || [];
          profilesCreated = created.length;
          this.addLog(`Created ${profilesCreated} matching checkout profile${profilesCreated === 1 ? '' : 's'} from “${profileTemplate.profileName || profileTemplate.email}”${this.state.jigShipping ? ' with jigged shipping' : ''}.`);
        } catch (error) {
          this.addLog(`Accounts were saved, but matching profiles could not be created: ${error.message}`);
        }
      }
      if (profilesSkipped) this.addLog(`Skipped ${profilesSkipped} profile${profilesSkipped === 1 ? '' : 's'} that already existed.`);
    }

    const summary = {
      requested: emails.length,
      attempted: completed,
      accountsCreated: successfulEmails.length,
      failed: completed - successfulEmails.length,
      notRun: emails.length - completed,
      profilesCreated,
      profilesSkipped,
    };
    this.setState({
      isRunning: false,
      progress: this.stopRequested ? completed / emails.length * 100 : 100,
      summary,
    });
    const accounts = ipcRenderer.sendSync('getAccounts') || [];
    const profiles = ipcRenderer.sendSync('getProfiles') || [];
    this.props.dispatch({ type: 'update', obj: { accounts, profiles } });
    if (this.props.onAccountsChanged) this.props.onAccountsChanged(accounts);
    this.addLog(`${this.stopRequested ? 'Generation stopped' : 'Target account generation finished'}: ${summary.accountsCreated} account${summary.accountsCreated === 1 ? '' : 's'} saved, ${summary.failed} failed${summary.notRun ? `, ${summary.notRun} not started` : ''}.`);
  };

  stop = () => {
    this.stopRequested = true;
    for (const runId of this.activeRunIds) {
      try { ipcRenderer.sendSync('stopBotScript', runId); } catch {}
    }
    this.addLog('Stopping active browsers…');
  };

  render() {
    const proxyLists = ((this.props.proxies || {}).lists || []);
    const selectedProxy = this.selectedProxyList();
    const profileTemplates = this.targetProfileTemplates();
    const selectedProfileTemplate = this.selectedProfileTemplate();
    const settings = this.props.settings || {};
    const { isRunning, progress, logs, summary } = this.state;
    return (
      <div className="modal-overlay target-account-generator-overlay">
        <div className="modal target-account-generator-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div>
              <div className="modal-title">Generate Target Accounts</div>
              <p>Each account runs in its own headed Playwright session on one stable proxy. Target signup does not use SMS or an address.</p>
            </div>
            <button className="modal-close" disabled={isRunning} title={isRunning ? 'Stop generation before closing' : 'Close'} onClick={this.props.onClose}>×</button>
          </div>

          <div className="modal-body target-account-generator-body">
            <div className="target-account-generator-form">
              <div className="form-group">
                <div className="target-account-generator-label-row">
                  <label className="form-label">Emails <span>(one per line)</span></label>
                  <small>{this.state.emails.split(/\s+/).filter(Boolean).length} queued</small>
                </div>
                <textarea className="form-textarea target-account-generator-emails" spellCheck={false}
                  placeholder={'email1@example.com\nemail2@example.com'} value={this.state.emails}
                  onChange={event => this.setState({ emails: event.target.value })} />
              </div>

              <div className="target-account-generator-catchall">
                <input className="form-input" placeholder="catchall-domain.com" value={this.state.catchallDomain}
                  onChange={event => this.setState({ catchallDomain: event.target.value })} />
                <input className="form-input" type="number" min="1" max="500" value={this.state.catchallCount}
                  onChange={event => this.setState({ catchallCount: event.target.value })} />
                <button className="btn btn-secondary btn-sm" type="button" onClick={this.addCatchallEmails}>Add Catchall</button>
              </div>

              <div className="form-group">
                <label className="form-label">Account password</label>
                <div className="target-account-generator-secret">
                  <input className="form-input" type={this.state.showPassword ? 'text' : 'password'} value={this.state.password}
                    onChange={event => this.setState({ password: event.target.value })} />
                  <button type="button" onClick={() => this.setState(previous => ({ showPassword: !previous.showPassword }))}>
                    {this.state.showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <div className="form-hint">Used for this batch only. Generated credentials are encrypted when saved to Accounts.</div>
              </div>

              <label className="target-account-generator-check">
                <input type="checkbox" checked={this.state.randomizeName}
                  onChange={event => this.setPersisted('randomizeName', event.target.checked)} />
                Randomize first and last name for every account
              </label>
              {!this.state.randomizeName && <div className="form-row">
                <div className="form-group"><label className="form-label">First name</label><input className="form-input" value={this.state.firstName}
                  onChange={event => this.setPersisted('firstName', event.target.value)} /></div>
                <div className="form-group"><label className="form-label">Last name</label><input className="form-input" value={this.state.lastName}
                  onChange={event => this.setPersisted('lastName', event.target.value)} /></div>
              </div>}

              <div className="target-account-generator-section-title">Checkout profiles <span>optional</span></div>
              <div className="form-group">
                <label className="form-label">Create matching profiles from</label>
                <select className="form-select" value={this.state.profileTemplateId}
                  onChange={event => this.setPersisted('profileTemplateId', event.target.value)}>
                  <option value="">Accounts only — do not create profiles</option>
                  {profileTemplates.map(profile => {
                    const ready = targetProfileTemplateReady(profile);
                    return <option key={profile.id} value={profile.id} disabled={!ready}>
                      {profile.profileName || profile.email}{ready ? '' : ' — missing address/payment'}
                    </option>;
                  })}
                </select>
                <div className="form-hint">Every successful account gets a profile with its matching email. Payment, phone, mailbox, and the card billing address stay exactly as on the template. When jigging is on, only shipping line 1 and line 2 are varied.</div>
                {!profileTemplates.length && <div className="form-hint text-danger">Create one complete Target profile first, then reopen this generator to use it as a template.</div>}
                {selectedProfileTemplate && <>
                  <label className="target-account-generator-check">
                    <input type="checkbox" checked={this.state.jigShipping}
                      onChange={event => this.setPersisted('jigShipping', event.target.checked)} />
                    Jig shipping line 1 and line 2 for each profile
                  </label>
                  <div className="target-account-generator-template-ready"><i className="ion-md-checkmark-circle" /> Ready: {selectedProfileTemplate.shipping?.address}, {selectedProfileTemplate.shipping?.city}</div>
                </>}
              </div>

              <div className="target-account-generator-section-title">Proxy</div>
              <div className="form-group">
                <select className="form-select" value={this.state.proxyListName}
                  onChange={event => this.setPersisted('proxyListName', event.target.value)}>
                  <option value="">Select a proxy list…</option>
                  {proxyLists.map(list => <option key={proxyRef(list)} value={proxyRef(list)}>{proxyLabel(list)}</option>)}
                </select>
                <div className="form-hint">Required. {selectedProxy ? `${proxyCount(selectedProxy)} available; one stays attached to each complete browser session.` : 'Choose a list from the Proxies workspace.'}</div>
              </div>

              <div className="target-account-generator-section-title">Email verification recovery <span>optional</span></div>
              <div className="target-account-generator-status-row">
                <span>AYCD Inbox</span><strong className={settings.aycdApiKey ? 'configured' : ''}>{settings.aycdApiKey ? 'Configured in Settings' : 'Not configured'}</strong>
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">IMAP provider</label><select className="form-select" value={this.state.imapHost}
                  onChange={event => this.setPersisted('imapHost', event.target.value)}>{IMAP_PROVIDERS.map(provider => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></div>
                <div className="form-group"><label className="form-label">IMAP user</label><input className="form-input" type="email" value={this.state.imapUser}
                  onChange={event => this.setPersisted('imapUser', event.target.value)} placeholder="mailbox@example.com" /></div>
              </div>
              {this.state.imapHost === 'custom' && <div className="form-group"><label className="form-label">Custom IMAP host</label><input className="form-input"
                value={this.state.imapHostCustom} onChange={event => this.setPersisted('imapHostCustom', event.target.value)} placeholder="imap.example.com" /></div>}
              <div className="form-group">
                <label className="form-label">IMAP app password</label>
                <div className="target-account-generator-secret"><input className="form-input" type={this.state.showImapPass ? 'text' : 'password'} value={this.state.imapPass}
                  onChange={event => this.setState({ imapPass: event.target.value })} placeholder="Not saved after this window closes" />
                  <button type="button" onClick={() => this.setState(previous => ({ showImapPass: !previous.showImapPass }))}>{this.state.showImapPass ? 'Hide' : 'Show'}</button></div>
              </div>

              <div className="form-row target-account-generator-run-options">
                <div className="form-group"><label className="form-label">Concurrent browsers</label><input className="form-input" type="number" min="1" max={MAX_CONCURRENCY}
                  value={this.state.concurrency} onChange={event => this.setPersisted('concurrency', event.target.value)} /></div>
                <div className="target-account-generator-status-row"><span>Account webhook</span><strong className={settings.accountGenWebhook ? 'configured' : ''}>{settings.accountGenWebhook ? 'Configured in Settings' : 'Off'}</strong></div>
              </div>
            </div>

            <div className="target-account-generator-log-panel">
              <div className="target-account-generator-log-head"><div><strong>Run log</strong><span>Target browser output</span></div>
                <div><button className="btn btn-secondary btn-sm" disabled={!logs.length} onClick={() => clipboard.writeText(logs.join('\n'))}>Copy</button>
                  <button className="btn btn-secondary btn-sm" disabled={!logs.length || isRunning} onClick={() => this.setState({ logs: [] })}>Clear</button></div></div>
              <div className="target-account-generator-logs">{logs.length
                ? logs.map((line, index) => <div className="log-line" key={`${index}-${line}`}>{line}</div>)
                : <div className="target-account-generator-log-empty">Configure the batch, choose a proxy list, then start generation.</div>}</div>
              {summary && <div className="target-account-generator-summary">
                <strong>{summary.accountsCreated} account{summary.accountsCreated === 1 ? '' : 's'} saved</strong>
                <span>{summary.profilesCreated} profile{summary.profilesCreated === 1 ? '' : 's'} created</span>
                {!!summary.failed && <span>{summary.failed} failed</span>}
                {!!summary.notRun && <span>{summary.notRun} not started</span>}
              </div>}
              <div className="target-account-generator-progress"><span style={{ width: `${progress}%` }} /></div>
              <small>{isRunning ? `${Math.round(progress)}% complete` : progress === 100 ? 'Batch finished' : 'Ready'}</small>
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary" disabled={isRunning} onClick={this.props.onClose}>Close</button>
            {isRunning
              ? <button className="btn btn-danger" onClick={this.stop}>Stop All Browsers</button>
              : <button className="btn btn-primary" onClick={this.start}>Generate Target Accounts</button>}
          </div>
        </div>
      </div>
    );
  }
}

export default connect(state => ({
  accounts: state.accounts,
  profiles: state.profiles,
  proxies: state.proxies,
  settings: state.settings,
}))(TargetAccountGenerator);
