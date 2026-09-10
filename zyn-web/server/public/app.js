const token = new URLSearchParams(location.search).get('token')
  || localStorage.getItem('zynWebToken')
  || '';
if (token) localStorage.setItem('zynWebToken', token);
const headers = token ? { authorization: `Bearer ${token}` } : {};

const loginEl = document.getElementById('login');
const workspaceEl = document.getElementById('workspace');
const loginForm = document.getElementById('login-form');
const loginFields = document.getElementById('login-fields');
const resetFields = document.getElementById('reset-fields');
const loginError = document.getElementById('login-error');
const loginTitle = document.getElementById('login-title');
const loginCopy = document.getElementById('login-copy');
const loginSubmit = document.getElementById('login-submit');
const loginBack = document.getElementById('login-back');

let resetMode = false;
let socket = null;
let pollTimer = null;
let state = { groups: [], profiles: [], accounts: [], proxies: [], bank: {}, running: {} };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: { ...headers, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/reset') {
    showLogin(body.error || 'Sign in with your Zyn email and password.');
    throw new Error(body.error || 'unauthorized');
  }
  if (!response.ok || body.ok === false) throw Object.assign(new Error(body.error || response.statusText), body);
  return body;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showError(message) {
  loginError.hidden = !message;
  loginError.textContent = message || '';
}

function setResetMode(on, email = '') {
  resetMode = on === true;
  loginFields.hidden = resetMode;
  resetFields.hidden = !resetMode;
  loginBack.hidden = !resetMode;
  loginTitle.textContent = resetMode ? 'Choose a new password' : 'Sign in to ZynAIO';
  loginCopy.textContent = resetMode
    ? `This is the first sign-in${email ? ` for ${email}` : ''}. Replace the temporary password to continue.`
    : 'Use the same Zyn email and password as the desktop app. This host is Full Engine.';
  loginSubmit.textContent = resetMode ? 'Save password & continue' : 'Sign in';
}

function showLogin(message) {
  workspaceEl.hidden = true;
  loginEl.hidden = false;
  showError(message || '');
  if (socket) {
    socket.close();
    socket = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function showWorkspace() {
  loginEl.hidden = true;
  workspaceEl.hidden = false;
  showError('');
}

function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-tab') === name);
  });
  document.querySelectorAll('[data-panel]').forEach(panel => {
    panel.hidden = panel.getAttribute('data-panel') !== name;
  });
}

function fillProxySelect(select, selected) {
  const lists = state.proxies || [];
  select.innerHTML = `<option value="">Proxy list</option>` + lists.map(list => (
    `<option value="${esc(list.name)}"${list.name === selected ? ' selected' : ''}>${esc(list.name)} (${list.lines})</option>`
  )).join('');
}

function renderRun() {
  document.getElementById('who').textContent = state.email || '';
  document.getElementById('health').textContent = state.engineConnected ? 'engine connected' : 'engine idle';
  const want = state.bank && state.bank.demand && state.bank.demand.targets;
  document.getElementById('bank').textContent = want
    ? `login ${state.bank.login}/${want.login ?? 0} · ATC ${state.bank.atc}/${want.atc ?? 0}`
    : `login ${state.bank.login || 0} · ATC ${state.bank.atc || 0}`;
  const harvest = state.harvest || {};
  document.getElementById('harvest').textContent = harvest.connected
    ? `Harvest room ${harvest.companionCount || 0} companion(s) · ${harvest.extensionCount || 0} extension(s)`
    : (harvest.enabled ? 'Hosting harvest room — waiting for remotes' : 'Harvest room idle');
  const running = new Set(state.running && state.running.target || []);
  document.getElementById('groups').innerHTML = (state.groups || []).map(group => `
    <div class="group">
      <div>
        <strong>${esc(group.name)}</strong>
        <div class="muted">${esc((group.items || []).map(item => item.sku).join(', ') || 'no SKUs')} · ${(group.tasks || []).length} task(s)${running.has(group.tasks && group.tasks[0] && group.tasks[0].id) ? ' · running' : ''}</div>
      </div>
      <button data-start="${esc(group.id)}" type="button">Start</button>
    </div>
  `).join('') || '<p class="muted">No Target groups yet. Restore a backup or create one under Groups.</p>';
  const pokemon = state.pokemon || {};
  document.getElementById('pokemon-meta').textContent =
    `${(pokemon.tasks || []).length} task(s) · ${(pokemon.products || []).filter(p => p.input).length} product(s)`;
  const pending = (state.otp && state.otp.pending) || [];
  document.getElementById('otp-pending').innerHTML = pending.map(item => `
    <div class="item">
      <div>
        <strong>${esc(item.email)}</strong>
        <div class="muted">${esc(item.message || item.phase || 'waiting')}</div>
      </div>
    </div>
  `).join('') || '';
}

function renderGroups() {
  fillProxySelect(document.querySelector('#group-form [name=proxyListName]'), document.querySelector('#group-form [name=proxyListName]').value);
  document.getElementById('group-list').innerHTML = (state.groups || []).map(group => `
    <div class="item">
      <div>
        <strong>${esc(group.name)}</strong>
        <div class="muted">${(group.tasks || []).length} task(s) · qty ${esc(group.qty)} · ${esc(group.proxyListName || 'no proxy')}</div>
      </div>
      <span>
        <button data-edit-group="${esc(group.id)}" type="button">Edit</button>
        <button data-del-group="${esc(group.id)}" type="button">Delete</button>
      </span>
    </div>
  `).join('') || '<p class="muted">No groups</p>';
}

function renderProfiles() {
  document.getElementById('profile-list').innerHTML = (state.profiles || []).map(profile => {
    const card = String((profile.payment && profile.payment.cardNumber) || '').replace(/\s/g, '');
    return `
      <div class="item">
        <div>
          <strong>${esc(profile.profileName || profile.email || profile.id)}</strong>
          <div class="muted">${esc(profile.email || '')}${card ? ` · •••• ${esc(card.slice(-4))}` : ''}</div>
        </div>
        <span>
          <button data-edit-profile="${esc(profile.id)}" type="button">Edit</button>
          <button data-del-profile="${esc(profile.id)}" type="button">Delete</button>
        </span>
      </div>`;
  }).join('') || '<p class="muted">No profiles</p>';
}

function renderAccounts() {
  document.getElementById('account-list').innerHTML = (state.accounts || []).map(account => `
    <div class="item">
      <div>
        <strong>${esc(account.email)}</strong>
        <div class="muted">${esc(account.site || 'target')} · ${account.hasPassword ? 'password saved' : 'no password'} · ${account.hasSession ? 'session' : 'no session'}</div>
      </div>
      <button data-del-account="${esc(account.id)}" type="button">Delete</button>
    </div>
  `).join('') || '<p class="muted">No accounts</p>';
}

function renderProxies() {
  document.getElementById('proxy-list').innerHTML = (state.proxies || []).map(list => `
    <div class="item">
      <div>
        <strong>${esc(list.name)}</strong>
        <div class="muted">${list.lines} line(s)</div>
      </div>
      <span>
        <button data-edit-proxy="${esc(list.name)}" type="button">Edit</button>
        <button data-del-proxy="${esc(list.name)}" type="button">Delete</button>
      </span>
    </div>
  `).join('') || '<p class="muted">No proxy lists</p>';
}

function renderBackup() {
  const backup = state.backup || {};
  document.getElementById('backup-status').textContent = backup.hasKey
    ? `Recovery key on this host · fingerprint ${backup.keyFingerprint || ''}`
    : (backup.accountBound ? 'Signed in — import the desktop recovery key to restore cloud backups' : 'Sign in first');
}

function render(next) {
  state = next;
  renderRun();
  renderGroups();
  renderProfiles();
  renderAccounts();
  renderProxies();
  renderBackup();
}

async function refresh() {
  render(await api('/api/state'));
}

function connectEvents() {
  if (socket) return;
  const events = document.getElementById('events');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  socket.onmessage = event => {
    events.textContent = `${event.data}\n${events.textContent}`.slice(0, 20000);
    try {
      const payload = JSON.parse(event.data);
      if (payload.source === 'otp' && payload.pending) {
        state = { ...state, otp: { pending: payload.pending } };
        renderRun();
      }
    } catch {}
  };
  socket.onclose = () => { socket = null; };
}

async function enterApp() {
  showWorkspace();
  connectEvents();
  await refresh();
  if (!pollTimer) pollTimer = setInterval(() => refresh().catch(() => {}), 5000);
}

function loadGroup(group) {
  const form = document.getElementById('group-form');
  form.id.value = group.id || '';
  form.name.value = group.name || '';
  form.skus.value = (group.items || []).map(item => item.sku).join('\n') || group.skus || '';
  form.qty.value = group.qty || 2;
  form.loopCheckout.checked = group.loopCheckout === true;
  form.useFillerItem.checked = group.useFillerItem === true;
  form.tasksFromAccounts.checked = false;
  fillProxySelect(form.proxyListName, group.proxyListName || '');
}

function loadProfile(profile) {
  const form = document.getElementById('profile-form');
  const shipping = profile.shipping || {};
  const payment = profile.payment || {};
  form.id.value = profile.id || '';
  form.profileName.value = profile.profileName || '';
  form.email.value = profile.email || '';
  form.phone.value = profile.phone || '';
  form.firstName.value = shipping.firstName || '';
  form.lastName.value = shipping.lastName || '';
  form.address.value = shipping.address || '';
  form.address2.value = shipping.address2 || '';
  form.city.value = shipping.city || '';
  form.state.value = shipping.state || '';
  form.zipcode.value = shipping.zipcode || '';
  form.cardName.value = payment.cardName || '';
  form.cardNumber.value = payment.cardNumber || '';
  form.cardMonth.value = payment.cardMonth || '';
  form.cardYear.value = payment.cardYear || '';
  form.cardCvv.value = payment.cardCvv || '';
  form.imapHost.value = (profile.imap && profile.imap.host) || '';
  form.imapUser.value = (profile.imap && profile.imap.user) || '';
  form.imapPass.value = '';
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  loginSubmit.disabled = true;
  try {
    if (resetMode) {
      const newPassword = loginForm.newPassword.value;
      const confirmPassword = loginForm.confirmPassword.value;
      if (newPassword.length < 10) throw new Error('Use a password of at least 10 characters.');
      if (newPassword !== confirmPassword) throw new Error('The new passwords do not match.');
      await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ newPassword }) });
      setResetMode(false);
      await enterApp();
      return;
    }
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: loginForm.email.value,
          password: loginForm.password.value,
        }),
      });
    } catch (error) {
      if (error.requiresPasswordReset) {
        setResetMode(true, error.email || loginForm.email.value);
        loginForm.password.value = '';
        return;
      }
      throw error;
    }
    loginForm.password.value = '';
    await enterApp();
  } catch (error) {
    showError(error.message);
  } finally {
    loginSubmit.disabled = false;
  }
});

loginBack.onclick = () => {
  setResetMode(false);
  showError('');
};

document.getElementById('logout').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setResetMode(false);
  showLogin('');
};

document.getElementById('nav').addEventListener('click', event => {
  const tab = event.target.getAttribute('data-tab');
  if (tab) showTab(tab);
});

document.getElementById('groups').addEventListener('click', async event => {
  const id = event.target.getAttribute('data-start');
  if (!id) return;
  await api(`/api/target/groups/${encodeURIComponent(id)}/start`, { method: 'POST' });
  refresh();
});
document.getElementById('stop-target').onclick = async () => {
  await api('/api/target/stop', { method: 'POST' });
  refresh();
};
document.getElementById('start-pokemon').onclick = async () => {
  await api('/api/pokemon/start', { method: 'POST' });
  refresh();
};
document.getElementById('stop-pokemon').onclick = async () => {
  await api('/api/pokemon/stop', { method: 'POST' });
  refresh();
};
document.getElementById('otp').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  await api('/api/otp', { method: 'POST', body: JSON.stringify(data) });
};

document.getElementById('group-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const body = {
    id: form.id.value || undefined,
    name: form.name.value,
    skus: form.skus.value,
    qty: form.qty.value,
    proxyListName: form.proxyListName.value,
    loopCheckout: form.loopCheckout.checked,
    useFillerItem: form.useFillerItem.checked,
    tasksFromAccounts: form.tasksFromAccounts.checked,
  };
  const path = body.id ? `/api/target/groups/${encodeURIComponent(body.id)}` : '/api/target/groups';
  await api(path, { method: body.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
  form.reset();
  refresh();
};
document.getElementById('group-new').onclick = () => document.getElementById('group-form').reset();
document.getElementById('group-list').addEventListener('click', async event => {
  const edit = event.target.getAttribute('data-edit-group');
  const remove = event.target.getAttribute('data-del-group');
  if (edit) {
    const group = (state.groups || []).find(item => item.id === edit);
    if (group) loadGroup(group);
    showTab('groups');
  }
  if (remove) {
    await api(`/api/target/groups/${encodeURIComponent(remove)}`, { method: 'DELETE' });
    refresh();
  }
});

document.getElementById('profile-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.target;
  const body = {
    id: form.id.value || undefined,
    profileType: 'target',
    profileName: form.profileName.value,
    email: form.email.value,
    phone: form.phone.value,
    billingSameShipping: true,
    shipping: {
      firstName: form.firstName.value,
      lastName: form.lastName.value,
      address: form.address.value,
      address2: form.address2.value,
      city: form.city.value,
      state: form.state.value,
      zipcode: form.zipcode.value,
      country: 'US',
    },
    payment: {
      cardName: form.cardName.value,
      cardNumber: form.cardNumber.value,
      cardMonth: form.cardMonth.value,
      cardYear: form.cardYear.value,
      cardCvv: form.cardCvv.value,
    },
    imap: (form.imapHost.value || form.imapUser.value || form.imapPass.value)
      ? {
        host: form.imapHost.value,
        port: 993,
        user: form.imapUser.value,
        password: form.imapPass.value,
      }
      : undefined,
  };
  const path = body.id ? `/api/profiles/${encodeURIComponent(body.id)}` : '/api/profiles';
  await api(path, { method: body.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
  form.reset();
  refresh();
};
document.getElementById('profile-new').onclick = () => document.getElementById('profile-form').reset();
document.getElementById('profile-list').addEventListener('click', async event => {
  const edit = event.target.getAttribute('data-edit-profile');
  const remove = event.target.getAttribute('data-del-profile');
  if (edit) {
    const profile = (state.profiles || []).find(item => item.id === edit);
    if (profile) loadProfile(profile);
  }
  if (remove) {
    await api(`/api/profiles/${encodeURIComponent(remove)}`, { method: 'DELETE' });
    refresh();
  }
});

document.getElementById('account-bulk').onsubmit = async event => {
  event.preventDefault();
  await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ raw: event.target.raw.value, site: 'target' }),
  });
  event.target.reset();
  refresh();
};
document.getElementById('account-list').addEventListener('click', async event => {
  const id = event.target.getAttribute('data-del-account');
  if (!id) return;
  await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  refresh();
});

document.getElementById('proxy-form').onsubmit = async event => {
  event.preventDefault();
  const name = event.target.name.value;
  await api(`/api/proxies/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ raw: event.target.raw.value }),
  });
  refresh();
};
document.getElementById('proxy-new').onclick = () => document.getElementById('proxy-form').reset();
document.getElementById('proxy-list').addEventListener('click', async event => {
  const edit = event.target.getAttribute('data-edit-proxy');
  const remove = event.target.getAttribute('data-del-proxy');
  if (edit) {
    const list = (state.proxies || []).find(item => item.name === edit);
    const form = document.getElementById('proxy-form');
    form.name.value = list.name;
    form.raw.value = list.raw || '';
  }
  if (remove) {
    await api(`/api/proxies/${encodeURIComponent(remove)}`, { method: 'DELETE' });
    refresh();
  }
});

document.getElementById('backup-key').onsubmit = async event => {
  event.preventDefault();
  const msg = document.getElementById('backup-msg');
  try {
    await api('/api/backup/key', {
      method: 'POST',
      body: JSON.stringify({ recoveryKey: event.target.recoveryKey.value }),
    });
    msg.textContent = 'Recovery key imported.';
    refresh();
  } catch (error) {
    msg.textContent = error.message;
  }
};

document.getElementById('backup-list').onclick = async () => {
  const msg = document.getElementById('backup-msg');
  const view = document.getElementById('backup-list-view');
  try {
    const result = await api('/api/backup/list');
    const mode = document.getElementById('backup-mode').value;
    view.innerHTML = (result.backups || []).map(backup => `
      <div class="item">
        <div>
          <strong>${esc(backup.deviceName || backup.id)}</strong>
          <div class="muted">${esc(new Date(backup.createdAt).toLocaleString())} · ${Math.round((backup.sizeBytes || 0) / 1024)} KB · ${esc(backup.keyFingerprint || '')}</div>
        </div>
        <button data-restore="${esc(backup.id)}" type="button">Restore ${esc(mode)}</button>
      </div>
    `).join('') || '<p class="muted">No cloud backups on this account</p>';
    msg.textContent = '';
  } catch (error) {
    msg.textContent = error.message;
  }
};

document.getElementById('backup-list-view').addEventListener('click', async event => {
  const id = event.target.getAttribute('data-restore');
  if (!id) return;
  const msg = document.getElementById('backup-msg');
  const mode = document.getElementById('backup-mode').value;
  if (!confirm(`Restore this backup (${mode})? Running tasks will stop.`)) return;
  try {
    const result = await api('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backupId: id, mode }) });
    msg.textContent = `Restored. ${JSON.stringify(result.summary || result.preview || {})}`;
    refresh();
  } catch (error) {
    msg.textContent = error.message;
  }
});

document.getElementById('backup-file').onsubmit = async event => {
  event.preventDefault();
  const msg = document.getElementById('backup-msg');
  const file = event.target.file.files[0];
  if (!file) {
    msg.textContent = 'Choose a file.';
    return;
  }
  const mode = document.getElementById('backup-mode').value;
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const asText = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
    let payload = { mode, recoveryKey: event.target.recoveryKey.value };
    if (asText.startsWith('{')) payload.bundle = JSON.parse(asText);
    else {
      let binary = '';
      bytes.forEach(value => { binary += String.fromCharCode(value); });
      payload.rcbBase64 = btoa(binary);
    }
    const result = await api('/api/backup/import', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Imported. ${JSON.stringify(result.summary || {})}`;
    refresh();
  } catch (error) {
    msg.textContent = error.message;
  }
};

api('/api/auth/session').then(session => {
  if (session.signedIn) return enterApp();
  setResetMode(session.requiresPasswordReset === true, session.email);
  showLogin(session.reason && session.reason !== 'Sign in to continue.' ? session.reason : '');
}).catch(error => {
  showLogin(error.message);
});
