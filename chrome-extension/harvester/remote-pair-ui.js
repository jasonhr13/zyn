(() => {
  'use strict';

  const remote = globalThis.zynRemoteHarvest || {};
  const STORAGE_KEY = remote.STORAGE_KEY || 'zynHarvesterRemotePairing';
  const SESSION_KEY = remote.SESSION_KEY || 'zynHarvesterLicenseSession';
  const LICENSE_ORIGIN = remote.LICENSE_ORIGIN || 'https://license.zynbot.app';
  const parsePairing = remote.parsePairingInput || (() => null);
  const parseSession = remote.parseSessionRecord || (() => null);
  const licenseDeviceId = remote.licenseDeviceId || (value => String(value || '').replace(/-/g, '').toLowerCase());

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

  function signedInView(signedIn) {
    const form = $('remoteLoginForm');
    const signed = $('remoteSignedIn');
    if (form) form.hidden = signedIn;
    if (signed) signed.hidden = !signedIn;
  }

  async function clientIdentity() {
    try {
      if (typeof globalThis.zynHarvesterClientIdentity === 'function') {
        return await globalThis.zynHarvesterClientIdentity();
      }
    } catch {}
    return { clientId: '', browser: 'Chrome' };
  }

  function load() {
    if (!chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get([STORAGE_KEY, SESSION_KEY], result => {
      const session = parseSession(result && result[SESSION_KEY]);
      const pairing = String(result && result[STORAGE_KEY] || '');
      const pairingInput = $('remotePairInput');
      if (pairingInput) pairingInput.value = pairing;
      if (session) {
        signedInView(true);
        const email = $('remoteSignedEmail');
        if (email) email.textContent = session.email || 'Signed in';
        setStatus('Signed in. This browser deposits into your Full Engine cookie bank when that Zyn is open.', true);
        return;
      }
      signedInView(false);
      const parsed = parsePairing(pairing);
      if (!pairing.trim()) setStatus('Sign in with your Zyn account to harvest into Full Engine. Leave this empty to use a local Zyn on this machine.', null);
      else if (parsed) setStatus('Paired with Full Engine via URL. This browser deposits into the remote cookie bank.', true);
      else setStatus('That pairing URL is not valid.', false);
    });
  }

  async function signIn() {
    const email = String(($('remoteEmail') && $('remoteEmail').value) || '').trim();
    const password = String(($('remotePassword') && $('remotePassword').value) || '');
    if (!email || !password) {
      setStatus('Enter your Zyn email and password.', false);
      return;
    }
    setStatus('Signing in…', null);
    try {
      const identity = await clientIdentity();
      const deviceId = licenseDeviceId(identity.clientId);
      if (!deviceId) {
        setStatus('This browser could not create a device id. Reload the extension and try again.', false);
        return;
      }
      const response = await fetch(`${LICENSE_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          deviceId,
          deviceName: `Zyn Harvester (${identity.browser || 'Chrome'})`,
          sessionKind: 'harvester',
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body || body.ok !== true || !body.licenseToken) {
        setStatus(body.message || 'Unable to sign in.', false);
        return;
      }
      const record = {
        token: body.licenseToken,
        deviceId,
        email: body.email || email,
        origin: LICENSE_ORIGIN,
        expiresAt: Number(body.expiresAt) || 0,
      };
      chrome.storage.local.set({ [SESSION_KEY]: record }, () => {
        const passwordInput = $('remotePassword');
        if (passwordInput) passwordInput.value = '';
        signedInView(true);
        const signedEmail = $('remoteSignedEmail');
        if (signedEmail) signedEmail.textContent = record.email;
        setStatus('Signed in. Connection should show Live once Full Engine is open on this account.', true);
      });
    } catch {
      setStatus('Could not reach Zyn. Check your internet connection.', false);
    }
  }

  function signOut() {
    chrome.storage.local.get([SESSION_KEY], result => {
      const session = parseSession(result && result[SESSION_KEY]);
      const finish = () => {
        chrome.storage.local.remove([SESSION_KEY], () => {
          signedInView(false);
          setStatus('Signed out. This browser will use a local Zyn on this machine if one is running.', null);
        });
      };
      if (!session) {
        finish();
        return;
      }
      fetch(`${session.origin}/api/auth/logout`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.token}`,
          'x-rcart-device-id': session.deviceId,
        },
      }).catch(() => {}).finally(finish);
    });
  }

  function savePairing() {
    const input = $('remotePairInput');
    if (!input) return;
    const value = String(input.value || '').trim();
    if (!value) {
      chrome.storage.local.remove([STORAGE_KEY], () => {
        setStatus('Cleared pairing URL.', null);
      });
      return;
    }
    const parsed = parsePairing(value);
    if (!parsed) {
      setStatus('Paste the zyn://pair URL from Full Engine Settings → Mobile Harvesters.', false);
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
      setStatus('Paired with Full Engine. Connection should show Live once that Zyn is open.', true);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const signInBtn = $('remoteSignIn');
    const signOutBtn = $('remoteSignOut');
    const saveBtn = $('remotePairSave');
    const clearBtn = $('remotePairClear');
    if (signInBtn) signInBtn.addEventListener('click', signIn);
    if (signOutBtn) signOutBtn.addEventListener('click', signOut);
    if (saveBtn) saveBtn.addEventListener('click', savePairing);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const input = $('remotePairInput');
        if (input) input.value = '';
        savePairing();
      });
    }
    const password = $('remotePassword');
    if (password) {
      password.addEventListener('keydown', event => {
        if (event.key === 'Enter') signIn();
      });
    }
    load();
  });
})();
