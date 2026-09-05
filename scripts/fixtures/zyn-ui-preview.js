/* Browser-only sample data. This file is served by preview-zyn-ui.cjs and never
   imported by the application or included in the packaged renderer. */
(() => {
  const params = new URLSearchParams(location.search);
  const empty = params.has('empty');
  const listeners = new Map();
  const now = Date.now();
  const accounts = empty ? [] : Array.from({ length: 8 }, (_, i) => ({ id: `preview-account-${i}`, email: `alex.${i + 1}@example.com`, site: 'target', hasPassword: true, hasSession: i < 5, profileId: `preview-profile-${i}`, groups: [i < 4 ? 'Daily rotation' : 'Reserve'], createdAt: now - 86400000 * (i + 1) }));
  const profiles = accounts.map((account, i) => ({ id: `preview-profile-${i}`, profileName: `Personal ${String(i + 1).padStart(2, '0')}`, profileType: 'target', email: account.email, phone: '2025550100', groups: account.groups, shipping: { firstName: 'Alex', lastName: 'Morgan', address: '100 Example Street', city: 'Portland', state: 'OR', zipcode: '97201', country: 'US' }, cardNumber: '4111111111111111', cardExpMonth: '12', cardExpYear: '2029', cardCvv: '123' }));
  const groups = empty ? [] : ['Weekend restocks', 'Trading card essentials', 'Collector editions'].map((name, i) => ({ id: `preview-group-${i}`, name, site: 'target', skus: ['12345678', '87654321', '23456789'][i], qty: 1, proxyListName: 'Residential pool', createdAt: now, updatedAt: now, tasks: accounts.slice(0, 4 - i).map((account, j) => ({ id: `preview-task-${i}-${j}`, accountId: account.id, profileId: account.profileId, createdAt: now })) }));
  const data = {
    Profiles: profiles, Accounts: accounts, TaskGroups: groups,
    Proxies: { lists: empty ? [] : [{ name: 'Residential pool', count: 25, raw: '192.0.2.1:8080', proxies: ['192.0.2.1:8080'], groups: ['Primary'] }, { name: 'ISP reserve', count: 10, raw: '192.0.2.2:8080', proxies: ['192.0.2.2:8080'], groups: ['Reserve'] }] },
    Settings: { targetHarvesters: [], targetAtcCookiesPerTask: '3', targetHarvestWorkers: '5' },
    Groups: empty ? [] : ['Daily rotation', 'Reserve'], AccountGroups: empty ? [] : ['Daily rotation', 'Reserve'], ProxyGroups: empty ? [] : ['Primary', 'Reserve'],
    TargetProductHistory: [], ProxyTestSummaries: {}, PokemonCenterTasks: {}, WalmartTasks: {}, DiscordStatus: { status: 'disconnected' },
  };
  const license = { ok: !params.has('locked'), email: 'alex@example.com', taskTypes: { pokemoncenter: !params.has('targetOnly'), walmart: !params.has('targetOnly') }, reason: 'Sign in to continue.' };
  const series = empty ? [] : Array.from({ length: 14 }, (_, i) => {
    const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - 13 + i);
    return { day: date.toISOString().slice(0, 10), checkouts: [5, 8, 6, 13, 10, 18, 15, 23, 19, 30, 25, 32, 28, 39][i], declines: i % 4, totalSpentCents: [29900, 44900, 35400, 65400, 53900, 85400, 76900, 102900, 88400, 132400, 114900, 150400, 125900, 175400][i] };
  });
  const orders = empty ? [] : Array.from({ length: 18 }, (_, i) => ({ eventId: `preview-order-${i}`, occurredAt: now - i * 4000000, account: accounts[i % accounts.length].email, profile: profiles[i % profiles.length].profileName, site: ['target', 'pokemoncenter', 'walmart'][i % 3], totalCents: [5499, 8999, 2499][i % 3], orderNumber: `ZY-${482061 + i}`, items: [{ name: ['Pokémon TCG · Elite Trainer Box', 'Pokémon Center · Collector Bundle', 'Trading Card Game · Booster Bundle'][i % 3], quantity: 1, sku: '12345678' }] }));
  function emit(channel, payload) { for (const callback of listeners.get(channel) || []) callback({}, payload); }
  const ipcRenderer = {
    on(channel, fn) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); return this; },
    once(channel, fn) { const callback = (...args) => { this.removeListener(channel, callback); fn(...args); }; return this.on(channel, callback); },
    removeListener(channel, fn) { listeners.get(channel)?.delete(fn); },
    removeAllListeners(channel) { listeners.delete(channel); },
    send() {},
    sendSync(channel, payload) {
      if (channel === 'getAppVersion') return '1.7.45';
      if (channel === 'getEngineInfo') return { installed: '1.2.6', running: '1.2.6' };
      if (channel === 'getChannel') return 'preview';
      if (channel.startsWith('get') && channel.slice(3) in data) return data[channel.slice(3)];
      if (channel.startsWith('save') && channel.slice(4) in data) { data[channel.slice(4)] = payload; return payload; }
      return null;
    },
    async invoke(channel, query = {}) {
      if (channel === 'licenseStatus') return license;
      if (channel === 'runtimeStatus') return { enabled: true, ready: true, state: 'ready' };
      if (channel === 'analyticsDashboard') {
        const rows = series.filter(row => new Date(row.day).getTime() >= (query.from || 0));
        return { ok: true, summary: { checkouts: rows.reduce((sum, row) => sum + row.checkouts, 0), declines: rows.reduce((sum, row) => sum + row.declines, 0), totalSpentCents: rows.reduce((sum, row) => sum + row.totalSpentCents, 0), stuckInCart: empty ? 0 : 3 }, series: rows };
      }
      if (channel === 'analyticsCheckouts') {
        const rows = orders.filter(order => order.occurredAt >= (query.from || 0) && JSON.stringify(order).toLowerCase().includes((query.search || '').toLowerCase()));
        const start = ((query.page || 1) - 1) * (query.pageSize || 12);
        return { ok: true, checkouts: rows.slice(start, start + (query.pageSize || 12)), total: rows.length };
      }
      if (channel === 'targetCookieBank') return { login: 0, atc: 0, proxies: 25, harvesters: [], demand: { effectiveTasks: accounts.length, atcPerTask: 3, targets: { login: accounts.length, atc: accounts.length * 3 } } };
      if (channel === 'cloudBackupStatus') return { enabled: false, state: 'idle' };
      if (channel === 'mobileHarvesterStatus') return { enabled: false, devices: [] };
      if (channel === 'logoutLicense') { emit('licenseStatus', { ok: false }); return { ok: true }; }
      return { ok: false, error: 'Unavailable in the UI preview.', reason: 'Use the desktop app to sign in.', message: 'This preview uses sample data. Tasks and external services are disabled.' };
    },
  };
  window.require = name => {
    if (name !== 'electron') throw new Error(`Preview does not provide ${name}`);
    return { ipcRenderer, process: { platform: /Mac/i.test(navigator.platform) ? 'darwin' : 'win32' }, clipboard: { writeText: text => navigator.clipboard.writeText(text) }, shell: { openExternal() {} } };
  };
})();
