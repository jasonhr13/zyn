const $ = (selector) => document.querySelector(selector);
const loginCard = $('#login-card');
const admin = $('#admin');
const logout = $('#logout');
const usersBody = $('#users');
const waitlistBody = $('#waitlist');
let managedProxyLists = [];
let taskTypes = [];

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 4200);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'x-hope-admin': '1',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function formatDate(value) {
  if (!value) return 'Never';
  return new Date(Number(value)).toLocaleString();
}

function button(label, className, action) {
  const element = document.createElement('button');
  element.textContent = label;
  element.className = className || 'secondary';
  element.addEventListener('click', action);
  return element;
}

function cell(row, child) {
  const element = document.createElement('td');
  if (typeof child === 'string') element.textContent = child;
  else element.append(child);
  row.append(element);
  return element;
}

function taskTypeOverrideSelect(user, type) {
  const wrapper = document.createElement('div');
  wrapper.className = 'user-task-type';
  const label = document.createElement('label');
  label.textContent = type.label;
  const select = document.createElement('select');
  const access = user.task_types && user.task_types[type.key] || { override: null, enabled: type.enabledForAll };
  const choices = [
    ['inherit', `Use global (${type.enabledForAll ? 'On' : 'Off'})`],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled'],
  ];
  for (const [value, text] of choices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = access.override == null ? 'inherit' : (access.override ? 'enabled' : 'disabled');
  select.addEventListener('change', async () => {
    const override = select.value === 'inherit' ? null : select.value === 'enabled';
    select.disabled = true;
    try {
      await request(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ taskTypeOverrides: { [type.key]: override } }),
      });
      toast(`${type.label} access updated for ${user.email}.`);
      loadUsers();
    } catch (error) {
      select.disabled = false;
      toast(error.message, true);
    }
  });
  wrapper.append(label, select);
  return wrapper;
}

function renderTaskTypes() {
  const cards = taskTypes.map(type => {
    const card = document.createElement('article');
    card.className = 'task-type-card';
    const identity = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'task-type-name';
    name.textContent = type.label;
    const status = document.createElement('div');
    status.className = 'meta';
    status.textContent = type.enabledForAll ? 'Enabled globally' : 'Off by default';
    identity.append(name, status);
    card.append(
      identity,
      button(type.enabledForAll ? 'Disable global' : 'Enable globally', type.enabledForAll ? 'warning' : 'secondary', async () => {
        const action = type.enabledForAll ? 'Disable' : 'Enable';
        const detail = type.enabledForAll
          ? 'Explicit per-user grants remain enabled.'
          : 'Existing per-user Disabled overrides will be cleared; you can disable individuals afterward.';
        if (!confirm(`${action} ${type.label} globally? ${detail}`)) return;
        try {
          await request(`/api/admin/task-types/${type.key}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabledForAll: !type.enabledForAll }),
          });
          toast(`${type.label} global access ${type.enabledForAll ? 'disabled' : 'enabled'}.`);
          loadUsers();
        } catch (error) { toast(error.message, true); }
      }),
    );
    return card;
  });
  $('#task-types').replaceChildren(...cards);
}

function userRow(user) {
  const row = document.createElement('tr');
  const identity = document.createElement('div');
  const email = document.createElement('div');
  email.className = 'email';
  email.textContent = user.email;
  const created = document.createElement('div');
  created.className = 'meta';
  created.textContent = `Added ${formatDate(user.created_at)}`;
  identity.append(email, created);
  cell(row, identity);

  const status = document.createElement('span');
  status.className = `badge ${user.active ? 'good' : 'bad'}`;
  status.textContent = user.active ? (user.must_reset_password ? 'First login pending' : 'Active') : 'Disabled';
  cell(row, status);

  const taskTypeAccess = document.createElement('div');
  taskTypeAccess.className = 'user-task-types';
  taskTypeAccess.append(...taskTypes.map(type => taskTypeOverrideSelect(user, type)));
  cell(row, taskTypeAccess);

  const proxyAccess = document.createElement('div');
  const proxyBadge = document.createElement('span');
  proxyBadge.className = `badge ${user.proxy_access ? 'good' : ''}`;
  proxyBadge.textContent = user.proxy_access ? 'All lists' : 'None';
  proxyAccess.append(
    proxyBadge,
    button(user.proxy_access ? 'Remove' : 'Grant', 'secondary', async () => {
      await request(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ proxyAccess: !Boolean(user.proxy_access) }),
      });
      toast(`${user.email} ${user.proxy_access ? 'no longer has' : 'now has'} managed proxy access.`);
      loadUsers();
    }),
  );
  proxyAccess.className = 'actions';
  proxyAccess.style.justifyContent = 'flex-start';
  cell(row, proxyAccess);

  const license = document.createElement('div');
  license.textContent = user.active_licenses ? `${user.active_licenses} active` : 'None';
  const login = document.createElement('div');
  login.className = 'meta';
  login.textContent = `Last login: ${formatDate(user.last_login_at)}`;
  license.append(login);
  cell(row, license);
  cell(row, formatDate(user.last_validated_at));

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Download link', 'secondary', async () => {
      if (!confirm(`Generate a new single-use download link for ${user.email}? Any older unused link will stop working.`)) return;
      try {
        const result = await request(`/api/admin/users/${user.id}/download-link`, { method: 'POST' });
        showCredential({
          eyebrow: 'Private distribution',
          title: 'Single-use download link',
          description: `Send this link to ${user.email}. It expires in 7 days and can be unlocked once.`,
          value: result.downloadUrl,
          copiedMessage: 'Download link copied.',
        });
      } catch (error) { toast(error.message, true); }
    }),
    button('Revoke', 'warning', async () => {
      if (!confirm(`Revoke every active license for ${user.email}?`)) return;
      const result = await request(`/api/admin/users/${user.id}/revoke`, { method: 'POST' });
      toast(`Revoked ${result.revoked} license${result.revoked === 1 ? '' : 's'}.`);
      loadUsers();
    }),
    button('New password', 'secondary', async () => {
      if (!confirm(`Generate a new temporary password for ${user.email}? Active licenses will be revoked.`)) return;
      const result = await request(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      showPassword(result.temporaryPassword);
      loadUsers();
    }),
    button(user.active ? 'Disable' : 'Enable', user.active ? 'warning' : 'secondary', async () => {
      await request(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: !user.active }) });
      toast(`${user.email} ${user.active ? 'disabled' : 'enabled'}.`);
      loadUsers();
    }),
    button('Delete', 'danger', async () => {
      if (!confirm(`Permanently delete ${user.email} and all of their licenses?`)) return;
      await request(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      toast(`${user.email} deleted.`);
      loadUsers();
    }),
  );
  cell(row, actions).className = 'actions-cell';
  return row;
}

function showPassword(password) {
  showCredential({
    eyebrow: 'Shown once',
    title: 'Temporary password',
    description: 'Send this to the user securely. They must replace it on first login.',
    value: password,
    copiedMessage: 'Temporary password copied.',
  });
}

function showCredential({ eyebrow, title, description, value, copiedMessage }) {
  $('#credential-eyebrow').textContent = eyebrow;
  $('#credential-title').textContent = title;
  $('#credential-description').textContent = description;
  $('#credential-value').textContent = value;
  $('#copy-credential').dataset.copiedMessage = copiedMessage;
  $('#credential-modal').classList.remove('hidden');
}

async function loadUsers() {
  try {
    const result = await request('/api/admin/users');
    taskTypes = result.taskTypes || [];
    renderTaskTypes();
    usersBody.replaceChildren(...result.users.map(userRow));
    $('#empty').classList.toggle('hidden', result.users.length > 0);
    $('#user-count').textContent = result.users.length;
    $('#license-count').textContent = result.users.reduce((sum, user) => sum + Number(user.active_licenses || 0), 0);
    $('#reset-count').textContent = result.users.filter((user) => user.must_reset_password).length;
    $('#updated-at').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

function invitationText(result) {
  const lines = [
    'You’re invited to Zyn.',
    '',
    `Download: ${result.downloadUrl}`,
    `Email: ${result.user.email}`,
  ];
  if (result.temporaryPassword) lines.push(`Temporary password: ${result.temporaryPassword}`);
  lines.push('', result.temporaryPassword
    ? 'You’ll choose a new password the first time you sign in.'
    : 'Sign in with your existing Zyn password.');
  return lines.join('\n');
}

function waitlistRow(entry) {
  const row = document.createElement('tr');
  const identity = document.createElement('div');
  const email = document.createElement('div');
  email.className = 'email';
  email.textContent = entry.email;
  const activity = document.createElement('div');
  activity.className = 'meta';
  activity.textContent = entry.updated_at > entry.created_at
    ? `Last requested ${formatDate(entry.updated_at)}` : 'First request';
  identity.append(email, activity);
  cell(row, identity);
  cell(row, formatDate(entry.created_at));

  const status = document.createElement('span');
  status.className = `badge ${entry.invited_at ? 'good' : ''}`;
  status.textContent = entry.invited_at ? `Invited ${formatDate(entry.invited_at)}` : 'Waiting';
  cell(row, status);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button(entry.invited_at ? 'New invite' : 'Invite', 'secondary', async () => {
      const verb = entry.invited_at ? 'Generate a new invitation' : 'Invite';
      if (!confirm(`${verb} for ${entry.email}? A new account will be created when needed.`)) return;
      try {
        const result = await request(`/api/admin/waitlist/${entry.id}/invite`, { method: 'POST' });
        showCredential({
          eyebrow: 'Invitation ready',
          title: result.accountCreated ? 'New Zyn account' : 'Zyn invitation',
          description: result.accountCreated
            ? 'Copy and send this complete invitation. The temporary password is shown only here.'
            : 'Copy and send this invitation. This email already has a Zyn account.',
          value: invitationText(result),
          copiedMessage: 'Invitation copied.',
        });
        loadWaitlist();
        loadUsers();
      } catch (error) { toast(error.message, true); }
    }),
    button('Remove', 'danger', async () => {
      if (!confirm(`Remove ${entry.email} from the waiting list? Their Zyn account, if any, will not be deleted.`)) return;
      try {
        await request(`/api/admin/waitlist/${entry.id}`, { method: 'DELETE' });
        toast(`${entry.email} removed from the waiting list.`);
        loadWaitlist();
      } catch (error) { toast(error.message, true); }
    }),
  );
  cell(row, actions).className = 'actions-cell';
  return row;
}

async function loadWaitlist() {
  try {
    const result = await request('/api/admin/waitlist');
    const entries = result.entries || [];
    waitlistBody.replaceChildren(...entries.map(waitlistRow));
    $('#waitlist-empty').classList.toggle('hidden', entries.length > 0);
    $('#waitlist-count').textContent = entries.filter(entry => !entry.invited_at).length;
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

function proxyLineCount(raw) {
  return String(raw || '').split('\n').filter(line => line.trim()).length;
}

function resetProxyForm() {
  $('#proxy-id').value = '';
  $('#proxy-name').value = '';
  $('#proxy-raw').value = '';
  $('#save-proxy').textContent = 'Create proxy list';
  $('#cancel-proxy').classList.add('hidden');
  $('#proxy-line-count').textContent = '0 proxies';
}

function editProxyList(list) {
  $('#proxy-id').value = list.id;
  $('#proxy-name').value = list.name;
  $('#proxy-raw').value = list.raw || '';
  $('#save-proxy').textContent = 'Save changes';
  $('#cancel-proxy').classList.remove('hidden');
  $('#proxy-line-count').textContent = `${proxyLineCount(list.raw)} proxies`;
  $('#proxy-name').focus();
}

function proxyListCard(list) {
  const card = document.createElement('article');
  card.className = 'managed-list';
  const head = document.createElement('div');
  head.className = 'managed-list-head';
  const identity = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'managed-list-name';
  name.textContent = list.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = list.decryptError
    ? `${list.count || 0} proxies · encryption error — replace this list`
    : `${list.count || proxyLineCount(list.raw)} proxies · updated ${formatDate(list.updatedAt)}`;
  identity.append(name, meta);
  head.append(identity);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button('Edit', 'secondary', () => editProxyList(list)),
    button('Delete', 'danger', async () => {
      if (!confirm(`Permanently delete the managed proxy list “${list.name}”?`)) return;
      await request(`/api/admin/proxy-lists/${list.id}`, { method: 'DELETE' });
      if ($('#proxy-id').value === list.id) resetProxyForm();
      toast(`${list.name} deleted.`);
      loadProxyLists();
    }),
  );
  card.append(head, actions);
  return card;
}

function renderProxyLists() {
  $('#proxy-lists').replaceChildren(...managedProxyLists.map(proxyListCard));
  $('#proxy-empty').classList.toggle('hidden', managedProxyLists.length > 0);
  $('#proxy-count').textContent = managedProxyLists.length;
}

async function loadProxyLists() {
  try {
    const result = await request('/api/admin/proxy-lists');
    managedProxyLists = result.proxyLists || [];
    renderProxyLists();
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

function showLogin() {
  loginCard.classList.remove('hidden');
  admin.classList.add('hidden');
  logout.classList.add('hidden');
  $('#admin-password').focus();
}

function showAdmin() {
  loginCard.classList.add('hidden');
  admin.classList.remove('hidden');
  logout.classList.remove('hidden');
  loadUsers();
  loadWaitlist();
  loadProxyLists();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#admin-password').value;
  try {
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#admin-password').value = '';
    showAdmin();
  } catch (error) { toast(error.message, true); }
});

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#new-email').value.trim();
  try {
    const result = await request('/api/admin/users', { method: 'POST', body: JSON.stringify({ email }) });
    $('#new-email').value = '';
    showPassword(result.temporaryPassword);
    loadUsers();
  } catch (error) { toast(error.message, true); }
});

$('#proxy-raw').addEventListener('input', () => {
  const count = proxyLineCount($('#proxy-raw').value);
  $('#proxy-line-count').textContent = `${count} prox${count === 1 ? 'y' : 'ies'}`;
});

$('#proxy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#proxy-id').value;
  const payload = { name: $('#proxy-name').value.trim(), raw: $('#proxy-raw').value };
  try {
    await request(id ? `/api/admin/proxy-lists/${id}` : '/api/admin/proxy-lists', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    toast(`${payload.name} ${id ? 'updated' : 'created'}.`);
    resetProxyForm();
    loadProxyLists();
  } catch (error) { toast(error.message, true); }
});

$('#cancel-proxy').addEventListener('click', resetProxyForm);

$('#copy-credential').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#credential-value').textContent);
    toast($('#copy-credential').dataset.copiedMessage || 'Copied.');
  } catch { toast('Could not copy automatically.', true); }
});
$('#close-modal').addEventListener('click', () => $('#credential-modal').classList.add('hidden'));
$('#refresh').addEventListener('click', () => { loadUsers(); loadWaitlist(); loadProxyLists(); });
logout.addEventListener('click', async () => {
  try { await request('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

request('/api/admin/session').then(showAdmin).catch(showLogin);
