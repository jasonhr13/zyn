// Native alert/confirm/prompt on a frameless Electron window can leave Chromium
// unable to focus text fields until relaunch (common on Windows Server / RDP).

export function wrapNativeDialogs({
  restore,
  confirm,
  alert,
  prompt,
  schedule = fn => setTimeout(fn, 0),
} = {}) {
  const runRestore = () => {
    try { if (typeof restore === 'function') restore(); } catch {}
  };
  const wrap = native => {
    if (typeof native !== 'function') return native;
    return (...args) => {
      try { return native(...args); }
      finally { schedule(runRestore); }
    };
  };
  return {
    confirm: wrap(confirm),
    alert: wrap(alert),
    prompt: wrap(prompt),
  };
}

export function installNativeDialogFocusRestore(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return false;
  const wrapped = wrapNativeDialogs({
    restore: () => ipcRenderer.send('restoreRendererFocus'),
    confirm: window.confirm.bind(window),
    alert: window.alert.bind(window),
    prompt: window.prompt.bind(window),
  });
  window.confirm = wrapped.confirm;
  window.alert = wrapped.alert;
  window.prompt = wrapped.prompt;
  return true;
}
