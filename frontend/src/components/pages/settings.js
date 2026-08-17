import React, { Component } from 'react';
import { connect } from 'react-redux';
import {
  MAX_HARVESTER_EXTENSION_IDS,
  harvesterExtensionIdsFromSettings,
  parseHarvesterExtensionIds,
} from '../harvester-extension-ids.mjs';
const { ipcRenderer } = window.require('electron');

// The packaged app's real version — the same value electron-updater compares against.
let APP_VERSION = '';
try { APP_VERSION = ipcRenderer.sendSync('getAppVersion') || ''; } catch {}

const MAX_SHAPE_CAPTURES_PER_LOAD = 10;
const MAX_SHAPE_LOADS_PER_BROWSER = 10;
const DEFAULT_ATC_COOKIES_PER_TASK = 3;
const MAX_ATC_COOKIES_PER_TASK = Number.MAX_SAFE_INTEGER;
const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//i;
const CLOUD_BACKUP_VISIBLE = 3;
const CLOUD_BACKUP_LIST_CAP = 10;

const FieldHelp = ({ children, align = 'left' }) => (
  <span className={`field-help${align === 'right' ? ' field-help-right' : ''}`}>
    <button type="button" className="field-help-button" aria-label={children}>i</button>
    <span className="field-help-tooltip" role="tooltip">{children}</span>
  </span>
);

const FieldLabel = ({ children, help, helpAlign = 'left' }) => (
  <div className="field-label-row">
    <label className="form-label">{children}</label>
    {help ? <FieldHelp align={helpAlign}>{help}</FieldHelp> : null}
  </div>
);

const normalizeShapeThroughput = (value, maximum, fallback) => {
  const parsed = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  return String(Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback);
};

const normalizeAtcCookiesPerTask = value => {
  const parsed = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  return String(Number.isFinite(parsed) && parsed >= 0
    ? Math.max(0, Math.min(MAX_ATC_COOKIES_PER_TASK, parsed))
    : DEFAULT_ATC_COOKIES_PER_TASK);
};

class Settings extends Component {
  constructor(props) {
    super(props);
    this.state = {
      discordWebhook: '',
      discordDeclineWebhook: '',
      accountGenWebhook: '', webhookError: '',
      aycdApiKey: '', showAycdKey: false,
      // Target: preserve the original harvest controls and the throughput/bandwidth settings ported
      // from the reviewed upstream implementation under the persisted keys used by cloud backup.
      targetAtcHarvestTcins: '', targetAtcCookiesPerTask: String(DEFAULT_ATC_COOKIES_PER_TASK), targetHarvestWorkers: '', targetCookieTtlSec: '',
      targetCapturesPerLoad: '1', targetLoadsPerBrowser: '3', targetBlockHeavyResources: true,
      targetVerboseLogs: false, hcaptchaAutosolve: true, shapeMethod: 'In Bot', targetHarvesterExtensionIds: '', extensionIdsError: '',
      licenseEmail: '', licenseOffline: false, pokemonCenterAccess: false, proxyAccess: false, managedProxyCount: 0,
      signingOut: false,
      clearingAnalytics: false, analyticsMsg: '', analyticsColor: 'var(--muted)',
      saved: false, ioMsg: '', ioColor: 'var(--muted)', importReplace: false,
      cloudBackup: null, cloudBackups: [], cloudLoading: false,
      cloudListLoaded: false, cloudListError: '', cloudOlderBackupsOpen: false,
      cloudMsg: '', cloudMsgColor: 'var(--muted)',
      recoveryAcknowledged: false, recoveryImport: '', recoveryExpectedFingerprint: '',
      cloudRestoreReplace: false,
    };
  }

  syncFromProps(s) {
    const g = s.generate || {};
    this.setState({
      discordWebhook: s.discordWebhook || '',
      discordDeclineWebhook: s.discordDeclineWebhook || '',
      accountGenWebhook: s.accountGenWebhook || '', webhookError: '',
      aycdApiKey: s.aycdApiKey || g.aycdApiKey || '',
      // Blank means "use the engine default" — the placeholders show what that default is, so an empty
      // box is never ambiguous. targetAtcHarvestTcin (singular) is the legacy key for the same setting.
      targetAtcHarvestTcins: s.targetAtcHarvestTcins || s.targetAtcHarvestTcin || '',
      targetAtcCookiesPerTask: normalizeAtcCookiesPerTask(s.targetAtcCookiesPerTask),
      targetHarvestWorkers: s.targetHarvestWorkers == null ? '' : String(s.targetHarvestWorkers),
      targetCookieTtlSec: s.targetCookieTtlSec == null ? '' : String(s.targetCookieTtlSec),
      targetCapturesPerLoad: String(s.targetCapturesPerLoad || 1),
      targetLoadsPerBrowser: String(s.targetLoadsPerBrowser || 3),
      targetBlockHeavyResources: s.targetBlockHeavyResources !== false,
      targetVerboseLogs: !!s.targetVerboseLogs,
      hcaptchaAutosolve: s.hcaptchaAutosolve !== false,
      shapeMethod: /^harvester$/i.test((s.shapeMethod || '').trim()) ? 'Harvester' : 'In Bot',
      targetHarvesterExtensionIds: harvesterExtensionIdsFromSettings(s),
      extensionIdsError: '',
    });
  }

  applyLicenseStatus = (eventOrStatus, pushedStatus) => {
    const status = pushedStatus || eventOrStatus;
    if (!status || typeof status !== 'object') return;
    this.setState({
      licenseEmail: status.email || '',
      licenseOffline: status.offline === true,
      pokemonCenterAccess: !!(status.taskTypes && status.taskTypes.pokemoncenter),
      proxyAccess: status.proxyAccess === true,
      managedProxyCount: Number(status.managedProxyCount) || 0,
      ...(status.ok === true ? {} : { cloudBackups: [], cloudListLoaded: false, cloudListError: '' }),
    });
    if (status.ok === true) this.loadCloudBackups();
  };

  applyCloudBackupStatus = (eventOrStatus, pushedStatus) => {
    const status = pushedStatus || eventOrStatus;
    if (status && typeof status === 'object') this.setState({ cloudBackup: status });
  };

  componentDidMount() {
    this.syncFromProps(this.props.settings || {});
    ipcRenderer.on('licenseStatus', this.applyLicenseStatus);
    ipcRenderer.on('cloudBackupStatus', this.applyCloudBackupStatus);
    ipcRenderer.invoke('licenseStatus').then(this.applyLicenseStatus).catch(() => {});
    ipcRenderer.invoke('cloudBackupStatus').then(this.applyCloudBackupStatus).catch(() => {});
  }
  componentWillUnmount() {
    ipcRenderer.removeListener('licenseStatus', this.applyLicenseStatus);
    ipcRenderer.removeListener('cloudBackupStatus', this.applyCloudBackupStatus);
  }
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
    // Preserve every legacy setting in storage while this Target-only screen manages only the
    // settings it exposes. That keeps old backups reversible without leaking retired modules here.
    const previousSettings = this.props.settings || {};
    const accountGenWebhook = this.state.accountGenWebhook.trim();
    if (accountGenWebhook && !DISCORD_WEBHOOK_RE.test(accountGenWebhook)) {
      this.setState({ webhookError: 'Enter a Discord webhook URL or leave this field blank.', saved: false });
      return;
    }
    const previousExtensionIds = harvesterExtensionIdsFromSettings(previousSettings);
    const extensionModeEnabled = this.state.shapeMethod === 'Harvester';
    const parsedExtensionIds = parseHarvesterExtensionIds(this.state.targetHarvesterExtensionIds, {
      requireOne: extensionModeEnabled,
    });
    if (extensionModeEnabled && parsedExtensionIds.error) {
      this.setState({ extensionIdsError: parsedExtensionIds.error, saved: false });
      return;
    }
    // A malformed hidden draft must not erase or truncate the last valid configuration merely
    // because harvesting was switched Off. When On, the visible validation above remains strict.
    const targetHarvesterExtensionIds = !extensionModeEnabled && parsedExtensionIds.error
      ? previousExtensionIds
      : parsedExtensionIds.normalized;
    const settings = {
      ...previousSettings,
      discordWebhook: this.state.discordWebhook,
      discordDeclineWebhook: this.state.discordDeclineWebhook,
      accountGenWebhook,
      aycdApiKey: this.state.aycdApiKey.trim(),
      // Normalise the TCIN list to bare comma-separated numbers: the farmer accepts full product URLs
      // too, so a pasted Target link survives, but stray spaces/newlines from a paste would otherwise
      // reach --atcTcins verbatim and break the argument.
      targetAtcHarvestTcins: this.state.targetAtcHarvestTcins.split(/[\s,]+/).filter(Boolean).join(','),
      targetAtcCookiesPerTask: normalizeAtcCookiesPerTask(this.state.targetAtcCookiesPerTask),
      targetHarvestWorkers: this.state.targetHarvestWorkers.trim(),
      targetCookieTtlSec: this.state.targetCookieTtlSec.trim(),
      targetCapturesPerLoad: normalizeShapeThroughput(
        this.state.targetCapturesPerLoad, MAX_SHAPE_CAPTURES_PER_LOAD, 1),
      targetLoadsPerBrowser: normalizeShapeThroughput(
        this.state.targetLoadsPerBrowser, MAX_SHAPE_LOADS_PER_BROWSER, 3),
      targetBlockHeavyResources: this.state.targetBlockHeavyResources !== false,
      targetVerboseLogs: !!this.state.targetVerboseLogs,
      hcaptchaAutosolve: this.state.hcaptchaAutosolve !== false,
      shapeMethod: this.state.shapeMethod,
      targetHarvesterExtensionIds,
      // Keep the first ID under the legacy singular key so older backups/builds remain reversible.
      targetHarvesterExtensionId: targetHarvesterExtensionIds.split('\n')[0] || '',
    };
    ipcRenderer.sendSync('saveSettings', settings);
    const previousExtensionMode = /^harvester$/i.test(String(previousSettings.shapeMethod || '').trim());
    if (previousExtensionMode !== (settings.shapeMethod === 'Harvester')
      || previousExtensionIds !== settings.targetHarvesterExtensionIds) {
      try { ipcRenderer.send('resetHarvesterExtensionActivity'); } catch {}
    }
    try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
    try { ipcRenderer.invoke('targetCookieBank').catch(() => {}); } catch {}
    this.props.dispatch({ type: 'update', obj: { settings } });
    this.setState({ saved: true, extensionIdsError: '', webhookError: '' });
    setTimeout(() => this.setState({ saved: false }), 2000);
  };

  checkUpdates = () => { try { ipcRenderer.send('checkForUpdates'); } catch {} };
  installUpdate = () => { try { ipcRenderer.send('installUpdate'); } catch {} };

  signOut = async () => {
    if (!window.confirm('Sign out of Zyn and stop every running task?')) return;
    this.setState({ signingOut: true });
    try { await ipcRenderer.invoke('logoutLicense'); }
    catch { this.setState({ signingOut: false }); }
  };

  clearAnalytics = async () => {
    if (!window.confirm(
      'Permanently delete all analytics data for this Zyn account?\n\n' +
      'This removes checkout history, declines, cart events, total-spent data, and chart history from every signed-in device.\n\n' +
      'This cannot be undone.'
    )) return;
    this.setState({ clearingAnalytics: true, analyticsMsg: '', analyticsColor: 'var(--muted)' });
    try {
      const result = await ipcRenderer.invoke('deleteAnalytics');
      this.setState(result && result.ok
        ? { clearingAnalytics: false, analyticsMsg: '✓ Analytics data deleted.', analyticsColor: 'var(--ok)' }
        : { clearingAnalytics: false, analyticsMsg: `Could not delete analytics: ${(result && result.message) || 'unknown error'}`, analyticsColor: 'var(--danger)' });
    } catch (error) {
      this.setState({ clearingAnalytics: false, analyticsMsg: `Could not delete analytics: ${error.message}`, analyticsColor: 'var(--danger)' });
    }
  };

  setCloudMessage = (text, ok = false) => this.setState({
    cloudMsg: text,
    cloudMsgColor: ok ? 'var(--ok)' : 'var(--danger)',
  });

  normalizeCloudBackups = backups => [...(Array.isArray(backups) ? backups : [])]
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .slice(0, CLOUD_BACKUP_LIST_CAP);

  loadCloudBackups = async () => {
    this.setState({ cloudLoading: true, cloudListError: '' });
    try {
      const result = await ipcRenderer.invoke('cloudBackupList');
      if (result && result.ok) {
        const cloudBackups = this.normalizeCloudBackups(result.backups);
        this.setState({
          cloudBackups,
          cloudListLoaded: true,
          cloudListError: '',
          cloudOlderBackupsOpen: cloudBackups.length > CLOUD_BACKUP_VISIBLE
            ? this.state.cloudOlderBackupsOpen : false,
        });
      } else {
        this.setState({ cloudListError: (result && result.error) || 'Could not load encrypted backups.' });
      }
    } catch (error) {
      this.setState({ cloudListError: error.message || 'Could not load encrypted backups.' });
    }
    this.setState({ cloudLoading: false });
  };

  renderCloudBackupRow = backup => (
    <div key={backup.id} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap',
    }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text)' }}>{this.formatBackupDate(backup.createdAt)}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
          {backup.deviceName || 'Unknown device'} · {this.formatBytes(backup.sizeBytes)} · v{backup.appVersion || 'unknown'} · Key {backup.keyFingerprint}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => this.restoreCloudBackup(backup)} disabled={this.state.cloudLoading}>Restore</button>
        <button className="btn btn-danger btn-sm" onClick={() => this.deleteCloudBackup(backup)} disabled={this.state.cloudLoading}>Delete</button>
      </div>
    </div>
  );

  setupCloudBackup = async () => {
    this.setState({ cloudLoading: true, cloudMsg: '' });
    try {
      const result = await ipcRenderer.invoke('cloudBackupSetupKey');
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not create a recovery key.');
      else this.setState({
        cloudBackup: result.status || this.state.cloudBackup,
        recoveryAcknowledged: false,
      });
    } catch (error) { this.setCloudMessage(error.message); }
    this.setState({ cloudLoading: false });
  };

  claimLegacyCloudBackup = async () => {
    if (!window.confirm(
      'Use the encrypted backup key and schedule found from the previous app installation for this signed-in Zyn account?\n\n' +
      'This binds that local backup setup to the current account. If automatic backups were already enabled, that schedule resumes immediately.'
    )) return;
    this.setState({ cloudLoading: true, cloudMsg: '' });
    try {
      const result = await ipcRenderer.invoke('cloudBackupClaimLegacy');
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not use the existing backup setup.');
      else this.setState({
        cloudBackup: result.status,
        cloudMsg: '✓ Existing encrypted backup setup is now linked to this Zyn account.',
        cloudMsgColor: 'var(--ok)',
      });
    } catch (error) { this.setCloudMessage(error.message); }
    this.setState({ cloudLoading: false });
  };

  copyCloudBackupKey = async () => {
    try {
      const result = await ipcRenderer.invoke('cloudBackupCopyKey');
      if (result && result.canceled) return;
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not copy the recovery key.');
      else {
        this.setState({
          cloudMsg: '✓ Recovery key copied. Save it securely; your operating system may sync clipboard contents.',
          cloudMsgColor: 'var(--ok)',
        });
        const status = await ipcRenderer.invoke('cloudBackupStatus');
        this.setState({ cloudBackup: status });
      }
    } catch (error) { this.setCloudMessage(error.message); }
  };

  saveCloudBackupKey = async () => {
    try {
      const result = await ipcRenderer.invoke('cloudBackupSaveKey');
      if (!result || result.canceled) return;
      if (!result.ok) this.setCloudMessage(result.error || 'Could not save the recovery key.');
      else {
        this.setState({ cloudMsg: '✓ Recovery-key file saved.', cloudMsgColor: 'var(--ok)' });
        const status = await ipcRenderer.invoke('cloudBackupStatus');
        this.setState({ cloudBackup: status });
      }
    } catch (error) { this.setCloudMessage(error.message); }
  };

  enableCloudBackup = async () => {
    if (!this.state.recoveryAcknowledged) return;
    const interval = Number(this.state.cloudBackup && this.state.cloudBackup.intervalMs) || 60 * 60 * 1000;
    this.setState({ cloudLoading: true, cloudMsg: 'Encrypting and uploading your first backup…', cloudMsgColor: 'var(--run)' });
    try {
      const result = await ipcRenderer.invoke('cloudBackupEnable', interval);
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not enable backups.');
      else {
        this.setState({
          cloudBackup: result.status,
          cloudMsg: '✓ Encrypted backup saved. Automatic backups are on.',
          cloudMsgColor: 'var(--ok)',
        });
        await this.loadCloudBackups();
      }
    } catch (error) { this.setCloudMessage(error.message); }
    this.setState({ cloudLoading: false });
  };

  setCloudBackupSchedule = async (event) => {
    const interval = Number(event.target.value);
    this.setState(state => ({ cloudBackup: { ...(state.cloudBackup || {}), intervalMs: interval, enabled: interval > 0 } }));
    try {
      const result = await ipcRenderer.invoke('cloudBackupSetSchedule', interval);
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not update the backup schedule.');
      else this.setState({
        cloudBackup: result.status,
        cloudMsg: interval ? '✓ Backup schedule updated.' : 'Automatic backups are off.',
        cloudMsgColor: interval ? 'var(--ok)' : 'var(--muted)',
      });
    } catch (error) { this.setCloudMessage(error.message); }
  };

  runCloudBackup = async () => {
    this.setState({ cloudLoading: true, cloudMsg: 'Encrypting on this device…', cloudMsgColor: 'var(--run)' });
    try {
      const result = await ipcRenderer.invoke('cloudBackupRun');
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Backup failed.');
      else {
        this.setState({ cloudBackup: result.status, cloudMsg: '✓ Encrypted backup saved.', cloudMsgColor: 'var(--ok)' });
        await this.loadCloudBackups();
      }
    } catch (error) { this.setCloudMessage(error.message); }
    this.setState({ cloudLoading: false });
  };

  importCloudBackupKey = async (expectedFingerprint = '') => {
    const recoveryKey = this.state.recoveryImport.trim();
    if (!recoveryKey) return;
    try {
      const result = await ipcRenderer.invoke('cloudBackupImportKey', { recoveryKey, expectedFingerprint });
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not import that recovery key.');
      else this.setState({
        cloudBackup: result.status,
        recoveryImport: '',
        recoveryExpectedFingerprint: '',
        cloudMsg: '✓ Recovery key imported on this device.',
        cloudMsgColor: 'var(--ok)',
      });
    } catch (error) { this.setCloudMessage(error.message); }
  };

  restoreCloudBackup = async (backup) => {
    const fingerprint = String(backup.keyFingerprint || '');
    const availableKeys = new Set([
      ...((this.state.cloudBackup && this.state.cloudBackup.keyFingerprints) || []),
      (this.state.cloudBackup && this.state.cloudBackup.keyFingerprint) || '',
    ].filter(Boolean));
    if (!availableKeys.has(fingerprint)) {
      this.setState({
        recoveryExpectedFingerprint: fingerprint,
        cloudMsg: 'Import the recovery key that matches this backup before restoring.',
        cloudMsgColor: 'var(--danger)',
      });
      return;
    }
    this.setState({ cloudLoading: true, cloudMsg: 'Decrypting backup on this device…', cloudMsgColor: 'var(--run)' });
    try {
      const mode = this.state.cloudRestoreReplace ? 'replace' : 'merge';
      const preview = await ipcRenderer.invoke('cloudBackupPreview', { backupId: backup.id, mode });
      if (!preview || !preview.ok) {
        this.setCloudMessage((preview && preview.error) || 'Could not decrypt that backup.');
        this.setState({ cloudLoading: false });
        return;
      }
      const counts = preview.preview || {};
      const groups = counts.taskGroups && typeof counts.taskGroups === 'object'
        ? counts.taskGroups
        : { total: Number(counts.taskGroups) || 0, supported: Number(counts.taskGroups) || 0 };
      const tasks = Number(counts.tasks || 0) + Number(counts.targetTasks || 0)
        + Number(counts.pokemonCenterTasks || 0) + Number(counts.legacyTasks || 0);
      const detail = `${counts.profiles || 0} profiles, ${counts.accounts || 0} accounts, ${counts.proxyLists || 0} proxy lists, ${groups.supported || 0} supported task groups, and ${tasks} tasks`;
      const warnings = Array.isArray(counts.warnings) ? counts.warnings.filter(Boolean) : [];
      const warningCopy = warnings.length ? `\n\nPlease review:\n• ${warnings.join('\n• ')}` : '';
      if (!window.confirm(`${mode === 'replace' ? 'Replace current data with' : 'Merge current data from'} this backup (${detail})?${warningCopy}`)) {
        this.setState({ cloudLoading: false, cloudMsg: '' });
        return;
      }
      const result = await ipcRenderer.invoke('cloudBackupRestore', { backupId: backup.id, mode });
      if (!result || !result.ok) {
        this.setCloudMessage((result && result.error) || 'Restore failed.');
        this.setState({ cloudLoading: false });
        return;
      }
      this.setState({ cloudMsg: '✓ Backup restored. Reloading…', cloudMsgColor: 'var(--ok)' });
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      this.setCloudMessage(error.message);
      this.setState({ cloudLoading: false });
    }
  };

  deleteCloudBackup = async (backup) => {
    if (!window.confirm(`Delete the encrypted backup from ${this.formatBackupDate(backup.createdAt)}?`)) return;
    try {
      const result = await ipcRenderer.invoke('cloudBackupDelete', backup.id);
      if (!result || !result.ok) this.setCloudMessage((result && result.error) || 'Could not delete that backup.');
      else {
        this.setState({ cloudMsg: '✓ Backup deleted.', cloudMsgColor: 'var(--ok)' });
        await this.loadCloudBackups();
      }
    } catch (error) { this.setCloudMessage(error.message); }
  };

  formatBackupDate = value => value ? new Date(Number(value)).toLocaleString() : 'Never';
  formatBytes = value => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  exportData = async () => {
    if (!window.confirm(
      'The exported file will contain your CARD DETAILS, SITE PASSWORDS, MAILBOX PASSWORDS, and DISCORD TOKEN in plain text.\n\n' +
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
      case 'checking':    return { text: 'Checking…', color: 'var(--run)' };
      case 'current':     return { text: `✓ You're on the latest version (v${APP_VERSION}).`, color: '#4ade80' };
      case 'downloading': return { text: `Downloading v${u.version || ''} — ${u.percent || 0}%…`, color: 'var(--run)' };
      case 'ready':       return { text: `v${u.version} is ready — click Restart & Update.`, color: '#4ade80' };
      case 'error':       return { text: `Couldn't check: ${u.message || 'unknown error'}`, color: '#f87171' };
      default:            return { text: '', color: 'var(--muted)' };
    }
  }

  render() {
    const { discordWebhook, discordDeclineWebhook, accountGenWebhook, webhookError, aycdApiKey, showAycdKey, saved,
      targetAtcHarvestTcins, targetAtcCookiesPerTask, targetHarvestWorkers, targetCookieTtlSec,
      targetCapturesPerLoad, targetLoadsPerBrowser, targetBlockHeavyResources,
      targetVerboseLogs, hcaptchaAutosolve, shapeMethod, targetHarvesterExtensionIds, extensionIdsError,
      licenseEmail, licenseOffline, pokemonCenterAccess, proxyAccess, managedProxyCount, signingOut,
      clearingAnalytics, analyticsMsg, analyticsColor } = this.state;
    // From props, not state: syncFromProps only runs when props change, so a freshly-toggled value
    // would not reach a state copy until the next settings update.
    const operatorMode = !!(this.props.settings || {}).operatorMode;
    const u = this.props.update;
    const line = this.updateLine();
    const cloud = this.state.cloudBackup || {};
    const backupFingerprints = new Set((this.state.cloudBackups || []).map(item => item.keyFingerprint).filter(Boolean));
    const availableRecoveryKeys = new Set([
      ...(Array.isArray(cloud.keyFingerprints) ? cloud.keyFingerprints : []),
      cloud.keyFingerprint || '',
    ].filter(Boolean));
    const missingBackupFingerprints = [...backupFingerprints].filter(fingerprint => !availableRecoveryKeys.has(fingerprint));
    const needsRecoveryImport = cloud.keyUnavailable || !!this.state.recoveryExpectedFingerprint
      || missingBackupFingerprints.length > 0;
    const requestedRecoveryFingerprint = this.state.recoveryExpectedFingerprint
      || cloud.configuredActiveKeyFingerprint
      || (this.state.cloudBackups[0] && this.state.cloudBackups[0].keyFingerprint)
      || '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          {/* Five clicks on the title toggles the operator sections. A gesture rather than a visible
              switch: a visible one is an invitation, and the point is that a tester never wonders
              what is behind it. Persisted, so it survives a restart once you have opened it. */}
          <div className="page-title" onClick={this.bumpOperatorTaps} style={{ cursor: 'default', userSelect: 'none' }}>
            <span className="page-title-dot" /> Settings
            {operatorMode && <span style={{ fontSize: 11, color: 'var(--ok)', marginLeft: 10, fontWeight: 400 }}>operator</span>}
          </div>
          <div className="page-actions">
            <button className={`btn btn-sm ${saved ? 'btn-success' : 'btn-primary'}`} onClick={this.save}>
              {saved ? '✓ Saved' : 'Save Settings'}
            </button>
          </div>
        </div>

        <div className="page-content">
          <div className="settings-section">
            <div className="settings-section-title">Zyn Account</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                Signed in as <strong style={{ color: 'var(--text)' }}>{licenseEmail || 'your licensed account'}</strong>
              </span>
              {licenseOffline && <span style={{ fontSize: 11, color: 'var(--run)' }}>Offline grace · reconnecting</span>}
              <button className="btn btn-secondary btn-sm" onClick={this.signOut} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
            <div className="license-module-access" data-license-module-access="active">
              <span>Target workspace</span><strong>Enabled</strong>
              <span>Pokémon Center</span>
              <strong className={pokemonCenterAccess ? 'enabled' : 'disabled'}>
                {pokemonCenterAccess ? 'Enabled' : 'Not included'}
              </strong>
              <span>Managed proxies</span><strong className={proxyAccess ? 'enabled' : 'disabled'}>
                {proxyAccess ? `${managedProxyCount} list${managedProxyCount === 1 ? '' : 's'}` : 'Not included'}
              </strong>
            </div>
            <div style={{ marginTop: 8, color: 'var(--dim)', fontSize: 10, lineHeight: 1.45 }}>
              Target, Pokémon Center, and managed proxy access update automatically from your Zyn account.
            </div>
          </div>

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
                  style={{ background: 'var(--ok)', color: '#450a0a', fontWeight: 700 }}
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
              <div className="form-hint">Receives confirmed orders only.</div>
            </div>
            <div className="form-group">
              <label className="form-label">Declined Webhook URL (optional)</label>
              <input
                className="form-input monospace"
                placeholder="https://discord.com/api/webhooks/..."
                value={discordDeclineWebhook}
                onChange={e => this.set('discordDeclineWebhook', e.target.value)}
              />
              <div className="form-hint">
                Receives payment declines separately. Leave blank to disable decline notifications.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Account Generation Webhook URL (optional)</label>
              <input
                className="form-input monospace"
                placeholder="https://discord.com/api/webhooks/..."
                value={accountGenWebhook}
                onChange={e => this.setState({ accountGenWebhook: e.target.value, webhookError: '', saved: false })}
              />
              <div className="form-hint">Receives generated account credentials. It is never used for checkout notifications.</div>
              {webhookError && <div className="form-hint" style={{ color: 'var(--danger)' }}>{webhookError}</div>}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Target — Browser Extension Harvesters</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.45 }}>
              Run the companion in Chrome, Brave, or multiple browser profiles at once. Every copy
              and Zyn&apos;s in-app harvesters feed the same Target cookie bank.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Browser extension harvesting</label>
                <select
                  className="form-input"
                  value={shapeMethod}
                  onChange={e => this.set('shapeMethod', e.target.value)}
                >
                  <option value="In Bot">Off</option>
                  <option value="Harvester">On</option>
                </select>
              </div>
              {shapeMethod === 'Harvester' && (
                <div className="form-group" style={{ flex: 2 }}>
                  <FieldLabel help={`Copy the 32-character ID shown on each browser's extensions page. Add one ID per line (up to ${MAX_HARVESTER_EXTENSION_IDS}); duplicate IDs are stored once.`}>
                    Browser extension IDs
                  </FieldLabel>
                  <textarea
                    className="form-input monospace"
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={'Chrome extension ID\nBrave extension ID'}
                    value={targetHarvesterExtensionIds}
                    aria-invalid={!!extensionIdsError}
                    onChange={e => this.setState({
                      targetHarvesterExtensionIds: e.target.value.toLowerCase(),
                      extensionIdsError: '',
                      saved: false,
                    })}
                  />
                  {extensionIdsError && (
                    <div role="alert" style={{ color: 'var(--danger)', fontSize: 10, marginTop: 5 }}>
                      {extensionIdsError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Operator-only advanced Target harvest settings. Hidden by default because wrong TCINs
              can starve the cookie bank and surface much later as unexplained checkout failures. */}
          {operatorMode && (<>
          {/* These settings are applied on the next farmer spawn. Throughput and bandwidth controls
              use the existing persisted keys so backups remain compatible. */}
          <div className="settings-section">
            <div className="settings-section-title">Target — Shape Cookie Harvest</div>
            <div style={{ fontSize: 11, color: 'var(--ok)', marginBottom: 10 }}>
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
                <FieldLabel help="Ready add-to-cart cookies kept for each active Target task, or configured standby task before a run. Zyn scales the total automatically. Set 0 for no bank limit.">
                  ATC cookies per task
                </FieldLabel>
                <input
                  className="form-input" type="number" min="0" step="1"
                  aria-label="Target ATC cookies per task"
                  value={targetAtcCookiesPerTask}
                  onChange={e => this.set('targetAtcCookiesPerTask', e.target.value)}
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
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <FieldLabel help="The maximum number of distinct signatures banked from one page before the farmer moves on. Default 1 because Target commonly emits one usable signature per page.">
                  Cookies per page load
                </FieldLabel>
                <input
                  className="form-input" type="number" min="1" max={MAX_SHAPE_CAPTURES_PER_LOAD} step="1"
                  value={targetCapturesPerLoad}
                  onChange={e => this.set('targetCapturesPerLoad', e.target.value)}
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <FieldLabel help={`Randomly reuses each browser process for 1–${targetLoadsPerBrowser || 1} page loads. Every load still receives a clean browser context and persona. Default 3.`} helpAlign="right">
                  Page loads per browser
                </FieldLabel>
                <input
                  className="form-input" type="number" min="1" max={MAX_SHAPE_LOADS_PER_BROWSER} step="1"
                  value={targetLoadsPerBrowser}
                  onChange={e => this.set('targetLoadsPerBrowser', e.target.value)}
                />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <div className="checkbox-help-row">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={targetBlockHeavyResources !== false}
                    onChange={e => this.set('targetBlockHeavyResources', e.target.checked)}
                  />
                  Block images, video &amp; fonts while farming
                </label>
                <FieldHelp>Stops bulk image, media, and font downloads through the harvest proxy while leaving documents, stylesheets, scripts, XHR, and Shape telemetry available.</FieldHelp>
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
            <div className="settings-section-title">Pokémon Center</div>
            <div className="form-group" style={{ marginTop: 6, marginBottom: 0 }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={hcaptchaAutosolve !== false}
                  onChange={e => this.set('hcaptchaAutosolve', e.target.checked)}
                />
                AutoSolve hCaptcha
              </label>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                When a Pokémon Center task hits hCaptcha, Zyn tries the local classifier once. If that misses, you take the next challenge. Turn this off to only solve by hand. Models still download at launch so you can turn it back on without waiting.
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Email / OTP</div>
            <div className="form-row" style={{ marginTop: 6 }}>
              <div className="form-group">
                <label className="form-label">AYCD Inbox API Key <span style={{ color: 'var(--accent)', fontWeight: 400 }}>— global first-choice source</span></label>
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
              AYCD Inbox remains a global first-choice source. IMAP credentials now belong to each profile:
              open <strong>Profiles → Edit → Email OTP Mailbox</strong> to give different accounts different mailboxes.
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Backup &amp; Restore</div>
            <div style={{
              border: '1px solid var(--border)', borderRadius: 12, padding: 14, marginBottom: 14,
              background: 'color-mix(in srgb, var(--panel) 88%, transparent)',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ maxWidth: 720 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 700 }}>Encrypted cloud backup</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.55, marginTop: 5 }}>
                    Zyn encrypts your data on this device before sending it to Cloudflare. The server
                    stores only encrypted bytes and never receives your recovery key. Without that key,
                    neither Zyn nor anyone operating the service can restore the backup.
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.5, marginTop: 6 }}>
                    Includes profiles and payment details, site and mailbox passwords, user API keys,
                    local proxy lists, settings, tasks, and task groups. Zyn account/session credentials,
                    browser session cookies, and managed-proxy service credentials are excluded.
                  </div>
                </div>
                {cloud.hasKey && cloud.keyConfirmed && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                    color: cloud.enabled ? 'var(--ok)' : 'var(--muted)',
                  }}>
                    {cloud.enabled ? 'Automatic backups on' : 'Automatic backups off'}
                  </span>
                )}
              </div>

              {cloud.available === false && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 12 }}>
                  Secure operating-system key storage is unavailable, so encrypted backup cannot be enabled.
                </div>
              )}

              {cloud.accountBound === false && (
                <div style={{ fontSize: 11, color: 'var(--run)', marginTop: 12 }}>
                  Reconnect your Zyn account before configuring encrypted backup.
                </div>
              )}

              {cloud.keyUnavailable && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 12, lineHeight: 1.5 }}>
                  This device can no longer unlock its stored recovery key. Import the original recovery
                  key below; Zyn will not silently replace it and orphan your existing backups.
                </div>
              )}

              {cloud.accountBound !== false && cloud.legacyStateAvailable && !cloud.hasKey && (
                <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>
                    An encrypted backup setup from the previous app installation is available on this device.
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={this.claimLegacyCloudBackup} disabled={this.state.cloudLoading}>
                    Use existing backup setup
                  </button>
                </div>
              )}

              {cloud.accountBound !== false && cloud.available !== false && !cloud.hasKey && !cloud.keyUnavailable && (
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={this.setupCloudBackup} disabled={this.state.cloudLoading}>
                    {cloud.legacyStateAvailable ? 'Start fresh with a new recovery key' : 'Create recovery key'}
                  </button>
                </div>
              )}

              {cloud.hasKey && !cloud.keyConfirmed && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--run)', lineHeight: 1.5, marginBottom: 7 }}>
                    Save or copy the recovery key somewhere separate from this computer. For safety,
                    Zyn does not display or return an already-stored key in page data, and never keeps
                    a server-side copy. Copying requires a separate native confirmation.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 9 }}>
                    <button className="btn btn-secondary btn-sm" onClick={this.saveCloudBackupKey}>Save recovery-key file</button>
                    <button className="btn btn-secondary btn-sm" onClick={this.copyCloudBackupKey}>Copy key</button>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginTop: 11, cursor: 'pointer', fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
                    <input
                      type="checkbox"
                      checked={this.state.recoveryAcknowledged}
                      onChange={event => this.setState({ recoveryAcknowledged: event.target.checked })}
                    />
                    I saved the recovery key and understand that my data cannot be restored without it.
                  </label>
                  <button
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={this.enableCloudBackup}
                    disabled={!cloud.recoveryHandled || !this.state.recoveryAcknowledged || this.state.cloudLoading}
                  >
                    Enable &amp; back up now
                  </button>
                </div>
              )}

              {cloud.hasKey && cloud.keyConfirmed && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <select
                      className="form-input"
                      aria-label="Automatic encrypted backup schedule"
                      style={{ width: 190, minHeight: 32, padding: '5px 9px' }}
                      value={cloud.enabled ? Number(cloud.intervalMs) : 0}
                      onChange={this.setCloudBackupSchedule}
                      disabled={cloud.busy || this.state.cloudLoading}
                    >
                      <option value="0">Automatic backup: Off</option>
                      <option value={15 * 60 * 1000}>Every 15 minutes</option>
                      <option value={30 * 60 * 1000}>Every 30 minutes</option>
                      <option value={60 * 60 * 1000}>Every hour</option>
                      <option value={6 * 60 * 60 * 1000}>Every 6 hours</option>
                      <option value={24 * 60 * 60 * 1000}>Every day</option>
                    </select>
                    <button className="btn btn-primary btn-sm" onClick={this.runCloudBackup} disabled={cloud.busy || this.state.cloudLoading}>
                      {cloud.busy ? (cloud.stage || 'Working…') : 'Back up now'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={this.saveCloudBackupKey}>Save recovery-key file</button>
                    <button className="btn btn-secondary btn-sm" onClick={this.copyCloudBackupKey}>Copy key</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                    Last backup: {this.formatBackupDate(cloud.lastBackupAt)}
                    {cloud.lastBackupBytes ? ` · ${this.formatBytes(cloud.lastBackupBytes)}` : ''}
                    {cloud.enabled && cloud.nextBackupAt ? ` · Next: ${this.formatBackupDate(cloud.nextBackupAt)}` : ''}
                    {cloud.keyFingerprint ? ` · Key ${cloud.keyFingerprint}` : ''}
                    {Array.isArray(cloud.keyFingerprints) && cloud.keyFingerprints.length > 1
                      ? ` · ${cloud.keyFingerprints.length} recovery keys stored` : ''}
                  </div>
                  {cloud.lastError && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>Last attempt: {cloud.lastError}</div>
                  )}
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, color: 'var(--text)', fontWeight: 700 }}>Saved backups</div>
                  <button className="btn btn-secondary btn-sm" onClick={this.loadCloudBackups} disabled={this.state.cloudLoading}>Refresh</button>
                </div>
                {this.state.cloudListError && (
                  <div role="alert" style={{ fontSize: 11, color: 'var(--danger)', marginTop: 9 }}>
                    {this.state.cloudBackups.length
                      ? `Could not refresh backups: ${this.state.cloudListError} Showing the last loaded list.`
                      : `Could not load backups: ${this.state.cloudListError}`}
                  </div>
                )}
                {this.state.cloudBackups.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
                    {this.state.cloudBackups.slice(0, CLOUD_BACKUP_VISIBLE).map(this.renderCloudBackupRow)}
                    {this.state.cloudBackups.length > CLOUD_BACKUP_VISIBLE && (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ alignSelf: 'flex-start' }}
                          onClick={() => this.setState(state => ({ cloudOlderBackupsOpen: !state.cloudOlderBackupsOpen }))}
                        >
                          {this.state.cloudOlderBackupsOpen
                            ? 'Hide older backups'
                            : `Show ${this.state.cloudBackups.length - CLOUD_BACKUP_VISIBLE} older backup${this.state.cloudBackups.length - CLOUD_BACKUP_VISIBLE === 1 ? '' : 's'}`}
                        </button>
                        {this.state.cloudOlderBackupsOpen
                          && this.state.cloudBackups.slice(CLOUD_BACKUP_VISIBLE).map(this.renderCloudBackupRow)}
                      </>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                      The last {CLOUD_BACKUP_VISIBLE} backups stay visible. At most {CLOUD_BACKUP_LIST_CAP} are kept.
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 9 }}>
                    {this.state.cloudLoading
                      ? 'Loading backups…'
                      : (this.state.cloudListError
                        ? 'The backup list is unavailable right now.'
                        : (this.state.cloudListLoaded
                          ? 'No encrypted backups saved yet.'
                          : (cloud.accountBound ? 'Backups have not loaded yet.' : 'Sign in to view encrypted backups.')))}
                  </div>
                )}

                {needsRecoveryImport && (this.state.cloudBackups.length > 0 || cloud.keyUnavailable) && (
                  <div style={{ marginTop: 11 }}>
                    <label className="form-label" htmlFor="cloud-backup-recovery-key">
                      Recovery key for {requestedRecoveryFingerprint
                        ? `backup key ${requestedRecoveryFingerprint}`
                        : (this.state.cloudBackups.length ? 'these backups' : 'this device')}
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <input
                        id="cloud-backup-recovery-key"
                        className="form-input monospace"
                        style={{ flex: 1, minWidth: 260 }}
                        type="password"
                        autoComplete="off"
                        placeholder="RCART1.… (existing backup keys remain compatible)"
                        value={this.state.recoveryImport}
                        onChange={event => this.setState({ recoveryImport: event.target.value })}
                      />
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => this.importCloudBackupKey(requestedRecoveryFingerprint)}
                        disabled={!this.state.recoveryImport.trim()}
                      >
                        Import key
                      </button>
                    </div>
                  </div>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', cursor: 'pointer', marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={this.state.cloudRestoreReplace}
                    onChange={event => this.setState({ cloudRestoreReplace: event.target.checked })}
                  />
                  Cloud restore replaces current data (instead of merging)
                </label>
              </div>

              {this.state.cloudMsg && (
                <div style={{ fontSize: 11, color: this.state.cloudMsgColor, marginTop: 9 }}>{this.state.cloudMsg}</div>
              )}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text)', fontWeight: 700, marginBottom: 8 }}>Local file</div>
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
              ⚠ The export is plain text — it holds your card details, site passwords, mailbox passwords, and Discord token. Store it somewhere safe.
            </div>
            {this.state.ioMsg
              ? <div style={{ fontSize: 11, color: this.state.ioColor, marginTop: 6 }}>{this.state.ioMsg}</div>
              : null}
          </div>

          <div className="settings-section settings-danger-section">
            <div className="settings-section-title">Data &amp; Privacy</div>
            <div className="settings-danger-row">
              <div>
                <strong>Clear analytics data</strong>
                <span>Permanently removes checkout history, declines, cart events, spending totals, and chart history for this Zyn account on every device.</span>
              </div>
              <button className="btn btn-danger btn-sm" type="button" onClick={this.clearAnalytics} disabled={clearingAnalytics}>
                <i className="ion-md-trash" style={{ fontSize: 12 }} /> {clearingAnalytics ? 'Deleting…' : 'Clear analytics data'}
              </button>
            </div>
            {analyticsMsg ? <div className="settings-danger-message" style={{ color: analyticsColor }}>{analyticsMsg}</div> : null}
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({ settings: s.settings, update: s.update }))(Settings);
