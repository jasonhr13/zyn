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

function editableField(node) {
  if (!node || typeof node.closest !== 'function') return null;
  return node.closest('input, textarea, select, [contenteditable="true"]');
}

// RDP / Windows Server can leave the frameless window looking focused while Chromium
// is not actually taking keystrokes. Soft-focus on click; bounce the window only when
// the host still is not focused after the click.
export function installWindowsInputFocusGuard(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return false;
  const soft = () => { try { ipcRenderer.send('focusRenderer'); } catch {} };
  const hard = () => { try { ipcRenderer.send('restoreRendererFocus'); } catch {} };

  window.addEventListener('pointerdown', event => {
    if (editableField(event.target)) soft();
  }, true);

  window.addEventListener('focusin', event => {
    if (!editableField(event.target)) return;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) soft();
  }, true);

  window.addEventListener('pointerup', event => {
    const node = editableField(event.target);
    if (!node) return;
    requestAnimationFrame(() => {
      const hostUnfocused = typeof document.hasFocus === 'function' && !document.hasFocus();
      if (!hostUnfocused && document.activeElement === node) return;
      hard();
      try { node.focus({ preventScroll: true }); } catch { try { node.focus(); } catch {} }
    });
  }, true);
  return true;
}
