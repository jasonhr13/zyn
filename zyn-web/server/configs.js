'use strict';

const engineContract = require('../../launcher/native-engine-contract');
const { displayProxyGroup, resolveProxyAssignment } = require('../../launcher/proxy-resolve');
const { accountCreds, decryptSecret } = require('./secrets');

function decodePaymentField(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  try {
    if (text.startsWith('b64:') || text.startsWith('enc:')) return decryptSecret(text);
  } catch {
    return '';
  }
  return text;
}

function normalizeCountry(value) {
  const text = String(value || '').trim();
  if (!text || /^united states$|^usa$|^us$/i.test(text)) return 'US';
  return text;
}

function parseProxyLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const stripped = text.replace(/^(https?|socks5h?|socks4a?):\/\//i, '');
  const at = stripped.lastIndexOf('@');
  if (at > 0) {
    const cred = stripped.slice(0, at);
    const hostPort = stripped.slice(at + 1).split(':');
    if (hostPort.length < 2) return null;
    const colon = cred.indexOf(':');
    return {
      address: hostPort[0],
      port: hostPort[1],
      username: colon >= 0 ? cred.slice(0, colon) : cred,
      password: colon >= 0 ? cred.slice(colon + 1) : '',
    };
  }
  const parts = stripped.split(':');
  if (parts.length < 2) return null;
  return {
    address: parts[0],
    port: parts[1],
    username: parts[2] || '',
    password: parts.slice(3).join(':'),
  };
}

function buildProfile(profile, accountId) {
  if (!profile) return null;
  const shipping = profile.shipping || {};
  const billing = profile.billingSameShipping === false ? (profile.billing || {}) : shipping;
  const payment = profile.payment || {};
  return {
    id: String(profile.id),
    profileGroup: profile.group || (Array.isArray(profile.groups) ? profile.groups[0] : '') || '',
    profileName: profile.profileName || profile.email || 'profile',
    email: profile.email || '',
    phone: profile.phone || '',
    shippingFirstName: shipping.firstName || '',
    shippingLastName: shipping.lastName || '',
    shippingAddress1: shipping.address || '',
    shippingAddress2: shipping.address2 || '',
    shippingCity: shipping.city || '',
    shippingState: shipping.state || '',
    shippingZip: shipping.zipcode || shipping.zip || '',
    shippingCountry: normalizeCountry(shipping.country),
    billingFirstName: billing.firstName || shipping.firstName || '',
    billingLastName: billing.lastName || shipping.lastName || '',
    billingAddress1: billing.address || '',
    billingAddress2: billing.address2 || '',
    billingCity: billing.city || '',
    billingState: billing.state || '',
    billingZip: billing.zipcode || billing.zip || '',
    billingCountry: normalizeCountry(billing.country),
    cardName: payment.cardName || `${shipping.firstName || ''} ${shipping.lastName || ''}`.trim(),
    cardNumber: decodePaymentField(payment.cardNumber).replace(/\s+/g, ''),
    cardExpiryMonth: String(payment.cardMonth || '').padStart(2, '0'),
    cardExpiryYear: String(payment.cardYear || '').slice(-2),
    cardCvv: decodePaymentField(payment.cardCvv),
    account: accountId ? String(accountId) : '',
  };
}

function buildAccount(account) {
  const creds = accountCreds(account);
  if (!creds) return null;
  return {
    id: String(account.id),
    accountGroup: '',
    type: account.site || 'target',
    username: creds.email,
    password: creds.password,
    cookie: creds.cookie || '',
  };
}

function buildProxyMap(store, listName) {
  const map = {};
  const resolved = resolveProxyAssignment(listName, {
    getProxyLines: name => store.getProxyLines(name),
    getProxies: () => store.getProxies(),
  });
  for (const source of resolved.sources || []) {
    const rows = (source.lines || []).map(parseProxyLine).filter(Boolean);
    if (rows.length) map[source.name] = rows;
  }
  return map;
}

function engineItems(items, qty) {
  return (items || []).map(item => ({
    monitorInput: item.sku || item.monitorInput,
    quantity: String(qty || 2),
    maxPrice: item.maxPrice || '',
    priority: item.priority === true,
  }));
}

function proxySourceNames(store, ref) {
  return resolveProxyAssignment(ref, {
    getProxyLines: name => store.getProxyLines(name),
    getProxies: () => store.getProxies(),
  }).sources.map(source => source.name);
}

function targetStartMessages(group, store) {
  const items = engineItems(group.items, group.qty);
  return (group.tasks || []).map(task => ({
    id: task.id,
    type: 'Target',
    site: 'Target',
    taskGroup: '',
    monitorDelay: '3000',
    retryDelay: '3000',
    proxyGroup: displayProxyGroup(task.proxyListName || group.proxyListName),
    proxySources: store ? proxySourceNames(store, task.proxyListName || group.proxyListName) : [],
    profileId: task.profileId || '',
    profileGroup: '',
    accountId: task.accountId || '',
    item: items,
    monitorItems: items,
    status: '',
    mode: 'Checkout',
    minPrice: '',
    maxPrice: '',
    running: true,
    loopCheckout: task.loopCheckout === true,
    waitForQueue: false,
    QueueEntryDelay: '0',
    allInstock: false,
    endless: task.loopCheckout === true,
    useFillerItem: group.useFillerItem === true,
    useOtpLogin: true,
    startSchedule: '',
    stopSchedule: '',
    ignoreLowStock: group.stockConfidence === 'confirmed-10-plus',
  }));
}

function pokemonStartMessages(state) {
  const products = (state.products || [])
    .map(product => ({
      input: String(product.input || '').trim(),
      quantity: String(product.quantity || state.quantity || '1'),
    }))
    .filter(product => product.input);
  const items = products.map(product => ({
    id: product.input,
    monitorInput: product.input,
    quantity: product.quantity,
    maxPrice: '',
  }));
  return (state.tasks || []).filter(task => task && task.id && task.profileId).map(task => engineContract.normalizeStartTask({
    id: String(task.id),
    type: engineContract.SITES.POKEMON_CENTER_US,
    site: engineContract.SITES.POKEMON_CENTER_US,
    monitorDelay: String(state.monitorDelay || '3000'),
    retryDelay: String(state.retryDelay || '3000'),
    proxyGroup: String(task.proxyListName || '').trim() || 'Local',
    profileId: String(task.profileId),
    profileGroup: '',
    accountId: '',
    item: items,
    monitorItems: items,
    mode: 'Default',
    running: true,
    loopCheckout: !!state.loopCheckout,
    waitForQueue: !!state.waitForQueue,
    QueueEntryDelay: String(state.queueEntryDelay || '0'),
    allInstock: !!state.allInstock,
  }));
}

function sendConfigsPayload(store, tasks) {
  const settings = store.getSettings();
  const profiles = {};
  const accounts = {};
  const proxies = {};
  const profileRows = store.getProfiles();
  const accountRows = store.getAccountsRaw();
  for (const list of store.getProxies().lists || []) {
    if (list && list.name) Object.assign(proxies, buildProxyMap(store, list.name));
  }
  for (const task of tasks || []) {
    const profile = profileRows.find(row => String(row.id) === String(task.profileId));
    const mapped = buildProfile(profile, task.accountId);
    if (mapped) profiles[mapped.id] = mapped;
    const account = accountRows.find(row => String(row.id) === String(task.accountId));
    const mappedAccount = buildAccount(account);
    if (mappedAccount) accounts[mappedAccount.id] = mappedAccount;
    Object.assign(proxies, buildProxyMap(store, task.proxyListName));
  }
  return {
    settings: JSON.stringify({
      webhooks: {
        checkout: String(settings.discordWebhook || '').trim(),
        decline: String(settings.discordDeclineWebhook || '').trim(),
      },
      shapeMethod: 'Harvester',
      lucaApiKey: '',
    }),
    profileList: JSON.stringify(profiles),
    proxyList: JSON.stringify(proxies),
    accountList: JSON.stringify(accounts),
  };
}

module.exports = {
  sendConfigsPayload,
  targetStartMessages,
  pokemonStartMessages,
  displayProxyGroup,
  parseProxyLine,
};
