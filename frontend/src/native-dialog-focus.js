// Native alert/confirm/prompt on a frameless Electron window can leave Chromium
// unable to focus text fields until relaunch (common on Windows Server / RDP).

export const NATIVE_DIALOG_RESTORE_DELAYS_MS = Object.freeze([0, 32, 100]);

export function wrapNativeDialogs({
  restore,
  confirm,
  alert,
  prompt,
  schedule = (fn, ms = 0) => setTimeout(fn, ms),
  restoreDelays = NATIVE_DIALOG_RESTORE_DELAYS_MS,
} = {}) {
  const runRestore = () => {
    try { if (typeof restore === 'function') restore(); } catch {}
  };
  const wrap = native => {
    if (typeof native !== 'function') return native;
    return (...args) => {
      try { return native(...args); }
      finally {
        const delays = Array.isArray(restoreDelays) && restoreDelays.length ? restoreDelays : [0];
        for (const ms of delays) schedule(runRestore, Number(ms) || 0);
      }
    };
  };
  return {
    confirm: wrap(confirm),
    alert: wrap(alert),
    prompt: wrap(prompt),
  };
}

function hostedConfirm(ipcRenderer, message) {
  if (ipcRenderer && typeof ipcRenderer.sendSync === 'function') {
    try { return ipcRenderer.sendSync('nativeConfirm', String(message ?? '')) === true; }
    catch {}
  }
  return window.confirm(message);
}

function hostedAlert(ipcRenderer, message) {
  if (ipcRenderer && typeof ipcRenderer.sendSync === 'function') {
    try {
      ipcRenderer.sendSync('nativeAlert', String(message ?? ''));
      return;
    } catch {}
  }
  window.alert(message);
}

export function installNativeDialogFocusRestore(ipcRenderer) {
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return false;
  const wrapped = wrapNativeDialogs({
    restore: () => ipcRenderer.send('restoreRendererFocus'),
    confirm: message => hostedConfirm(ipcRenderer, message),
    alert: message => hostedAlert(ipcRenderer, message),
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
