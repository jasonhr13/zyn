(() => {
  const listeners = new Map();
  const emit = (channel, payload) => {
    const list = listeners.get(channel) || [];
    for (const fn of list.slice()) {
      try { fn({}, payload); } catch {}
    }
  };

  const parse = text => {
    try { return JSON.parse(text); } catch { return { ok: false, error: 'invalid ipc response' }; }
  };

  const sync = (channel, args) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ipc/sync', false);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.withCredentials = true;
    xhr.send(JSON.stringify({ channel, args }));
    const body = parse(xhr.responseText || '{}');
    if (xhr.status === 401) return channel === 'licenseStatus' ? { ok: false, reason: 'Sign in to continue.' } : null;
    if (!body.ok && body.error && channel !== 'licenseStatus') return null;
    return body.result;
  };

  const invoke = async (channel, args) => {
    const response = await fetch('/api/ipc/invoke', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error || response.statusText);
      error.result = body.result;
      throw error;
    }
    return body.result;
  };

  const send = (channel, ...args) => {
    fetch('/api/ipc/send', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    }).catch(() => {});
  };

  const ipcRenderer = {
    sendSync(channel, ...args) { return sync(channel, args); },
    invoke(channel, ...args) { return invoke(channel, args); },
    send(channel, ...args) { send(channel, ...args); },
    on(channel, listener) {
      const list = listeners.get(channel) || [];
      list.push(listener);
      listeners.set(channel, list);
      return ipcRenderer;
    },
    once(channel, listener) {
      const wrap = (event, payload) => {
        ipcRenderer.removeListener(channel, wrap);
        listener(event, payload);
      };
      return ipcRenderer.on(channel, wrap);
    },
    removeListener(channel, listener) {
      const list = (listeners.get(channel) || []).filter(item => item !== listener);
      listeners.set(channel, list);
    },
    removeAllListeners(channel) {
      if (channel) listeners.delete(channel);
      else listeners.clear();
    },
  };

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/events`);
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message && message.channel) emit(message.channel, message.payload);
      } catch {}
    };
    socket.onclose = () => setTimeout(connect, 1500);
  };
  connect();

  const electron = {
    ipcRenderer,
    process: { platform: 'linux' },
  };
  window.require = name => {
    if (name === 'electron') return electron;
    throw new Error(`Cannot require '${name}' in the web UI`);
  };
  window.process = window.process || { env: { PUBLIC_URL: '.' }, platform: 'linux' };
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('platform-web');
  });
})();
