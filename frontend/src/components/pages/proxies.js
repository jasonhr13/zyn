import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyCount, proxyName, proxyRef } from '../proxy-options';
import ResiFactoryPanel, { EVOMI_PROVIDER, IPFIST_PROVIDER, RESIFACTORY_PROVIDER } from './resifactory-panel';

const { ipcRenderer } = window.require('electron');

const ALL_PROXY_LISTS = '__all_proxy_lists__';
const MANAGED_PROXIES = '__managed_proxies__';
const UNGROUPED_PROXIES = '__ungrouped_proxies__';
const RESIFACTORY_PROXIES = '__resifactory_proxies__';
const EVOMI_PROXIES = '__evomi_proxies__';
const IPFIST_PROXIES = '__ipfist_proxies__';
const SYSTEM_GROUPS = [ALL_PROXY_LISTS, MANAGED_PROXIES, UNGROUPED_PROXIES, RESIFACTORY_PROXIES, EVOMI_PROXIES, IPFIST_PROXIES];
const FULL_TEST_LIMIT = 250;

function emptyHealth() {
  return {
    ref: '', updatedAt: 0, mode: '', running: false, total: 0, sampled: 0,
    tested: 0, working: 0, failed: 0, invalid: 0, p50: null, p95: null,
    connectP50: null, connectP95: null,
  };
}

function healthLabel(summary) {
  if (!summary) return 'Untested';
  if (summary.running) {
    const of = summary.sampled || summary.total || 0;
    return `Testing ${summary.tested || 0}/${of}`;
  }
  if (!summary.tested) return 'Untested';
  const rate = Math.round((Number(summary.working) || 0) / summary.tested * 100);
  const connect = Number(summary.connectP50);
  const roundTrip = Number(summary.p50);
  if (Number.isFinite(connect) && Number.isFinite(roundTrip)) {
    return `${rate}% · ${Math.round(connect)}/${Math.round(roundTrip)}ms`;
  }
  if (Number.isFinite(roundTrip)) return `${rate}% · ${Math.round(roundTrip)}ms`;
  return `${rate}% working`;
}

function formatLatency(ms) {
  const value = Number(ms);
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '—';
}

function formatTestedAt(value) {
  const at = Number(value);
  if (!at) return '';
  const delta = Date.now() - at;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  return new Date(at).toLocaleString();
}

function listGroups(list) {
  const groups = [
    ...(Array.isArray(list && list.groups) ? list.groups : []),
    list && list.group,
  ].map(value => String(value || '').trim()).filter(Boolean);
  return [...new Set(groups)];
}

function uniqueGroups(groups) {
  const seen = new Set();
  return (Array.isArray(groups) ? groups : []).map(value => String(value || '').trim()).filter(group => {
    const key = group.toLowerCase();
    if (!group || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.localeCompare(right));
}

function inListGroup(list, group) {
  const key = String(group || '').toLowerCase();
  return listGroups(list).some(value => value.toLowerCase() === key);
}

class Proxies extends Component {
  state = {
    groups: [],
    activeGroup: ALL_PROXY_LISTS,
    selected: [],
    query: '',
    msg: '',
    creatingGroup: false,
    newGroupName: '',
    renamingGroup: false,
    renameGroupName: '',
    editorOpen: false,
    editorRef: '',
    editorName: '',
    editorRaw: '',
    inspectRef: '',
    inspectFilter: 'all',
    inspectQuery: '',
    summaries: {},
    report: null,
    testingRef: '',
  };

  componentDidMount() {
    this.refreshGroups();
    this.refreshSummaries();
    ipcRenderer.on('proxyTestProgress', this.onTestProgress);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('proxyTestProgress', this.onTestProgress);
  }

  componentDidUpdate(previous) {
    if (previous.proxies === this.props.proxies) return;
    const refs = new Set(this.lists().map(proxyRef));
    this.setState(state => {
      const selected = state.selected.filter(ref => refs.has(ref));
      const managedAvailable = this.lists().some(list => list.managed);
      const activeGroup = state.activeGroup === MANAGED_PROXIES && !managedAvailable
        ? ALL_PROXY_LISTS : state.activeGroup;
      return selected.length === state.selected.length && activeGroup === state.activeGroup
        ? null : { selected, activeGroup };
    });
  }

  lists = () => ((this.props.proxies && this.props.proxies.lists) || []);
  localLists = () => this.lists().filter(list => !list.managed);
  managedLists = () => this.lists().filter(list => list.managed);
  isCustomGroup = (group = this.state.activeGroup) => Boolean(group && !SYSTEM_GROUPS.includes(group));

  refreshGroups = (preferred = '') => {
    let groups = [];
    try { groups = ipcRenderer.sendSync('getProxyGroups') || []; } catch {}
    if (!groups.length) groups = this.localLists().flatMap(listGroups);
    groups = uniqueGroups(groups);
    this.setState(previous => {
      let activeGroup = preferred || previous.activeGroup || ALL_PROXY_LISTS;
      const system = SYSTEM_GROUPS.includes(activeGroup);
      if (!system && !groups.includes(activeGroup)) activeGroup = ALL_PROXY_LISTS;
      if (activeGroup === MANAGED_PROXIES && !this.managedLists().length) activeGroup = ALL_PROXY_LISTS;
      return { groups, activeGroup };
    });
  };

  refreshCatalog = () => {
    const proxies = ipcRenderer.sendSync('getProxies') || { lists: [] };
    this.props.dispatch({ type: 'update', obj: { proxies } });
    return proxies;
  };

  refreshSummaries = () => {
    let summaries = {};
    try { summaries = ipcRenderer.sendSync('getProxyTestSummaries') || {}; } catch {}
    this.setState({ summaries });
    return summaries;
  };

  onTestProgress = (_event, payload) => {
    const summary = payload && typeof payload === 'object' ? payload : null;
    if (!summary || !summary.ref) return;
    this.setState(state => {
      const next = {
        summaries: { ...state.summaries, [summary.ref]: summary },
        testingRef: summary.running ? summary.ref : (state.testingRef === summary.ref ? '' : state.testingRef),
      };
      if (state.inspectRef === summary.ref) {
        next.report = { ...(state.report || emptyHealth()), ...summary, rows: (state.report && state.report.rows) || [] };
      }
      return next;
    });
    if (!summary.running && this.state.inspectRef === summary.ref) this.refreshReport(summary.ref);
  };

  summaryFor = ref => this.state.summaries[ref] || emptyHealth();

  refreshReport = (ref = this.state.inspectRef) => {
    if (!ref) return null;
    let report = null;
    try { report = ipcRenderer.sendSync('getProxyTestReport', ref); } catch {}
    if (!report || report.error) {
      this.setState({ report: { ...emptyHealth(), ref, rows: [], error: report && report.error } });
      return null;
    }
    this.setState({ report });
    return report;
  };

  openList = list => {
    if (!list) return;
    const ref = proxyRef(list);
    this.setState({
      inspectRef: ref,
      inspectFilter: 'all',
      inspectQuery: '',
      report: null,
    }, () => this.refreshReport(ref));
  };

  closeList = () => this.setState({ inspectRef: '', inspectFilter: 'all', inspectQuery: '', report: null });

  startTest = async (list, mode = 'auto') => {
    if (!list) return;
    const ref = proxyRef(list);
    const count = proxyCount(list);
    if (mode === 'full' && count > FULL_TEST_LIMIT
      && !window.confirm(`Test all ${count.toLocaleString()} proxies in “${proxyName(list)}”? This can take several minutes. A sample of 100 is usually enough on large lists.`)) {
      return;
    }
    this.setState(state => ({
      testingRef: ref,
      summaries: {
        ...state.summaries,
        [ref]: { ...this.summaryFor(ref), ref, running: true, total: count },
      },
    }));
    try {
      const result = await ipcRenderer.invoke('startProxyTest', { ref, mode });
      if (result && result.error && result.ok === false) {
        this.setState({ msg: `Could not test proxies: ${result.error}`, testingRef: '' });
      }
    } catch (error) {
      this.setState({ msg: `Could not test proxies: ${error.message}`, testingRef: '' });
    }
    this.refreshSummaries();
    if (this.state.inspectRef === ref) this.refreshReport(ref);
  };

  stopTest = ref => {
    try { ipcRenderer.sendSync('stopProxyTest', ref); } catch {}
  };

  selectGroup = activeGroup => this.setState({
    activeGroup,
    selected: [],
    query: '',
    renamingGroup: false,
    renameGroupName: '',
    inspectRef: '',
    inspectFilter: 'all',
    inspectQuery: '',
    report: null,
  });

  createGroup = () => {
    const requested = this.state.newGroupName.trim();
    if (!requested) return;
    const result = ipcRenderer.sendSync('createProxyGroup', requested);
    if (!result || result.ok !== true) {
      this.setState({ msg: `Could not create group: ${(result && result.error) || 'unknown error'}` });
      return;
    }
    const group = String(result.group || requested);
    this.setState(previous => ({
      groups: uniqueGroups([...previous.groups, group]),
      activeGroup: group,
      creatingGroup: false,
      newGroupName: '',
      selected: [],
      msg: `Created “${group}”. New proxy lists will be added here.`,
    }));
  };

  startRenameGroup = () => this.setState({
    renamingGroup: true,
    renameGroupName: this.state.activeGroup,
  });

  renameGroup = () => {
    const from = this.state.activeGroup;
    const to = this.state.renameGroupName.trim();
    if (!this.isCustomGroup(from) || !to) return;
    const result = ipcRenderer.sendSync('renameProxyGroup', { from, to });
    if (!result || result.ok !== true) {
      this.setState({ msg: `Could not rename group: ${(result && result.error) || 'unknown error'}` });
      return;
    }
    const group = String(result.group || to);
    this.refreshCatalog();
    this.setState(previous => ({
      groups: uniqueGroups([...previous.groups.filter(value => value !== from), group]),
      activeGroup: group,
      renamingGroup: false,
      renameGroupName: '',
      msg: `Renamed “${from}” to “${group}”.`,
    }));
  };

  deleteGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group)) return;
    const count = this.localLists().filter(list => inListGroup(list, group)).length;
    if (!window.confirm(`Delete the group “${group}”? ${count} proxy list${count === 1 ? '' : 's'} will be kept and moved to Ungrouped unless they belong to another group.`)) return;
    const result = ipcRenderer.sendSync('deleteProxyGroup', group);
    if (!result || result.ok !== true) {
      this.setState({ msg: `Could not delete group: ${(result && result.error) || 'unknown error'}` });
      return;
    }
    this.refreshCatalog();
    this.setState(previous => ({
      groups: previous.groups.filter(value => value !== group),
      activeGroup: UNGROUPED_PROXIES,
      selected: [],
      msg: `Deleted “${group}”. Proxy lists were kept.`,
    }));
  };

  openNewList = () => {
    if (this.state.activeGroup === MANAGED_PROXIES) {
      this.setState({ msg: 'Managed proxy lists are synchronized by Zyn. Choose a local group before creating a list.' });
      return;
    }
    if (this.state.activeGroup === RESIFACTORY_PROXIES || this.state.activeGroup === EVOMI_PROXIES) {
      this.setState({ msg: 'Generate provider lists from the Providers section, or choose a local group to paste your own.' });
      return;
    }
    this.setState({ editorOpen: true, editorRef: '', editorName: '', editorRaw: '' });
  };

  openEditList = list => {
    if (!list || list.managed) return;
    this.setState({
      editorOpen: true,
      editorRef: proxyRef(list),
      editorName: proxyName(list),
      editorRaw: list.raw || '',
    });
  };

  closeEditor = () => this.setState({ editorOpen: false, editorRef: '', editorName: '', editorRaw: '' });

  saveList = () => {
    const name = this.state.editorName.trim();
    const raw = this.state.editorRaw.trim();
    if (!name) return;
    const editing = Boolean(this.state.editorRef);
    const collision = this.localLists().find(list => proxyName(list).toLowerCase() === name.toLowerCase()
      && proxyRef(list) !== this.state.editorRef);
    if (collision) {
      this.setState({ msg: `A proxy list named “${proxyName(collision)}” already exists.` });
      return;
    }
    ipcRenderer.sendSync('saveProxyList', { name, raw });
    if (!editing && this.isCustomGroup()) {
      ipcRenderer.sendSync('addProxyListsToGroup', { refs: [name], group: this.state.activeGroup });
    }
    this.refreshCatalog();
    try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
    this.closeEditor();
    this.refreshGroups(this.state.activeGroup);
    this.setState({ msg: `${editing ? 'Saved' : 'Created'} “${name}”.` });
  };

  deleteList = list => {
    if (!list || list.managed) return;
    const ref = proxyRef(list);
    if (!window.confirm(`Delete the proxy list “${proxyName(list)}”? Tasks that reference it will need another proxy selection.`)) return;
    ipcRenderer.sendSync('deleteProxyList', ref);
    this.refreshCatalog();
    try { ipcRenderer.sendSync('syncTargetHarvesters'); } catch {}
    this.setState(previous => ({
      selected: previous.selected.filter(value => value !== ref),
      msg: `Deleted “${proxyName(list)}”.`,
    }));
  };

  toggleSelected = ref => this.setState(previous => ({
    selected: previous.selected.includes(ref)
      ? previous.selected.filter(value => value !== ref)
      : [...previous.selected, ref],
  }));

  selectShown = lists => {
    const refs = lists.filter(list => !list.managed).map(proxyRef);
    this.setState(previous => {
      const allSelected = refs.length > 0 && refs.every(ref => previous.selected.includes(ref));
      return { selected: allSelected
        ? previous.selected.filter(ref => !refs.includes(ref))
        : [...new Set([...previous.selected, ...refs])] };
    });
  };

  addSelectedToGroup = event => {
    const group = event.target.value;
    event.target.value = '';
    if (!group || !this.state.selected.length) return;
    const result = ipcRenderer.sendSync('addProxyListsToGroup', { refs: this.state.selected, group });
    if (!result || result.ok !== true) {
      this.setState({ msg: `Could not organize proxy lists: ${(result && result.error) || 'unknown error'}` });
      return;
    }
    this.refreshCatalog();
    this.setState({ selected: [], msg: `Added selected proxy lists to “${group}”.` }, () => this.refreshGroups(group));
  };

  removeSelectedFromGroup = () => {
    const group = this.state.activeGroup;
    if (!this.isCustomGroup(group) || !this.state.selected.length) return;
    const result = ipcRenderer.sendSync('removeProxyListsFromGroup', { refs: this.state.selected, group });
    if (!result || result.ok !== true) {
      this.setState({ msg: `Could not remove proxy lists: ${(result && result.error) || 'unknown error'}` });
      return;
    }
    this.refreshCatalog();
    this.setState({ selected: [], msg: `Removed selected proxy lists from “${group}”.` });
  };

  renderGroupItem = (group, count, icon = 'folder') => {
    const active = this.state.activeGroup === group;
    const label = group === ALL_PROXY_LISTS ? 'All Proxy Lists'
      : group === MANAGED_PROXIES ? 'Managed Proxies'
        : group === UNGROUPED_PROXIES ? 'Ungrouped'
          : group === RESIFACTORY_PROXIES ? 'ResiFactory'
            : group === EVOMI_PROXIES ? 'Evomi'
              : group === IPFIST_PROXIES ? 'IPFist' : group;
    return (
      <button type="button" key={group} className={`profile-group-item${active ? ' active' : ''}`} onClick={() => this.selectGroup(group)}>
        <i className={`ion-md-${icon}`} />
        <span>{label}</span>
        {count === '' || count == null ? null : <em>{count}</em>}
      </button>
    );
  };

  inspectList = () => this.lists().find(list => proxyRef(list) === this.state.inspectRef) || null;

  renderInspector() {
    const list = this.inspectList();
    if (!list) return null;
    const { inspectFilter, inspectQuery, report, testingRef } = this.state;
    const summary = { ...this.summaryFor(proxyRef(list)), ...(report || {}) };
    const rows = Array.isArray(report && report.rows) ? report.rows : [];
    const terms = inspectQuery.trim().toLowerCase();
    const shown = rows.filter(row => {
      if (inspectFilter !== 'all' && row.status !== inspectFilter) return false;
      if (terms && !String(row.host || '').toLowerCase().includes(terms)) return false;
      return true;
    });
    const running = testingRef === proxyRef(list) || summary.running;
    const count = proxyCount(list);
    const sampleDefault = count > FULL_TEST_LIMIT;
    return (
      <div className="proxy-inspector">
        <div className="proxy-inspector-toolbar">
          <button type="button" className="btn btn-secondary btn-sm" onClick={this.closeList}>
            ← All lists
          </button>
          <div className="proxy-inspector-heading">
            <h2>{proxyName(list)}</h2>
            <p>
              {count.toLocaleString()} prox{count === 1 ? 'y' : 'ies'}
              {list.managed ? ' · Managed' : ''}
              {summary.mode === 'sample' && summary.tested ? ` · last run sampled ${summary.sampled || summary.tested}` : ''}
              {summary.updatedAt ? ` · ${formatTestedAt(summary.updatedAt)}` : ''}
            </p>
          </div>
          <div className="proxy-inspector-actions">
            {running
              ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.stopTest(proxyRef(list))}>Stop</button>
              : <>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => this.startTest(list, 'auto')}>
                    {sampleDefault ? 'Test sample' : 'Test all'}
                  </button>
                  {sampleDefault && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.startTest(list, 'full')}>
                      Test all
                    </button>
                  )}
                </>}
          </div>
        </div>

        <div className="proxy-inspector-stats">
          <div className="proxy-stat">
            <span>Working</span>
            <strong className="text-success">{summary.working || 0}</strong>
            <small>{summary.tested ? `${Math.round((summary.working || 0) / summary.tested * 100)}% of tested` : 'Run a test first'}</small>
          </div>
          <div className="proxy-stat">
            <span>Failed</span>
            <strong className="text-danger">{summary.failed || 0}</strong>
            <small>{summary.invalid ? `${summary.invalid} invalid line${summary.invalid === 1 ? '' : 's'}` : 'Connect or timeout'}</small>
          </div>
          <div className="proxy-stat">
            <span>Connect</span>
            <strong>{formatLatency(summary.connectP50)}</strong>
            <small>{summary.connectP95 != null ? `p95 ${formatLatency(summary.connectP95)} tunnel to Redsky` : 'Tunnel to Redsky'}</small>
          </div>
          <div className="proxy-stat">
            <span>Round trip</span>
            <strong>{formatLatency(summary.p50)}</strong>
            <small>{summary.p95 != null ? `p95 ${formatLatency(summary.p95)} full request` : 'Full request to Redsky'}</small>
          </div>
          <div className="proxy-stat">
            <span>Coverage</span>
            <strong>{summary.tested || 0}/{summary.sampled || count}</strong>
            <small>{summary.mode === 'sample' ? 'Sampled' : summary.mode === 'full' ? 'Full list' : running ? 'Testing…' : 'Not tested yet'}</small>
          </div>
        </div>

        {running && (
          <div className="proxy-test-progress" aria-live="polite">
            <span>Testing {summary.tested || 0} of {summary.sampled || count}…</span>
            <em style={{ width: `${Math.min(100, Math.round(((summary.tested || 0) / Math.max(1, summary.sampled || count)) * 100))}%` }} />
          </div>
        )}

        <div className="proxy-inspector-filters">
          {['all', 'working', 'failed', 'untested'].map(filter => (
            <button type="button" key={filter}
              className={`proxy-filter${inspectFilter === filter ? ' active' : ''}`}
              onClick={() => this.setState({ inspectFilter: filter })}>
              {filter === 'all' ? 'All' : filter === 'working' ? 'Working' : filter === 'failed' ? 'Failed' : 'Untested'}
            </button>
          ))}
          <div className="profile-search-field proxy-inspector-search">
            <i className="ion-md-search" />
            <input className="form-input" value={inspectQuery} placeholder="Search hosts…"
              onChange={event => this.setState({ inspectQuery: event.target.value })} />
          </div>
        </div>

        <div className="profile-table-wrap proxy-table-wrap">
          <div className="profile-table-head proxy-line-table-head">
            <span>Proxy</span><span>Status</span><span>Connect</span><span>Round trip</span><span>Speed</span>
          </div>
          <div className="profile-table-body proxy-line-table-body">
            {shown.length ? shown.map(row => (
              <div className={`profile-row proxy-line-row status-${row.status}`} key={row.key}>
                <div className="profile-row-cell proxy-row-identity">
                  <strong>{row.host}</strong>
                  <small>{row.error || formatTestedAt(row.testedAt) || 'Not tested'}</small>
                </div>
                <div className="profile-row-cell">
                  <strong className={row.status === 'working' ? 'text-success' : row.status === 'failed' || row.status === 'invalid' ? 'text-danger' : ''}>
                    {row.status === 'working' ? 'Working' : row.status === 'failed' ? 'Failed' : row.status === 'invalid' ? 'Invalid' : 'Untested'}
                  </strong>
                </div>
                <div className="profile-row-cell"><strong>{formatLatency(row.connectMs)}</strong></div>
                <div className="profile-row-cell"><strong>{formatLatency(row.ms)}</strong></div>
                <div className="profile-row-cell"><small>{row.bucket || '—'}</small></div>
              </div>
            )) : (
              <div className="profile-table-empty">
                <span><i className="ion-md-pulse" /></span>
                <h3>{rows.length ? 'No proxies match this filter' : 'No proxy lines yet'}</h3>
                <p>{rows.length ? 'Try All, or run a test to fill working and failed.' : 'Add lines to this list, then test them.'}</p>
              </div>
            )}
          </div>
        </div>
        {report && report.truncated && (
          <div className="proxy-inspector-note">
            Showing {shown.length} of {count.toLocaleString()} lines. Large lists keep the tested sample on screen.
          </div>
        )}
      </div>
    );
  }

  renderEditor() {
    if (!this.state.editorOpen) return null;
    const editing = Boolean(this.state.editorRef);
    const count = this.state.editorRaw.split('\n').filter(line => line.trim()).length;
    return (
      <div className="modal-overlay" onMouseDown={event => event.target === event.currentTarget && this.closeEditor()}>
        <div className="modal proxy-editor-modal" onMouseDown={event => event.stopPropagation()}>
          <div className="modal-header">
            <div><div className="modal-title">{editing ? `Edit ${this.state.editorName}` : 'New Proxy List'}</div><p>One proxy per line. Existing task references remain unchanged when you edit a list.</p></div>
            <button className="modal-close" onClick={this.closeEditor}>×</button>
          </div>
          <div className="modal-body proxy-editor-modal-body">
            <div className="form-group">
              <label className="form-label">List name</label>
              <input className="form-input" autoFocus={!editing} disabled={editing} value={this.state.editorName}
                placeholder="Residential" onChange={event => this.setState({ editorName: event.target.value })} />
              {editing && <div className="form-hint">Names stay fixed so existing tasks and harvesters keep their proxy reference.</div>}
            </div>
            <div className="form-group">
              <label className="form-label">Proxies</label>
              <textarea className="proxy-editor-textarea" autoFocus={editing} spellCheck={false}
                placeholder={'ip:port:user:pass\nip:port:user:pass\n…'} value={this.state.editorRaw}
                onChange={event => this.setState({ editorRaw: event.target.value })} />
              <div className="form-hint">{count} prox{count === 1 ? 'y' : 'ies'} · supports ip:port:user:pass and ip:port</div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={this.closeEditor}>Cancel</button>
            <button className="btn btn-primary" disabled={!this.state.editorName.trim()} onClick={this.saveList}>{editing ? 'Save Changes' : 'Create List'}</button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    const { groups, activeGroup, selected, query } = this.state;
    const lists = this.lists();
    const localLists = this.localLists();
    const managedLists = this.managedLists();
    const scoped = activeGroup === ALL_PROXY_LISTS
      ? lists
      : activeGroup === MANAGED_PROXIES
        ? managedLists
        : activeGroup === UNGROUPED_PROXIES
          ? localLists.filter(list => listGroups(list).length === 0)
          : localLists.filter(list => inListGroup(list, activeGroup));
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.length ? scoped.filter(list => terms.every(term => [
      proxyName(list), list.managed ? 'managed' : 'local', ...listGroups(list), proxyCount(list),
    ].join(' ').toLowerCase().includes(term))) : scoped;
    const selectable = shown.filter(list => !list.managed);
    const allShownSelected = selectable.length > 0 && selectable.every(list => selected.includes(proxyRef(list)));
    const ungroupedCount = localLists.filter(list => listGroups(list).length === 0).length;
    const resiFactory = activeGroup === RESIFACTORY_PROXIES;
    const evomi = activeGroup === EVOMI_PROXIES;
    const ipfist = activeGroup === IPFIST_PROXIES;
    const providerSection = resiFactory || evomi || ipfist;
    const activeLabel = activeGroup === ALL_PROXY_LISTS ? 'All Proxy Lists'
      : activeGroup === MANAGED_PROXIES ? 'Managed Proxies'
        : activeGroup === UNGROUPED_PROXIES ? 'Ungrouped'
          : resiFactory ? 'ResiFactory'
            : evomi ? 'Evomi'
              : ipfist ? 'IPFist' : activeGroup;
    const description = activeGroup === MANAGED_PROXIES
      ? 'Read-only proxy lists synchronized with your Zyn account'
      : resiFactory ? 'Link a key to see remaining GB, generate lists, and add data without leaving Zyn'
        : evomi ? 'Link a key to see remaining data and generate lists. Buy bandwidth on the Evomi dashboard.'
          : ipfist ? 'Link a residential key to see remaining data and generate lists. Buy bandwidth on the IPFist dashboard.'
            : this.isCustomGroup() ? `${scoped.length} proxy list${scoped.length === 1 ? '' : 's'} in this group`
              : activeGroup === ALL_PROXY_LISTS ? 'Every local and managed proxy list'
                : 'Local proxy lists waiting to be assigned to a group';

    return (
      <div className="profiles-workspace proxies-workspace">
        <div className="page-header profiles-page-header">
          <div className="page-title"><span className="page-title-dot" /> Proxies <span className="profiles-total-count">— {lists.length}</span></div>
        </div>

        {this.state.msg && (
          <div className="profiles-notice"><span>{this.state.msg}</span><button type="button" onClick={() => this.setState({ msg: '' })}>Dismiss</button></div>
        )}

        <div className="profiles-shell proxies-shell">
          <aside className="profile-groups-sidebar">
            <div className="profile-groups-sidebar-head">
              <div><span>Proxy groups</span><small>{groups.length} custom group{groups.length === 1 ? '' : 's'}</small></div>
              <button type="button" title="Create proxy group" aria-label="Create proxy group"
                onClick={() => this.setState(previous => ({ creatingGroup: !previous.creatingGroup, newGroupName: '' }))}>
                <i className="ion-md-add" />
              </button>
            </div>

            {this.state.creatingGroup && (
              <div className="profile-group-create">
                <input className="form-input" autoFocus value={this.state.newGroupName} placeholder="Group name"
                  onChange={event => this.setState({ newGroupName: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter') this.createGroup();
                    if (event.key === 'Escape') this.setState({ creatingGroup: false, newGroupName: '' });
                  }} />
                <button className="btn btn-primary btn-sm" disabled={!this.state.newGroupName.trim()} onClick={this.createGroup}>Create</button>
              </div>
            )}

            <nav className="profile-group-nav" aria-label="Proxy groups">
              {this.renderGroupItem(ALL_PROXY_LISTS, lists.length, 'albums')}
              <div className="profile-group-nav-label">Groups</div>
              {groups.length ? groups.map(group => this.renderGroupItem(group, localLists.filter(list => inListGroup(list, group)).length)) : (
                <div className="profile-group-sidebar-empty"><i className="ion-md-folder-open" /><span>No groups yet</span><small>Create one to organize local proxy lists.</small></div>
              )}
              <div className="profile-group-nav-label profile-group-nav-label-secondary">Providers</div>
              {this.renderGroupItem(RESIFACTORY_PROXIES, '', 'flash')}
              {this.renderGroupItem(EVOMI_PROXIES, '', 'globe')}
              {this.renderGroupItem(IPFIST_PROXIES, '', 'wifi')}
              {!!managedLists.length && (
                <><div className="profile-group-nav-label profile-group-nav-label-secondary">Provided by Zyn</div>{this.renderGroupItem(MANAGED_PROXIES, managedLists.length, 'lock')}</>
              )}
              <div className="profile-group-nav-label profile-group-nav-label-secondary">Needs organization</div>
              {this.renderGroupItem(UNGROUPED_PROXIES, ungroupedCount, 'file')}
            </nav>
          </aside>

          <main className="profiles-main">
            {!this.state.inspectRef && <div className="profiles-main-toolbar">
              <div className="profiles-context-copy">
                {this.state.renamingGroup ? (
                  <div className="profile-group-rename">
                    <input className="form-input" autoFocus value={this.state.renameGroupName}
                      onChange={event => this.setState({ renameGroupName: event.target.value })}
                      onKeyDown={event => {
                        if (event.key === 'Enter') this.renameGroup();
                        if (event.key === 'Escape') this.setState({ renamingGroup: false, renameGroupName: '' });
                      }} />
                    <button className="btn btn-primary btn-sm" onClick={this.renameGroup}>Save</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ renamingGroup: false, renameGroupName: '' })}>Cancel</button>
                  </div>
                ) : (
                  <><div className="profiles-context-title"><h2>{activeLabel}</h2>{!providerSection && <span>{scoped.length}</span>}</div><p>{description}</p></>
                )}
              </div>
              <div className="profiles-context-actions">
                {this.isCustomGroup() && !this.state.renamingGroup && (
                  <><button className="profile-context-icon" title="Rename group" onClick={this.startRenameGroup}><i className="ion-md-create" /></button>
                    <button className="profile-context-icon danger" title="Delete group" onClick={this.deleteGroup}><i className="ion-md-trash" /></button></>
                )}
                {!providerSection && !this.state.inspectRef && <div className="profile-search-field"><i className="ion-md-search" /><input className="form-input" value={query}
                  placeholder={`Search ${activeLabel.toLowerCase()}…`} onChange={event => this.setState({ query: event.target.value })} /></div>}
                {!providerSection && !this.state.inspectRef && <button className="btn btn-primary btn-sm" disabled={activeGroup === MANAGED_PROXIES} onClick={this.openNewList}
                  title={activeGroup === MANAGED_PROXIES ? 'Managed proxy lists are synchronized by Zyn' : 'Create a local proxy list'}>
                  <i className="ion-md-add" /> New Proxy List
                </button>}
              </div>
            </div>}

            <div className={`resifactory-host${resiFactory ? '' : ' hidden'}`}>
              <ResiFactoryPanel
                standalone
                provider={RESIFACTORY_PROVIDER}
                onCatalog={proxies => this.props.dispatch({ type: 'update', obj: { proxies } })}
              />
            </div>
            <div className={`resifactory-host${evomi ? '' : ' hidden'}`}>
              <ResiFactoryPanel
                standalone
                provider={EVOMI_PROVIDER}
                onCatalog={proxies => this.props.dispatch({ type: 'update', obj: { proxies } })}
              />
            </div>
            <div className={`resifactory-host${ipfist ? '' : ' hidden'}`}>
              <ResiFactoryPanel
                standalone
                provider={IPFIST_PROVIDER}
                onCatalog={proxies => this.props.dispatch({ type: 'update', obj: { proxies } })}
              />
            </div>
            {!providerSection && !this.state.inspectRef && !!selected.length && (
              <div className="profile-bulk-toolbar">
                <strong>{selected.length} selected</strong>
                <select className="form-select" defaultValue="" onChange={this.addSelectedToGroup}>
                  <option value="" disabled>Add to group…</option>
                  {groups.map(group => <option key={group} value={group}>{group}</option>)}
                </select>
                {this.isCustomGroup() && <button className="btn btn-secondary btn-sm" onClick={this.removeSelectedFromGroup}>Remove from {activeGroup}</button>}
                <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ selected: [] })}>Clear</button>
              </div>
            )}

            {!providerSection && this.state.inspectRef && this.renderInspector()}
            {!providerSection && !this.state.inspectRef && <div className="profile-table-wrap proxy-table-wrap">
              <div className="profile-table-head proxy-list-table-head">
                <label className="profile-row-check"><input type="checkbox" checked={allShownSelected} disabled={!selectable.length} onChange={() => this.selectShown(shown)} /></label>
                <span>Proxy list</span><span>Type</span><span>Proxies</span><span>Health</span><span>Actions</span>
              </div>
              <div className="profile-table-body proxy-list-table-body">
                {shown.length ? shown.map(list => {
                  const ref = proxyRef(list);
                  const isSelected = selected.includes(ref);
                  const health = this.summaryFor(ref);
                  return (
                    <div className={`profile-row proxy-list-row${isSelected ? ' selected' : ''}`} key={ref}
                      onClick={() => this.openList(list)} onDoubleClick={() => this.openEditList(list)}>
                      <label className={`profile-row-check${list.managed ? ' proxy-managed-indicator' : ''}`} onClick={event => event.stopPropagation()}>
                        {list.managed ? <i className="ion-md-lock proxy-managed-lock" title="Managed by Zyn" />
                          : <input type="checkbox" checked={isSelected} onChange={() => { this.toggleSelected(ref); }} />}
                      </label>
                      <div className="profile-row-cell proxy-row-identity"><strong>{proxyName(list)}</strong><small>{list.managed ? 'Synchronized with your Zyn account' : listGroups(list).length ? listGroups(list).join(' · ') : 'Local · ungrouped'}</small></div>
                      <div className="profile-row-cell"><strong className={list.managed ? 'text-success' : ''}>{list.managed ? 'Managed' : 'Local'}</strong><small>{list.managed ? 'Read only' : 'Stored on this device'}</small></div>
                      <div className="profile-row-cell proxy-row-count"><strong>{proxyCount(list).toLocaleString()}</strong><small>available</small></div>
                      <div className="profile-row-cell proxy-row-health">
                        <strong className={health.running ? '' : health.tested && health.failed && !health.working ? 'text-danger' : health.working ? 'text-success' : ''}>
                          {healthLabel(health)}
                        </strong>
                        <small>{health.mode === 'sample' ? 'sampled' : health.tested ? 'tested' : 'open to inspect'}</small>
                      </div>
                      <div className="profile-row-actions" onClick={event => event.stopPropagation()}>
                        <button className="profile-row-action" title={health.running ? 'Stop test' : 'Test proxy latency to Target'}
                          onClick={() => health.running ? this.stopTest(ref) : this.startTest(list, 'auto')}>
                          <i className={health.running ? 'ion-md-square' : 'ion-md-pulse'} />
                        </button>
                        {!list.managed && <><button className="profile-row-action" title="Edit proxy list" onClick={() => this.openEditList(list)}><i className="ion-md-create" /></button>
                          <button className="profile-row-action danger" title="Delete proxy list" onClick={() => this.deleteList(list)}><i className="ion-md-trash" /></button></>}
                      </div>
                    </div>
                  );
                }) : (
                  <div className="profile-table-empty"><span><i className="ion-md-globe" /></span><h3>No proxy lists here</h3><p>{activeGroup === MANAGED_PROXIES ? 'Managed proxy access will appear here when it is available on your Zyn account.' : 'Create a local list or move an existing list into this group.'}</p>{activeGroup !== MANAGED_PROXIES && <button className="btn btn-primary btn-sm" onClick={this.openNewList}>New Proxy List</button>}</div>
                )}
              </div>
            </div>}
          </main>
        </div>
        {this.renderEditor()}
      </div>
    );
  }
}

export default connect(state => ({ proxies: state.proxies }))(Proxies);
