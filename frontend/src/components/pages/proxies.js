import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyCount, proxyLabel, proxyName, proxyRef } from '../proxy-options';
const { ipcRenderer } = window.require('electron');

class Proxies extends Component {
  state = {
    activeList: null,
    editorName: '',
    editorRaw: '',
    isEditing: false,
  };

  componentDidUpdate(prevProps) {
    if (prevProps.proxies === this.props.proxies || !this.state.activeList) return;
    const stillExists = ((this.props.proxies && this.props.proxies.lists) || [])
      .some(list => proxyRef(list) === this.state.activeList);
    if (!stillExists) {
      this.setState({ activeList: null, editorName: '', editorRaw: '', isEditing: false });
    }
  }

  selectList = (list) => {
    this.setState({
      activeList: proxyRef(list),
      editorName: proxyName(list),
      editorRaw: list.managed ? '' : (list.raw || ''),
      isEditing: false,
    });
  };

  newList = () => {
    this.setState({ activeList: null, editorName: '', editorRaw: '', isEditing: true });
  };

  editList = () => this.setState({ isEditing: true });

  save = () => {
    const { editorName, editorRaw } = this.state;
    if (!editorName.trim()) return;
    ipcRenderer.sendSync('saveProxyList', { name: editorName.trim(), raw: editorRaw.trim() });
    const proxies = ipcRenderer.sendSync('getProxies');
    this.props.dispatch({ type: 'update', obj: { proxies } });
    this.setState({ activeList: editorName.trim(), isEditing: false });
  };

  deleteList = (name) => {
    ipcRenderer.sendSync('deleteProxyList', name);
    const proxies = ipcRenderer.sendSync('getProxies');
    this.props.dispatch({ type: 'update', obj: { proxies } });
    if (this.state.activeList === name) {
      this.setState({ activeList: null, editorName: '', editorRaw: '', isEditing: false });
    }
  };

  countLines = (raw) => raw ? raw.split('\n').filter(l => l.trim()).length : 0;

  render() {
    const { proxies } = this.props;
    const { activeList, editorName, editorRaw, isEditing } = this.state;
    const lists = proxies.lists || [];
    const activeData = lists.find(l => proxyRef(l) === activeList);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title">
            <span className="page-title-dot" />
            Proxies
          </div>
          <div className="page-actions">
            <button className="btn btn-primary btn-sm" onClick={this.newList}>
              <i className="ion-md-add" style={{ fontSize: 13 }} /> New List
            </button>
          </div>
        </div>

        <div className="page-content" style={{ overflow: 'hidden', display: 'flex' }}>
          <div className="proxy-layout" style={{ flex: 1, minHeight: 0 }}>
            {/* List panel */}
            <div className="proxy-list-panel">
              <div className="proxy-list-header">
                Lists ({lists.length})
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {lists.length === 0 && (
                  <div style={{ padding: 16, fontSize: 11, color: '#4b5563' }}>No proxy lists yet</div>
                )}
                {lists.map(l => (
                  <div
                    key={proxyRef(l)}
                    className={`proxy-list-item${proxyRef(l) === activeList ? ' active' : ''}`}
                    onClick={() => this.selectList(l)}
                  >
                    <div>
                      <div className="proxy-list-name">{proxyLabel(l)}</div>
                      <div className="proxy-list-count">{proxyCount(l)} proxies</div>
                    </div>
                    {!l.managed && <button
                      className="btn btn-sm btn-danger btn-icon"
                      title="Delete"
                      onClick={e => { e.stopPropagation(); this.deleteList(l.name); }}
                    >
                      <i className="ion-md-trash" style={{ fontSize: 11 }} />
                    </button>}
                  </div>
                ))}
              </div>
            </div>

            {/* Editor panel */}
            <div className="proxy-editor-panel">
              {(!activeList && !isEditing) ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="table-empty">
                    <div className="table-empty-icon"><i className="ion-md-globe" /></div>
                    <div className="table-empty-text">Select or create a proxy list</div>
                    <div className="table-empty-sub">Format: ip:port:user:pass (one per line)</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="proxy-editor-header">
                    {isEditing ? (
                      <>
                        <input
                          className="form-input"
                          style={{ flex: 1 }}
                          placeholder="List name..."
                          value={editorName}
                          onChange={e => this.setState({ editorName: e.target.value })}
                          autoFocus
                        />
                        <button className="btn btn-primary btn-sm" onClick={this.save}>Save</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ isEditing: false, editorName: activeData?.name || '', editorRaw: activeData?.raw || '' })}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span style={{ flex: 1, fontWeight: 600, color: '#d1d5db', fontSize: 13 }}>{proxyLabel(activeData)}</span>
                        <span style={{ fontSize: 11, color: '#6b7280', marginRight: 8 }}>
                          {proxyCount(activeData)} proxies
                        </span>
                        {!activeData?.managed && <button className="btn btn-secondary btn-sm" onClick={this.editList}>
                          <i className="ion-md-create" style={{ fontSize: 12 }} /> Edit
                        </button>}
                      </>
                    )}
                  </div>
                  <div className="proxy-editor-body">
                    {activeData?.managed ? (
                      <div className="table-empty" style={{ margin: 'auto' }}>
                        <div className="table-empty-icon"><i className="ion-md-lock" /></div>
                        <div className="table-empty-text">Managed by rCart</div>
                        <div className="table-empty-sub">
                          This shared list is synchronized with your account and available in proxy selectors.
                        </div>
                      </div>
                    ) : <textarea
                      className="proxy-editor-textarea"
                      placeholder={'ip:port:user:pass\nip:port:user:pass\n...'}
                      value={editorRaw}
                      onChange={e => this.setState({ editorRaw: e.target.value })}
                      readOnly={!isEditing}
                      spellCheck={false}
                    />}
                    {isEditing && !activeData?.managed && (
                      <div style={{ fontSize: 10, color: '#4b5563' }}>
                        {this.countLines(editorRaw)} proxies — Format: <span className="monospace">ip:port:user:pass</span> or <span className="monospace">ip:port</span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}

export default connect(s => ({ proxies: s.proxies }))(Proxies);
