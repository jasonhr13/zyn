(() => {
  'use strict';

  const STORAGE_KEY = (globalThis.zynRemoteHarvest && globalThis.zynRemoteHarvest.STORAGE_KEY)
    || 'zynHarvesterRemotePairing';
  const parse = globalThis.zynRemoteHarvest && globalThis.zynRemoteHarvest.parsePairingInput
    || (() => null);

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, ok) {
    const el = $('remotePairStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-error', ok === false);
  }

  function load() {
    const input = $('remotePairInput');
    if (!input || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get([STORAGE_KEY], result => {
      const value = String(result && result[STORAGE_KEY] || '');
      input.value = value;
      const parsed = parse(value);
      if (!value.trim()) setStatus('Not paired. Paste a Full Engine pairing URL to harvest into that cookie bank.', null);
      else if (parsed) setStatus('Paired with Full Engine. This browser deposits into the remote cookie bank.', true);
      else setStatus('That pairing URL is not valid.', false);
    });
  }

  function save() {
    const input = $('remotePairInput');
    if (!input) return;
    const value = String(input.value || '').trim();
    if (!value) {
      chrome.storage.local.remove([STORAGE_KEY], () => {
        setStatus('Cleared. This browser will use a local Zyn on this machine if one is running.', null);
      });
      return;
    }
    const parsed = parse(value);
    if (!parsed) {
      setStatus('Paste the zyn://pair URL from Full Engine Settings → Mobile Harvesters.', false);
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
      setStatus('Paired with Full Engine. Connection should show Live once that Zyn is open.', true);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const saveBtn = $('remotePairSave');
    const clearBtn = $('remotePairClear');
    if (!saveBtn || !clearBtn) return;
    saveBtn.addEventListener('click', save);
    clearBtn.addEventListener('click', () => {
      const input = $('remotePairInput');
      if (input) input.value = '';
      save();
    });
    load();
  });
})();
