const $ = (selector) => document.querySelector(selector);
const loginCard = $('#login-card');
const admin = $('#admin');
const logout = $('#logout');
const usersBody = $('#users');
const waitlistBody = $('#waitlist');
let managedProxyLists = [];
let taskTypes = [];
const ADMIN_PAGES = new Set(['accounts', 'waiting-list', 'managed-proxies', 'settings', 'analytics']);
const requestedAdminPage = window.location.hash.replace(/^#/, '');
let currentAdminTab = ADMIN_PAGES.has(requestedAdminPage) ? requestedAdminPage : 'accounts';
let analyticsLoaded = false;
const analyticsState = {
  range: 'all',
  metric: 'checkouts',
  series: [],
  usersPage: 1,
  usersPageSize: 20,
  usersTotal: 0,
  userSearch: '',
  historyPage: 1,
  historyPageSize: 20,
  historyTotal: 0,
  checkoutSearch: '',
};

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

function formatCurrency(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format((Number(cents) || 0) / 100);
}

function analyticsWindow() {
  const now = new Date();
  let from = 0;
  if (analyticsState.range === 'today') {
    const localMidnight = new Date(now);
    localMidnight.setHours(0, 0, 0, 0);
    from = localMidnight.getTime();
  } else if (analyticsState.range === '30d') from = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  else if (analyticsState.range === '90d') from = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  return { range: analyticsState.range, from, to: now.getTime() + 1 };
}

function analyticsPath(path, extra = {}) {
  const params = new URLSearchParams({ ...analyticsWindow(), ...extra });
  return `${path}?${params}`;
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

  const billing = document.createElement('div');
  const billingBadge = document.createElement('span');
  const billingStatus = String(user.billing_status || '').trim();
  const accessUntil = Number(user.access_until) || 0;
  if (user.stripe_customer_id || billingStatus || accessUntil) {
    const overdue = accessUntil > 0 && accessUntil <= Date.now();
    billingBadge.className = `badge ${overdue || billingStatus === 'past_due' || billingStatus === 'canceled' ? 'bad' : 'good'}`;
    billingBadge.textContent = overdue
      ? 'Expired'
      : (billingStatus || 'Paid');
    const billingMeta = document.createElement('div');
    billingMeta.className = 'meta';
    billingMeta.textContent = accessUntil
      ? `Access until ${formatDate(accessUntil)}`
      : (user.stripe_customer_id || 'Stripe');
    billing.append(billingBadge, billingMeta);
  } else {
    billingBadge.className = 'badge';
    billingBadge.textContent = 'Admin / beta';
    billing.append(billingBadge);
  }
  cell(row, billing);

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

  const activeDevices = Math.max(0, Number(user.active_licenses) || 0);
  const configuredDeviceLimit = Number(user.max_active_devices);
  const maxActiveDevices = Number.isInteger(configuredDeviceLimit)
    ? Math.min(10, Math.max(1, configuredDeviceLimit))
    : 1;
  const license = document.createElement('div');
  license.className = 'user-device-license';
  const deviceSummary = document.createElement('div');
  deviceSummary.className = 'user-device-summary';
  deviceSummary.textContent = `${activeDevices} of ${maxActiveDevices} active`;
  const deviceLimit = document.createElement('label');
  deviceLimit.className = 'user-device-limit';
  const deviceLimitLabel = document.createElement('span');
  deviceLimitLabel.textContent = 'Device limit';
  const deviceLimitSelect = document.createElement('select');
  deviceLimitSelect.setAttribute('aria-label', `Active-device limit for ${user.email}`);
  for (let value = 1; value <= 10; value += 1) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    deviceLimitSelect.append(option);
  }
  deviceLimitSelect.value = String(maxActiveDevices);
  deviceLimitSelect.addEventListener('change', async () => {
    const nextMaxActiveDevices = Number(deviceLimitSelect.value);
    if (nextMaxActiveDevices < maxActiveDevices && nextMaxActiveDevices < activeDevices) {
      const excessDevices = activeDevices - nextMaxActiveDevices;
      const confirmed = confirm(
        `Lower the active-device limit for ${user.email} from ${maxActiveDevices} to ${nextMaxActiveDevices}? `
        + `This immediately signs out the ${excessDevices} least recently active device${excessDevices === 1 ? '' : 's'}.`,
      );
      if (!confirmed) {
        deviceLimitSelect.value = String(maxActiveDevices);
        return;
      }
    }
    deviceLimitSelect.disabled = true;
    try {
      const result = await request(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxActiveDevices: nextMaxActiveDevices }),
      });
      const revoked = Math.max(0, Number(result.revoked) || 0);
      toast(revoked
        ? `Device limit updated to ${nextMaxActiveDevices} for ${user.email}; ${revoked} device${revoked === 1 ? '' : 's'} signed out.`
        : `Device limit updated to ${nextMaxActiveDevices} for ${user.email}.`);
      deviceLimitSelect.disabled = false;
      loadUsers();
    } catch (error) {
      deviceLimitSelect.value = String(maxActiveDevices);
      deviceLimitSelect.disabled = false;
      toast(error.message, true);
    }
  });
  deviceLimit.append(deviceLimitLabel, deviceLimitSelect);
  const login = document.createElement('div');
  login.className = 'meta';
  login.textContent = `Last login: ${formatDate(user.last_login_at)}`;
  license.append(deviceSummary, deviceLimit, login);
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

function renderHyperCredential(config) {
  const configured = Boolean(config && config.configured);
  const status = $('#hyper-status');
  status.textContent = configured ? 'Configured' : 'Not configured';
  status.className = `badge${configured ? ' good' : ''}`;
  $('#hyper-meta').textContent = configured
    ? `Fingerprint ${config.fingerprint} · updated ${formatDate(config.updatedAt)}. The saved key is never returned here.`
    : 'No key is stored.';
  $('#clear-hyper').classList.toggle('hidden', !configured);
}

async function loadHyperCredential() {
  try {
    renderHyperCredential(await request('/api/admin/service-config/hyper'));
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

function pokemonQueueVersionLabel(config) {
  const version = config && config.version || 'v0.0.50';
  const source = config && config.versionSource === 'github' ? 'PolarAIO/downloads' : 'fallback';
  const checked = config && config.versionCheckedAt ? ` · checked ${formatDate(config.versionCheckedAt)}` : '';
  return `Polar ${version} (${source})${checked}`;
}

function renderPokemonQueueCredential(config) {
  const configured = Boolean(config && config.configured);
  const status = $('#pokemon-queue-status');
  status.textContent = configured ? 'Configured' : 'Not configured';
  status.className = `badge${configured ? ' good' : ''}`;
  const versionLabel = pokemonQueueVersionLabel(config);
  $('#pokemon-queue-meta').textContent = configured
    ? `Fingerprint ${config.fingerprint} · ${versionLabel} · license updated ${formatDate(config.updatedAt)}. The saved license is never returned here.`
    : `No license is stored. ${versionLabel}.`;
  $('#clear-pokemon-queue').classList.toggle('hidden', !configured);
}

async function loadPokemonQueueCredential() {
  try {
    renderPokemonQueueCredential(await request('/api/admin/service-config/pokemon-queue-events'));
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(name, attributes = {}, text = '') {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

function renderAnalyticsChart() {
  const host = $('#analytics-chart');
  const rows = analyticsState.series || [];
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'analytics-chart-empty';
    empty.textContent = 'Analytics will appear here after the first app event.';
    host.replaceChildren(empty);
    return;
  }
  const width = 900;
  const height = 270;
  const margin = { top: 12, right: 16, bottom: 30, left: 56 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const values = rows.map(row => analyticsState.metric === 'spent'
    ? (Number(row.totalSpentCents) || 0) / 100
    : Number(row[analyticsState.metric]) || 0);
  const maximum = Math.max(1, ...values);
  const x = index => margin.left + (rows.length === 1 ? chartWidth / 2 : index * chartWidth / (rows.length - 1));
  const y = value => margin.top + chartHeight - (value / maximum) * chartHeight;
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Global analytics chart' });

  for (let step = 0; step <= 4; step += 1) {
    const value = maximum * (4 - step) / 4;
    const lineY = margin.top + step * chartHeight / 4;
    svg.append(svgNode('line', { x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: 'analytics-chart-grid' }));
    const label = analyticsState.metric === 'spent'
      ? `$${Math.round(value).toLocaleString()}`
      : (Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1));
    svg.append(svgNode('text', { x: margin.left - 9, y: lineY + 4, 'text-anchor': 'end', class: 'analytics-chart-axis' }, label));
  }

  const points = values.map((value, index) => `${x(index)},${y(value)}`);
  const baseline = margin.top + chartHeight;
  svg.append(svgNode('polygon', {
    points: `${margin.left},${baseline} ${points.join(' ')} ${width - margin.right},${baseline}`,
    class: 'analytics-chart-area',
  }));
  svg.append(svgNode('polyline', { points: points.join(' '), class: 'analytics-chart-line' }));

  if (rows.length <= 90) {
    rows.forEach((row, index) => {
      const dot = svgNode('circle', { cx: x(index), cy: y(values[index]), r: 3.2, class: 'analytics-chart-dot' });
      const display = analyticsState.metric === 'spent' ? formatCurrency(row.totalSpentCents) : values[index].toLocaleString();
      dot.append(svgNode('title', {}, `${row.day}: ${display}`));
      svg.append(dot);
    });
  }

  const labelCount = Math.min(6, rows.length);
  const indexes = new Set(Array.from({ length: labelCount }, (_, index) =>
    Math.round(index * (rows.length - 1) / Math.max(1, labelCount - 1))));
  for (const index of indexes) {
    const day = String(rows[index].day || '');
    const date = new Date(`${day}T00:00:00Z`);
    const label = Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: rows.length > 365 ? '2-digit' : undefined, timeZone: 'UTC',
    });
    svg.append(svgNode('text', { x: x(index), y: height - 7, 'text-anchor': 'middle', class: 'analytics-chart-axis' }, label));
  }
  host.replaceChildren(svg);
}

function renderAnalyticsDashboard(result) {
  const summary = result.summary || {};
  $('#analytics-active-users').textContent = Number(summary.activeUsers || 0).toLocaleString();
  $('#analytics-checkouts-count').textContent = Number(summary.checkouts || 0).toLocaleString();
  $('#analytics-declines-count').textContent = Number(summary.declines || 0).toLocaleString();
  $('#analytics-total-spent').textContent = formatCurrency(summary.totalSpentCents);
  $('#analytics-stuck-count').textContent = Number(summary.stuckInCart || 0).toLocaleString();
  $('#analytics-updated-at').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  analyticsState.series = result.series || [];
  renderAnalyticsChart();
}

function analyticsUserRow(user) {
  const row = document.createElement('tr');
  const identity = document.createElement('div');
  identity.className = 'analytics-user-cell';
  const email = document.createElement('div');
  email.className = 'email';
  email.textContent = user.email;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${user.active ? 'Active' : 'Disabled'} · last activity ${formatDate(user.lastEventAt)}`;
  identity.append(email, meta);
  cell(row, identity);
  cell(row, Number(user.checkouts || 0).toLocaleString()).className = 'analytics-value-good';
  cell(row, Number(user.declines || 0).toLocaleString()).className = 'analytics-value-bad';
  cell(row, formatCurrency(user.totalSpentCents));
  cell(row, Number(user.stuckInCart || 0).toLocaleString());
  cell(row, formatDate(user.lastCheckoutAt));
  return row;
}

function renderAnalyticsUsers(result) {
  const users = result.users || [];
  analyticsState.usersTotal = Number(result.total) || 0;
  $('#analytics-users').replaceChildren(...users.map(analyticsUserRow));
  $('#analytics-users-empty').classList.toggle('hidden', users.length > 0);
  $('#analytics-users-count').textContent = `${analyticsState.usersTotal.toLocaleString()} user${analyticsState.usersTotal === 1 ? '' : 's'} with activity`;
  const pages = Math.max(1, Math.ceil(analyticsState.usersTotal / analyticsState.usersPageSize));
  analyticsState.usersPage = Math.min(analyticsState.usersPage, pages);
  $('#analytics-users-page').textContent = `${analyticsState.usersPage} / ${pages}`;
  $('#analytics-users-prev').disabled = analyticsState.usersPage <= 1;
  $('#analytics-users-next').disabled = analyticsState.usersPage >= pages;
}

function analyticsCheckoutRow(checkout) {
  const row = document.createElement('tr');
  const identity = document.createElement('div');
  const email = document.createElement('div');
  email.className = 'email';
  email.textContent = checkout.email;
  identity.append(email);
  cell(row, identity);
  const items = Array.isArray(checkout.items) ? checkout.items : [];
  const first = items[0] || {};
  const item = document.createElement('div');
  item.className = 'analytics-item-name';
  item.textContent = `${first.name || first.sku || 'Checkout'}${items.length > 1 ? ` +${items.length - 1} more` : ''}`;
  item.title = items.map(value => value.name || value.sku).filter(Boolean).join(', ');
  cell(row, item);
  cell(row, checkout.site || '—');
  cell(row, formatDate(checkout.occurredAt));
  cell(row, checkout.orderNumber || '—');
  cell(row, formatCurrency(checkout.totalCents)).className = 'analytics-value-good';
  return row;
}

function renderAnalyticsHistory(result) {
  const checkouts = result.checkouts || [];
  analyticsState.historyTotal = Number(result.total) || 0;
  $('#analytics-history').replaceChildren(...checkouts.map(analyticsCheckoutRow));
  $('#analytics-history-empty').classList.toggle('hidden', checkouts.length > 0);
  $('#analytics-history-count').textContent = `${analyticsState.historyTotal.toLocaleString()} checkout${analyticsState.historyTotal === 1 ? '' : 's'}`;
  const pages = Math.max(1, Math.ceil(analyticsState.historyTotal / analyticsState.historyPageSize));
  analyticsState.historyPage = Math.min(analyticsState.historyPage, pages);
  $('#analytics-history-page').textContent = `${analyticsState.historyPage} / ${pages}`;
  $('#analytics-history-prev').disabled = analyticsState.historyPage <= 1;
  $('#analytics-history-next').disabled = analyticsState.historyPage >= pages;
}

async function loadAnalytics() {
  const refresh = $('#analytics-refresh');
  refresh.disabled = true;
  refresh.textContent = 'Loading…';
  try {
    const [dashboard, users, history] = await Promise.all([
      request(analyticsPath('/api/admin/analytics/dashboard')),
      request(analyticsPath('/api/admin/analytics/users', {
        page: analyticsState.usersPage, pageSize: analyticsState.usersPageSize, search: analyticsState.userSearch,
      })),
      request(analyticsPath('/api/admin/analytics/checkouts', {
        page: analyticsState.historyPage, pageSize: analyticsState.historyPageSize, search: analyticsState.checkoutSearch,
      })),
    ]);
    renderAnalyticsDashboard(dashboard);
    renderAnalyticsUsers(users);
    renderAnalyticsHistory(history);
    analyticsLoaded = true;
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh';
  }
}

async function loadAnalyticsUsers() {
  try {
    renderAnalyticsUsers(await request(analyticsPath('/api/admin/analytics/users', {
      page: analyticsState.usersPage, pageSize: analyticsState.usersPageSize, search: analyticsState.userSearch,
    })));
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

async function loadAnalyticsHistory() {
  try {
    renderAnalyticsHistory(await request(analyticsPath('/api/admin/analytics/checkouts', {
      page: analyticsState.historyPage, pageSize: analyticsState.historyPageSize, search: analyticsState.checkoutSearch,
    })));
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
}

function setAdminTab(name, { updateHash = true } = {}) {
  currentAdminTab = ADMIN_PAGES.has(name) ? name : 'accounts';
  document.querySelectorAll('[data-admin-tab]').forEach(element => {
    element.classList.toggle('active', element.dataset.adminTab === currentAdminTab);
  });
  document.querySelectorAll('[data-admin-page]').forEach(element => {
    element.classList.toggle('hidden', element.dataset.adminPage !== currentAdminTab);
  });
  if (updateHash && window.location.hash !== `#${currentAdminTab}`) {
    window.history.replaceState(null, '', `#${currentAdminTab}`);
  }
  if (currentAdminTab === 'analytics' && !analyticsLoaded) loadAnalytics();
}

function showLogin() {
  loginCard.classList.remove('hidden');
  admin.classList.add('hidden');
  logout.classList.add('hidden');
  analyticsLoaded = false;
  $('#admin-password').focus();
}

function showAdmin() {
  loginCard.classList.add('hidden');
  admin.classList.remove('hidden');
  logout.classList.remove('hidden');
  loadUsers();
  loadWaitlist();
  loadProxyLists();
  loadHyperCredential();
  loadPokemonQueueCredential();
  setAdminTab(currentAdminTab);
}

document.querySelectorAll('[data-admin-tab]').forEach(element => {
  element.addEventListener('click', () => setAdminTab(element.dataset.adminTab));
});

window.addEventListener('hashchange', () => {
  const page = window.location.hash.replace(/^#/, '');
  if (ADMIN_PAGES.has(page)) setAdminTab(page, { updateHash: false });
});

document.querySelectorAll('[data-analytics-range]').forEach(element => {
  element.addEventListener('click', () => {
    analyticsState.range = element.dataset.analyticsRange;
    analyticsState.usersPage = 1;
    analyticsState.historyPage = 1;
    document.querySelectorAll('[data-analytics-range]').forEach(candidate => {
      candidate.classList.toggle('active', candidate === element);
    });
    loadAnalytics();
  });
});

document.querySelectorAll('[data-analytics-metric]').forEach(element => {
  element.addEventListener('click', () => {
    analyticsState.metric = element.dataset.analyticsMetric;
    document.querySelectorAll('[data-analytics-metric]').forEach(candidate => {
      candidate.classList.toggle('active', candidate === element);
    });
    renderAnalyticsChart();
  });
});

$('#analytics-refresh').addEventListener('click', loadAnalytics);
$('#analytics-user-search').addEventListener('input', (event) => {
  analyticsState.userSearch = event.target.value.trim();
  analyticsState.usersPage = 1;
  clearTimeout(loadAnalyticsUsers.timer);
  loadAnalyticsUsers.timer = setTimeout(loadAnalyticsUsers, 250);
});
$('#analytics-checkout-search').addEventListener('input', (event) => {
  analyticsState.checkoutSearch = event.target.value.trim();
  analyticsState.historyPage = 1;
  clearTimeout(loadAnalyticsHistory.timer);
  loadAnalyticsHistory.timer = setTimeout(loadAnalyticsHistory, 250);
});
$('#analytics-users-prev').addEventListener('click', () => {
  if (analyticsState.usersPage <= 1) return;
  analyticsState.usersPage -= 1;
  loadAnalyticsUsers();
});
$('#analytics-users-next').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(analyticsState.usersTotal / analyticsState.usersPageSize));
  if (analyticsState.usersPage >= pages) return;
  analyticsState.usersPage += 1;
  loadAnalyticsUsers();
});
$('#analytics-history-prev').addEventListener('click', () => {
  if (analyticsState.historyPage <= 1) return;
  analyticsState.historyPage -= 1;
  loadAnalyticsHistory();
});
$('#analytics-history-next').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(analyticsState.historyTotal / analyticsState.historyPageSize));
  if (analyticsState.historyPage >= pages) return;
  analyticsState.historyPage += 1;
  loadAnalyticsHistory();
});

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

$('#hyper-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiKey = $('#hyper-api-key').value.trim();
  try {
    const result = await request('/api/admin/service-config/hyper', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    });
    $('#hyper-api-key').value = '';
    renderHyperCredential(result);
    toast('Hyper API key encrypted and saved.');
  } catch (error) { toast(error.message, true); }
});

$('#clear-hyper').addEventListener('click', async () => {
  if (!confirm('Remove the Hyper API key? Pokémon Center requests will stop until a new key is saved.')) return;
  try {
    const result = await request('/api/admin/service-config/hyper', { method: 'DELETE' });
    $('#hyper-api-key').value = '';
    renderHyperCredential(result);
    toast('Hyper API key removed.');
  } catch (error) { toast(error.message, true); }
});

$('#pokemon-queue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const licenseKey = $('#pokemon-queue-license').value.trim();
  try {
    const result = await request('/api/admin/service-config/pokemon-queue-events', {
      method: 'PUT',
      body: JSON.stringify({ licenseKey }),
    });
    $('#pokemon-queue-license').value = '';
    renderPokemonQueueCredential(result);
    toast('Queue event license encrypted and saved.');
  } catch (error) { toast(error.message, true); }
});

$('#refresh-pokemon-queue-version').addEventListener('click', async () => {
  try {
    const result = await request('/api/admin/service-config/pokemon-queue-events/refresh-version', {
      method: 'POST',
    });
    renderPokemonQueueCredential(result);
    toast(result.message || 'Checked Polar release.');
  } catch (error) {
    if (error.status === 401) showLogin();
    else toast(error.message, true);
  }
});

$('#clear-pokemon-queue').addEventListener('click', async () => {
  if (!confirm('Remove the queue event license? HTTPS fallback monitoring will remain available.')) return;
  try {
    const result = await request('/api/admin/service-config/pokemon-queue-events', { method: 'DELETE' });
    $('#pokemon-queue-license').value = '';
    renderPokemonQueueCredential(result);
    toast('Queue event license removed.');
  } catch (error) { toast(error.message, true); }
});

$('#copy-credential').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#credential-value').textContent);
    toast($('#copy-credential').dataset.copiedMessage || 'Copied.');
  } catch { toast('Could not copy automatically.', true); }
});
$('#close-modal').addEventListener('click', () => $('#credential-modal').classList.add('hidden'));
$('#refresh').addEventListener('click', loadUsers);
$('#refresh-waitlist').addEventListener('click', loadWaitlist);
$('#refresh-proxies').addEventListener('click', loadProxyLists);
logout.addEventListener('click', async () => {
  try { await request('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

request('/api/admin/session').then(showAdmin).catch(showLogin);
