import {
  SUBSCRIPTION_EXPIRED,
  accessUntilFromIntro,
  accessUntilFromStripeObject,
  billingPublicFields,
  catalogSnapshot,
  claimBillingSession,
  createCheckoutSession,
  defaultPlan,
  markStripeEventProcessed,
  paidAccessFailure,
  planById,
  rememberStripeEvent,
  storeBillingClaim,
  upsertPaidUser,
  verifyStripeSignature,
} from './billing.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100000;
const LICENSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 20 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_SESSION_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_BLOCK_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const MAX_PROXY_LIST_BYTES = 5 * 1024 * 1024;
const MAX_PROXY_LINES = 50000;
const MAX_MANAGED_LISTS = 20;
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const BACKUP_RETENTION = 10;
const BACKUP_UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000;
const BACKUP_UPLOAD_RATE_MAX_REQUESTS = 30;
const BACKUP_ORPHAN_GRACE_MS = 5 * 60 * 1000;
const MAX_HYPER_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_HYPER_RESPONSE_BYTES = 4 * 1024 * 1024;
const HYPER_TIMEOUT_MS = 30 * 1000;
const HYPER_RATE_WINDOW_MS = 60 * 1000;
const HYPER_RATE_MAX_REQUESTS = 1200;
const ANALYTICS_BATCH_MAX = 20;
const ANALYTICS_ITEMS_MAX = 20;
const ANALYTICS_TEXT_MAX = 500;
const ANALYTICS_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ANALYTICS_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MIN_ACTIVE_DEVICES = 1;
const MAX_ACTIVE_DEVICES = 10;
// D1 limits both a string and a complete row to 2,000,000 bytes. Keep headroom for the remaining
// columns and AES-GCM/base64 overhead; unusually incompressible pools get a useful split-list error.
const MAX_STORED_PROXY_CHARS = 1800000;
const COMPRESSED_PROXY_PREFIX = 'gz1:';
const DOWNLOAD_SITE_ORIGIN = 'https://zynbot.app';
const HYPER_SERVICE_NAME = 'hyper';
const BACKUP_UPLOAD_SERVICE_NAME = 'cloud-backup-upload';
const POKEMON_QUEUE_SERVICE_NAME = 'pokemon-queue-events';
const POKEMON_QUEUE_UPSTREAM = 'wss://polar-wss-production.up.railway.app';
const POKEMON_QUEUE_UPSTREAM_VERSION = 'v0.0.50';
const POKEMON_QUEUE_VERSION_STATE_NAME = 'pokemon-queue-upstream-version';
const POKEMON_QUEUE_RELEASES_URL = 'https://api.github.com/repos/PolarAIO/downloads/releases/latest';
const POKEMON_QUEUE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const POKEMON_QUEUE_VERSION_MAX_AGE_MS = 60 * 60 * 1000;
const POKEMON_QUEUE_WIRE_KEY_HEX = '7011fb72b65c75f8212859f17b895cc76613b093eff302f79a27eda1b51d4ebb';
const POKEMON_QUEUE_ROTATE_MS = 10 * 60 * 1000;
const POKEMON_QUEUE_RECONNECT_MAX_MS = 30 * 1000;
const POKEMON_QUEUE_MAX_MESSAGE_BYTES = 1024 * 1024;
const POKEMON_QUEUE_DISCORD_SECRET = 'ZYN_POKEMON_QUEUE_DISCORD_WEBHOOK';
const POKEMON_QUEUE_DISCORD_COOLDOWN_MS = 60 * 1000;
const HYPER_UPSTREAMS = Object.freeze({
  reese84: 'https://incapsula.hypersolutions.co/reese84',
  'datadome-tags': 'https://datadome.hypersolutions.co/tags',
  'datadome-interstitial': 'https://datadome.hypersolutions.co/interstitial',
  'datadome-slider': 'https://datadome.hypersolutions.co/slider',
  'incapsula-utmvc': 'https://incapsula.hypersolutions.co/utmvc',
});
// Target is the always-available base module. Optional task types are registered here and inserted
// into D1 on first use, so adding a future module does not require another schema redesign.
const TASK_TYPE_REGISTRY = Object.freeze([
  { key: 'pokemoncenter', label: 'Pokémon Center' },
  { key: 'round1', label: 'Round1' },
]);
let taskTypeRegistryEnsured = false;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%*-_';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function proxyEncryptionKey(env) {
  const bytes = base64UrlToBytes(String(env.PROXY_ENCRYPTION_KEY || ''));
  if (bytes.length !== 32) throw new Error('Managed proxy encryption key is not configured.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function serviceConfigEncryptionKey(env) {
  const bytes = base64UrlToBytes(String(env.SERVICE_CONFIG_ENCRYPTION_KEY || ''));
  if (bytes.length !== 32) throw new Error('Service configuration encryption key is not configured.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function serviceConfigAdditionalData(name) {
  return encoder.encode(`zyn-service-config:${name}:v1`);
}

async function encryptServiceCredential(name, value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: serviceConfigAdditionalData(name) },
    await serviceConfigEncryptionKey(env),
    encoder.encode(value),
  );
  return {
    encryptedValue: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
    fingerprint: (await sha256(value)).slice(0, 16),
  };
}

async function decryptServiceCredential(row, env) {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlToBytes(String(row.iv || '')),
      additionalData: serviceConfigAdditionalData(String(row.name || '')),
    },
    await serviceConfigEncryptionKey(env),
    base64UrlToBytes(String(row.encrypted_value || '')),
  );
  return decoder.decode(plain);
}

function hyperCredentialInput(body) {
  const apiKey = String(body && body.apiKey || '').trim();
  if (apiKey.length < 8 || apiKey.length > 512 || /[\0\r\n]/.test(apiKey)) {
    return { error: 'Enter a valid Hyper API key between 8 and 512 characters.' };
  }
  return { apiKey };
}

function pokemonQueueCredentialInput(body) {
  const licenseKey = String(body && body.licenseKey || '').trim();
  if (licenseKey.length < 8 || licenseKey.length > 128 || /[\0\r\n]/.test(licenseKey)) {
    return { error: 'Enter a valid queue event license between 8 and 128 characters.' };
  }
  return { licenseKey };
}

function serviceCredentialJson(row) {
  return {
    configured: Boolean(row),
    fingerprint: row ? String(row.fingerprint || '') : '',
    updatedAt: row ? Number(row.updated_at) || 0 : 0,
  };
}

async function serviceCredentialRow(env, name) {
  return env.DB.prepare(`
    SELECT name, encrypted_value, iv, fingerprint, created_at, updated_at
    FROM service_config WHERE name = ?
  `).bind(name).first();
}

async function serviceCredentialValue(env, name) {
  const row = await serviceCredentialRow(env, name);
  return row ? decryptServiceCredential(row, env) : '';
}

function hexToBytes(value) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(String(value || ''))) throw new Error('Invalid hexadecimal value.');
  return Uint8Array.from(String(value).match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

function normalizePolarReleaseVersion(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 32) return '';
  const version = raw.startsWith('v') || raw.startsWith('V') ? `v${raw.slice(1)}` : `v${raw}`;
  return POKEMON_QUEUE_VERSION_PATTERN.test(version) ? version : '';
}

function parsePolarLatestRelease(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  if (payload.draft === true || payload.prerelease === true) return '';
  return normalizePolarReleaseVersion(payload.tag_name || payload.name);
}

function defaultPolarUpstreamVersionState() {
  return {
    version: POKEMON_QUEUE_UPSTREAM_VERSION,
    stored: false,
    source: 'default',
    checkedAt: 0,
    updatedAt: 0,
  };
}

async function readStoredPolarUpstreamVersion(env) {
  if (!env || !env.DB) return defaultPolarUpstreamVersionState();
  try {
    const row = await env.DB.prepare(
      'SELECT value, source, checked_at, updated_at FROM service_state WHERE name = ?',
    ).bind(POKEMON_QUEUE_VERSION_STATE_NAME).first();
    const version = normalizePolarReleaseVersion(row && row.value);
    if (!version) return defaultPolarUpstreamVersionState();
    return {
      version,
      stored: true,
      source: String(row.source || '') || 'github',
      checkedAt: Number(row.checked_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  } catch {
    return defaultPolarUpstreamVersionState();
  }
}

async function pokemonQueueVersionJson(env) {
  const stored = await readStoredPolarUpstreamVersion(env);
  return {
    version: stored.version,
    defaultVersion: POKEMON_QUEUE_UPSTREAM_VERSION,
    versionSource: stored.source,
    versionCheckedAt: stored.checkedAt,
    versionUpdatedAt: stored.updatedAt,
  };
}

async function refreshPolarUpstreamVersion(env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const now = Number(dependencies.now) || Date.now();
  let response;
  try {
    response = await fetchImpl(POKEMON_QUEUE_RELEASES_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'zyn-license-api',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, changed: false, reason: 'upstream_unavailable' };
  }
  if (!response || !response.ok) {
    return { ok: false, changed: false, reason: 'upstream_status', status: response && response.status };
  }
  let payload;
  try { payload = await response.json(); } catch {
    return { ok: false, changed: false, reason: 'invalid_payload' };
  }
  const version = parsePolarLatestRelease(payload);
  if (!version) return { ok: false, changed: false, reason: 'invalid_version' };

  const previous = await readStoredPolarUpstreamVersion(env);
  const changed = previous.version !== version;
  if (env && env.DB) {
    await env.DB.prepare(`
      INSERT INTO service_state (name, value, source, checked_at, updated_at)
      VALUES (?, ?, 'github', ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        checked_at = excluded.checked_at,
        updated_at = CASE
          WHEN service_state.value = excluded.value THEN service_state.updated_at
          ELSE excluded.updated_at
        END
    `).bind(POKEMON_QUEUE_VERSION_STATE_NAME, version, now, now).run();
  }
  if (changed) {
    try { await audit(env, 'polar_upstream_version_updated', null, `${previous.version}:${version}`); }
    catch {}
    await notifyPokemonQueueRelay(env);
  }
  return { ok: true, changed, version, previous: previous.version };
}

async function ensureFreshPolarUpstreamVersion(env) {
  const stored = await readStoredPolarUpstreamVersion(env);
  if (stored.checkedAt && (Date.now() - stored.checkedAt) < POKEMON_QUEUE_VERSION_MAX_AGE_MS) {
    return stored;
  }
  const refreshed = await refreshPolarUpstreamVersion(env);
  if (refreshed.ok) {
    return {
      version: refreshed.version,
      stored: true,
      source: 'github',
      checkedAt: Date.now(),
      updatedAt: refreshed.changed ? Date.now() : stored.updatedAt,
    };
  }
  return stored;
}

function pokemonQueueUpstreamUrl(licenseKey, version = POKEMON_QUEUE_UPSTREAM_VERSION) {
  const url = new URL(POKEMON_QUEUE_UPSTREAM);
  // Privacy boundary: the upstream protocol requires these two query parameters. Do not add
  // user, device, task, product, presence, telemetry, cookie, Origin, or custom-header data.
  url.searchParams.set('key', String(licenseKey || ''));
  url.searchParams.set('version', normalizePolarReleaseVersion(version) || POKEMON_QUEUE_UPSTREAM_VERSION);
  return url.toString();
}

function pokemonQueueMessageData(message) {
  let data = message && message.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function normalizePokemonQueueEvent(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const envelopeType = String(message.type || '').trim().toLowerCase();
  const data = pokemonQueueMessageData(message);
  if (!data) return null;

  if (envelopeType === 'cloud-ping') {
    const site = String(data.site || '').replace(/[\s_-]/g, '').toLowerCase();
    const eventType = String(data.type || '').trim().toLowerCase();
    if (site !== 'pokemoncenter') return null;
    if (eventType === 'queue is up!' || eventType === 'queueup' || eventType === 'queue_up' || eventType === 'queue up') {
      return { kind: 'queue' };
    }
    if (eventType === 'hcaptcha is up (stage 2)') return { kind: 'captcha' };
    return null;
  }

  if (envelopeType === 'zephyr-ping') {
    const eventType = String(data.type || '').trim().toLowerCase();
    if (eventType === 'pokemon_center_queue' || eventType === 'queueup') return { kind: 'queue' };
    if (eventType === 'pokemon_center_captcha') return { kind: 'captcha' };
  }
  return null;
}

async function pokemonQueueMessageBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

async function decodePokemonQueueMessage(value, subtle = crypto.subtle) {
  const bytes = await pokemonQueueMessageBytes(value);
  if (!bytes || bytes.length < 29 || bytes.length > POKEMON_QUEUE_MAX_MESSAGE_BYTES) return null;
  const key = await subtle.importKey('raw', hexToBytes(POKEMON_QUEUE_WIRE_KEY_HEX), 'AES-GCM', false, ['decrypt']);
  let plain;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), tagLength: 128 },
      key,
      bytes.subarray(12),
    );
  } catch { return null; }
  try {
    const parsed = JSON.parse(decoder.decode(plain));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function pokemonQueueReconnectDelay(attempt) {
  return Math.min(POKEMON_QUEUE_RECONNECT_MAX_MS, 1000 * (2 ** Math.min(5, Math.max(0, attempt))));
}

function pokemonQueueDiscordWebhook(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^\/api\/(?:v10\/)?webhooks\/([0-9]+)\/([^/]+)$/);
    if (url.protocol !== 'https:'
        || (url.hostname !== 'discord.com' && url.hostname !== 'discordapp.com')
        || !match
        || url.username || url.password || url.hash || url.search) {
      return null;
    }
    url.hostname = 'discord.com';
    url.pathname = `/api/v10/webhooks/${match[1]}/${match[2]}`;
    url.searchParams.set('wait', 'true');
    return url;
  } catch {
    return null;
  }
}

function pokemonQueueDiscordPayload(detectedAt = Date.now()) {
  return {
    username: 'Zyn',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'Pokémon Center queue is up',
      description: 'Queue-it is live. Start or resume your Pokémon Center tasks.',
      color: 14753096,
      timestamp: new Date(Number(detectedAt) || Date.now()).toISOString(),
      footer: { text: 'Zyn' },
    }],
  };
}

async function notifyPokemonQueueDiscord(env, event, options = {}) {
  if (!event || event.kind !== 'queue') return { sent: false, reason: 'ignored' };
  const webhook = pokemonQueueDiscordWebhook(env && env[POKEMON_QUEUE_DISCORD_SECRET]);
  if (!webhook) return { sent: false, reason: 'unconfigured' };
  const fetchImpl = options.fetch || fetch;
  try {
    const response = await fetchImpl(webhook.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DiscordBot (https://zynbot.app, 1.0)',
      },
      body: JSON.stringify(pokemonQueueDiscordPayload(options.detectedAt)),
      redirect: 'manual',
    });
    return { sent: response.ok === true, status: response.status || 0 };
  } catch {
    return { sent: false, reason: 'request_failed' };
  }
}

export class PokemonQueueRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.upstream = null;
    this.candidate = null;
    this.endedSockets = new WeakSet();
    this.reconnectAttempt = 0;
    this.sequence = 0;
    this.lastQueueDiscordAt = 0;
    this.health = {
      configured: false,
      connected: false,
      connecting: false,
      lastConnectedAt: 0,
      lastMessageAt: 0,
      lastEventAt: 0,
    };
  }

  publicHealth() {
    return {
      type: 'pokemon-center-queue-health',
      configured: this.health.configured === true,
      connected: this.health.connected === true,
      connecting: this.health.connecting === true,
      lastConnectedAt: Number(this.health.lastConnectedAt) || 0,
      lastMessageAt: Number(this.health.lastMessageAt) || 0,
      lastEventAt: Number(this.health.lastEventAt) || 0,
    };
  }

  clients() {
    return this.state.getWebSockets().filter((socket) => socket.readyState === 1);
  }

  discordMonitorEnabled() {
    return Boolean(pokemonQueueDiscordWebhook(this.env && this.env[POKEMON_QUEUE_DISCORD_SECRET]));
  }

  needsUpstream() {
    return this.clients().length > 0 || this.discordMonitorEnabled();
  }

  broadcast(payload) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.clients()) {
      try { socket.send(encoded); } catch {}
    }
  }

  async scheduleAlarm(delay) {
    await this.state.storage.setAlarm(Date.now() + Math.max(1000, Number(delay) || 1000));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/client') {
      if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required.', { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ role: 'licensed-client' });
      server.send(JSON.stringify(this.publicHealth()));
      this.ensureUpstream().catch(() => this.upstreamEnded(this.candidate));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/reconfigure' && request.method === 'POST') {
      await this.ensureUpstream({ replace: true });
      return new Response(JSON.stringify(this.publicHealth()), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return new Response('Not found.', { status: 404 });
  }

  async ensureUpstream({ replace = false } = {}) {
    let licenseKey = '';
    try { licenseKey = await serviceCredentialValue(this.env, POKEMON_QUEUE_SERVICE_NAME); }
    catch {
      this.health.configured = false;
      this.health.connecting = false;
      this.broadcast(this.publicHealth());
      return;
    }
    this.health.configured = Boolean(licenseKey);
    if (!licenseKey) {
      await this.stopUpstream();
      this.broadcast(this.publicHealth());
      return;
    }
    if (!this.needsUpstream()) {
      this.broadcast(this.publicHealth());
      return;
    }
    if (this.candidate && (this.candidate.readyState === 0 || this.candidate.readyState === 1)) return;
    if (!replace && this.upstream && this.upstream.readyState === 1) return;

    let socket;
    try {
      const versionState = await ensureFreshPolarUpstreamVersion(this.env);
      // The Web Standard constructor has no custom-header option. This connector also never calls
      // send(), making it receive-only apart from automatic WebSocket control frames.
      socket = new WebSocket(pokemonQueueUpstreamUrl(licenseKey, versionState.version));
    } catch {
      this.health.connected = false;
      this.health.connecting = false;
      this.broadcast(this.publicHealth());
      await this.scheduleReconnect();
      return;
    }
    this.candidate = socket;
    this.health.connecting = true;
    this.broadcast(this.publicHealth());

    socket.addEventListener('open', () => {
      if (this.candidate !== socket) {
        try { socket.close(1000); } catch {}
        return;
      }
      const previous = this.upstream;
      this.candidate = null;
      this.upstream = socket;
      this.reconnectAttempt = 0;
      this.health.connected = true;
      this.health.connecting = false;
      this.health.lastConnectedAt = Date.now();
      this.broadcast(this.publicHealth());
      this.scheduleAlarm(POKEMON_QUEUE_ROTATE_MS).catch(() => {});
      if (previous && previous !== socket) {
        try { previous.close(1000); } catch {}
      }
    });
    socket.addEventListener('message', (event) => {
      this.handleUpstreamMessage(socket, event.data).catch(() => {});
    });
    socket.addEventListener('error', () => this.upstreamEnded(socket));
    socket.addEventListener('close', () => this.upstreamEnded(socket));
  }

  async handleUpstreamMessage(socket, value) {
    if (socket !== this.upstream) return;
    const message = await decodePokemonQueueMessage(value);
    if (!message) return;
    this.health.lastMessageAt = Date.now();
    const event = normalizePokemonQueueEvent(message);
    if (!event) {
      this.broadcast(this.publicHealth());
      return;
    }
    this.health.lastEventAt = Date.now();
    this.sequence += 1;
    this.broadcast({
      type: 'pokemon-center-protection',
      kind: event.kind,
      detectedAt: this.health.lastEventAt,
      sequence: this.sequence,
    });
    if (event.kind === 'queue'
        && this.health.lastEventAt - this.lastQueueDiscordAt >= POKEMON_QUEUE_DISCORD_COOLDOWN_MS) {
      this.lastQueueDiscordAt = this.health.lastEventAt;
      notifyPokemonQueueDiscord(this.env, event, { detectedAt: this.health.lastEventAt }).catch(() => {});
    }
  }

  async scheduleReconnect() {
    if (!this.needsUpstream() || !this.health.configured) return;
    const delay = pokemonQueueReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    await this.scheduleAlarm(delay);
  }

  upstreamEnded(socket) {
    if (!socket || this.endedSockets.has(socket)) return;
    this.endedSockets.add(socket);
    const wasCandidate = this.candidate === socket;
    const wasUpstream = this.upstream === socket;
    if (wasCandidate) this.candidate = null;
    if (wasUpstream) this.upstream = null;
    if (!wasCandidate && !wasUpstream) return;
    if (this.upstream && this.upstream.readyState === 1) {
      this.health.connected = true;
      this.health.connecting = false;
      this.scheduleAlarm(60 * 1000).catch(() => {});
      return;
    }
    this.health.connected = false;
    this.health.connecting = false;
    this.broadcast(this.publicHealth());
    this.scheduleReconnect().catch(() => {});
  }

  async stopUpstream() {
    const sockets = [this.candidate, this.upstream].filter(Boolean);
    this.candidate = null;
    this.upstream = null;
    this.health.connected = false;
    this.health.connecting = false;
    for (const socket of sockets) {
      this.endedSockets.add(socket);
      try { socket.close(1000); } catch {}
    }
    try { await this.state.storage.deleteAlarm(); } catch {}
  }

  async alarm() {
    if (!this.needsUpstream()) {
      await this.stopUpstream();
      return;
    }
    if (this.upstream && this.upstream.readyState === 1) {
      await this.ensureUpstream({ replace: true });
      return;
    }
    await this.ensureUpstream();
  }

  webSocketMessage() {
    // Licensed clients are receive-only. In particular, their messages are never forwarded to the
    // upstream connection.
  }

  async webSocketClose() {
    if (!this.needsUpstream()) await this.stopUpstream();
  }

  async webSocketError() {
    if (!this.needsUpstream()) await this.stopUpstream();
  }
}

function brokerError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function boundedBodyBytes(body, maximum, tooLargeMessage, status = 413, code = 'request_too_large') {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    length += chunk.length;
    if (length > maximum) {
      await reader.cancel(tooLargeMessage);
      throw brokerError(tooLargeMessage, status, code);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function hyperRequestBody(request) {
  const type = String(request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/json')) {
    throw brokerError('Hyper requests require a JSON body.', 415, 'json_required');
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_HYPER_REQUEST_BYTES)) {
    throw brokerError('Hyper request body is too large.', 413, 'request_too_large');
  }
  const bytes = await boundedBodyBytes(request.body, MAX_HYPER_REQUEST_BYTES, 'Hyper request body is too large.');
  if (!bytes.length) throw brokerError('Hyper requests require a JSON body.', 400, 'invalid_json');
  try {
    const parsed = JSON.parse(decoder.decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
  } catch {
    throw brokerError('Hyper request body must be a JSON object.', 400, 'invalid_json');
  }
  return bytes;
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encryptProxyList(raw, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const compressed = await gzipBytes(encoder.encode(raw));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await proxyEncryptionKey(env),
    compressed,
  );
  const encryptedRaw = `${COMPRESSED_PROXY_PREFIX}${bytesToBase64Url(new Uint8Array(encrypted))}`;
  if (encryptedRaw.length > MAX_STORED_PROXY_CHARS) {
    const error = new Error('That proxy list cannot fit in encrypted storage even after compression. Split it into two managed lists.');
    error.code = 'PROXY_STORAGE_LIMIT';
    throw error;
  }
  return { encryptedRaw, iv: bytesToBase64Url(iv) };
}

async function decryptProxyList(row, env) {
  const stored = String(row.encrypted_raw || '');
  const compressed = stored.startsWith(COMPRESSED_PROXY_PREFIX);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(row.iv) },
    await proxyEncryptionKey(env),
    base64UrlToBytes(compressed ? stored.slice(COMPRESSED_PROXY_PREFIX.length) : stored),
  );
  return decoder.decode(compressed ? await gunzipBytes(new Uint8Array(plain)) : plain);
}

function proxyListInput(body) {
  const name = String(body && body.name || '').trim();
  const source = String(body && body.raw || '').replace(/\r/g, '');
  if (!name || name.length > 80) return { error: 'Use a list name between 1 and 80 characters.' };
  if (encoder.encode(source).length > MAX_PROXY_LIST_BYTES) {
    return { error: 'That proxy list is too large (5 MB maximum).' };
  }
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Paste at least one proxy.' };
  if (lines.length > MAX_PROXY_LINES) return { error: `A list can contain at most ${MAX_PROXY_LINES} proxies.` };
  for (let index = 0; index < lines.length; index += 1) {
    const parts = lines[index].split(':');
    const port = Number(parts[1]);
    if (![2, 4].includes(parts.length) || !parts[0] || !Number.isInteger(port)
        || port < 1 || port > 65535 || (parts.length === 4 && (!parts[2] || !parts[3]))) {
      return { error: `Line ${index + 1} must use host:port or host:port:user:pass.` };
    }
  }
  return { name, raw: lines.join('\n'), count: lines.length };
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] || 0) ^ (b[index] || 0);
  return mismatch === 0;
}

async function passwordHash(password, salt, pepper, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${password}\0${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: base64UrlToBytes(salt),
    iterations,
  }, material, 256);
  return bytesToHex(bits);
}

async function newPasswordRecord(password, env) {
  const salt = randomToken(16);
  return {
    salt,
    hash: await passwordHash(password, salt, env.PASSWORD_PEPPER, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS,
  };
}

async function verifyPassword(password, user, env) {
  const hash = await passwordHash(password, user.password_salt, env.PASSWORD_PEPPER, user.password_iterations);
  return constantTimeEqual(hash, user.password_hash);
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validDeviceId(value) {
  return /^[a-f0-9]{16,128}$/i.test(String(value || ''));
}

function validMaxActiveDevices(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_ACTIVE_DEVICES
    && value <= MAX_ACTIVE_DEVICES;
}

function maxActiveDevicesForUser(user) {
  const value = Number(user && user.max_active_devices);
  return validMaxActiveDevices(value) ? value : MIN_ACTIVE_DEVICES;
}

function apiHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: apiHeaders(headers) });
}

async function bodyJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new Error('JSON body required');
  return request.json();
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function rateKey(kind, identity, request) {
  return sha256(`${kind}:${String(identity || '').toLowerCase()}:${clientIp(request)}`);
}

async function rateBlocked(env, key, now) {
  const row = await env.DB.prepare(
    'SELECT failures, window_started_at, blocked_until FROM auth_attempts WHERE key = ?',
  ).bind(key).first();
  if (!row) return 0;
  if (row.blocked_until > now) return Math.ceil((row.blocked_until - now) / 1000);
  if (now - row.window_started_at > RATE_WINDOW_MS) {
    await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
  }
  return 0;
}

async function rateFailure(env, key, now) {
  const row = await env.DB.prepare(
    'SELECT failures, window_started_at FROM auth_attempts WHERE key = ?',
  ).bind(key).first();
  const inWindow = row && now - row.window_started_at <= RATE_WINDOW_MS;
  const failures = inWindow ? row.failures + 1 : 1;
  const windowStarted = inWindow ? row.window_started_at : now;
  const blockedUntil = failures >= RATE_MAX_FAILURES ? now + RATE_BLOCK_MS : 0;
  await env.DB.prepare(`
    INSERT INTO auth_attempts (key, failures, window_started_at, blocked_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures,
      window_started_at = excluded.window_started_at,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at
  `).bind(key, failures, windowStarted, blockedUntil, now).run();
}

async function rateSuccess(env, key) {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}

async function managedProxyRows(env) {
  const result = await env.DB.prepare(`
    SELECT id, name, encrypted_raw, iv, proxy_count, updated_at
    FROM managed_proxy_lists ORDER BY name COLLATE NOCASE
  `).all();
  return result.results || [];
}

async function managedProxyRevision(rows) {
  return sha256(rows.map(row => [
    String(row.id || ''), String(row.name || ''), Number(row.proxy_count) || 0, Number(row.updated_at) || 0,
  ].join(':')).join('\n'));
}

async function managedProxyListsForUser(env, proxyAccess, rows = null) {
  if (!Number(proxyAccess)) return [];
  const lists = [];
  for (const row of (rows || await managedProxyRows(env))) {
    try {
      lists.push({
        id: row.id,
        name: row.name,
        raw: await decryptProxyList(row, env),
        count: Number(row.proxy_count) || 0,
        updatedAt: Number(row.updated_at) || 0,
      });
    } catch (error) {
      // A damaged/old row must not invalidate the user's license. Skip only that list and keep the
      // app usable while recording enough context for the operator to replace it.
      console.error(`managed proxy list ${row.id} could not be decrypted`, error && error.message);
    }
  }
  return lists;
}

function defaultTaskTypeAccess() {
  return Object.fromEntries(TASK_TYPE_REGISTRY.map(type => [type.key, false]));
}

async function ensureTaskTypeRegistry(env) {
  if (taskTypeRegistryEnsured) return;
  const now = Date.now();
  await env.DB.batch(TASK_TYPE_REGISTRY.map(type => env.DB.prepare(`
    INSERT OR IGNORE INTO task_types (key, label, enabled_for_all, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `).bind(type.key, type.label, now, now)));
  taskTypeRegistryEnsured = true;
}

async function taskTypeDefinitions(env) {
  await ensureTaskTypeRegistry(env);
  const result = await env.DB.prepare(`
    SELECT key, label, enabled_for_all, updated_at
    FROM task_types ORDER BY label COLLATE NOCASE
  `).all();
  const supported = new Set(TASK_TYPE_REGISTRY.map(type => type.key));
  return (result.results || []).filter(type => supported.has(type.key)).map(type => ({
    key: type.key,
    label: type.label,
    enabledForAll: Number(type.enabled_for_all) === 1,
    updatedAt: Number(type.updated_at) || 0,
  }));
}

async function taskTypeEntitlements(env, user) {
  const access = defaultTaskTypeAccess();
  const userId = String(user && (user.id || user.user_id) || '');
  if (!userId) return access;
  try {
    const definitions = await taskTypeDefinitions(env);
    const overrides = await env.DB.prepare(`
      SELECT task_type, enabled FROM user_task_type_access WHERE user_id = ?
    `).bind(userId).all();
    const byType = new Map((overrides.results || []).map(row => [row.task_type, Number(row.enabled) === 1]));
    for (const type of definitions) {
      access[type.key] = byType.has(type.key) ? byType.get(type.key) : type.enabledForAll;
    }
  } catch (error) {
    // A desktop deployed just before the migration must fail closed for optional modules without
    // locking every user out of the base Target app.
    console.error('task type entitlements unavailable', error && error.message);
  }
  return access;
}

async function licenseEntitlements(env, user, knownRevision = '') {
  const taskTypes = await taskTypeEntitlements(env, user);
  const proxyAccess = Number(user.proxy_access) === 1;
  if (!proxyAccess) {
    return { taskTypes, proxyAccess: false, proxyRevision: '', proxyListCount: 0, proxyListsChanged: true, managedProxyLists: [] };
  }
  const rows = await managedProxyRows(env);
  const proxyRevision = await managedProxyRevision(rows);
  if (knownRevision && constantTimeEqual(knownRevision, proxyRevision)) {
    return { taskTypes, proxyAccess: true, proxyRevision, proxyListCount: rows.length, proxyListsChanged: false };
  }
  return {
    taskTypes,
    proxyAccess: true,
    proxyRevision,
    proxyListCount: rows.length,
    proxyListsChanged: true,
    managedProxyLists: await managedProxyListsForUser(env, true, rows),
  };
}

function pruneExcessLicensesStatement(db, {
  userId,
  now,
  reason,
  preserveLicenseId = '',
}) {
  return db.prepare(`
    UPDATE licenses SET revoked_at = ?, revoked_reason = ?
    WHERE user_id = ? AND revoked_at IS NULL AND id IN (
      SELECT id FROM licenses
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
        last_validated_at DESC, created_at DESC, id DESC
      LIMIT -1 OFFSET (
        SELECT max_active_devices FROM users WHERE id = ?
      )
    )
  `).bind(now, reason, userId, userId, now, preserveLicenseId, userId);
}

function mintLicenseStatements(db, {
  userId,
  authenticatedPasswordHash,
  licenseId,
  tokenHash,
  deviceId,
  deviceName,
  now,
  expiresAt,
}) {
  return [
    db.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'expired'
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at <= ?
    `).bind(now, userId, now),
    db.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'new_login'
      WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM users
          WHERE id = ? AND active = 1 AND must_reset_password = 0 AND password_hash = ?
        )
    `).bind(now, userId, deviceId, userId, authenticatedPasswordHash),
    db.prepare(`
      INSERT INTO licenses
        (id, user_id, token_hash, device_id, device_name, created_at, last_validated_at, expires_at)
      SELECT ?, id, ?, ?, ?, ?, ?, ? FROM users
      WHERE id = ? AND active = 1 AND must_reset_password = 0 AND password_hash = ?
    `).bind(
      licenseId, tokenHash, deviceId, deviceName, now, now, expiresAt,
      userId, authenticatedPasswordHash,
    ),
    pruneExcessLicensesStatement(db, {
      userId,
      now,
      reason: 'device_limit',
      preserveLicenseId: licenseId,
    }),
    db.prepare(`
      UPDATE users SET last_login_at = ?, updated_at = ?
      WHERE id = ? AND active = 1 AND must_reset_password = 0 AND password_hash = ?
    `).bind(now, now, userId, authenticatedPasswordHash),
  ];
}

function activeDeviceLimitStatements(db, { userId, maxActiveDevices, now }) {
  return [
    db.prepare(`
      UPDATE users SET max_active_devices = ?, updated_at = ? WHERE id = ?
    `).bind(maxActiveDevices, now, userId),
    // Always enforce the just-written value inside this batch. Another admin request may have
    // changed the limit after this request read the user, so a value that looked like an increase
    // can still be a reduction relative to the transaction's current state.
    pruneExcessLicensesStatement(db, {
      userId,
      now,
      reason: 'device_limit_reduced',
    }),
  ];
}

async function mintLicense(env, user, deviceId, deviceName) {
  const now = Date.now();
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const expiresAt = now + LICENSE_TTL_MS;
  const results = await env.DB.batch(mintLicenseStatements(env.DB, {
    userId: user.id,
    authenticatedPasswordHash: user.password_hash,
    licenseId: crypto.randomUUID(),
    tokenHash,
    deviceId,
    deviceName,
    now,
    expiresAt,
  }));
  if (!Number(results[2] && results[2].meta && results[2].meta.changes)) return null;
  return {
    ok: true,
    licenseToken: token,
    userId: user.id,
    email: user.email,
    expiresAt,
    ...billingPublicFields(user),
    ...await licenseEntitlements(env, user),
  };
}

async function login(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const deviceId = String(body.deviceId || '');
  const deviceName = String(body.deviceName || '').slice(0, 100);
  if (!email || !password || password.length > 256 || !validDeviceId(deviceId)) {
    return json({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' }, 401);
  }

  const now = Date.now();
  const key = await rateKey('user-login', email, request);
  const retryAfter = await rateBlocked(env, key, now);
  if (retryAfter) return json({ ok: false, code: 'rate_limited', message: 'Too many attempts. Try again later.' }, 429, { 'retry-after': String(retryAfter) });

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  let passwordOk = false;
  if (user) passwordOk = await verifyPassword(password, user, env);
  else await passwordHash(password, 'AAAAAAAAAAAAAAAAAAAAAA', env.PASSWORD_PEPPER, PASSWORD_ITERATIONS);

  if (!user || !passwordOk) {
    await rateFailure(env, key, now);
    return json({ ok: false, code: 'invalid_credentials', message: 'Invalid email or password.' }, 401);
  }
  await rateSuccess(env, key);
  if (!user.active) return json({ ok: false, code: 'account_disabled', message: 'This account is disabled.' }, 403);
  const accessFailure = paidAccessFailure(user, now);
  if (accessFailure) return json({ ok: false, ...accessFailure }, 402);

  if (user.must_reset_password) {
    const resetToken = randomToken(32);
    const resetHash = await sha256(resetToken);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.id),
      env.DB.prepare(`
        INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(resetHash, user.id, now, now + RESET_TTL_MS),
    ]);
    return json({
      ok: false,
      code: 'password_reset_required',
      message: 'Choose a new password to continue.',
      resetToken,
      email: user.email,
    }, 403);
  }

  const license = await mintLicense(env, user, deviceId, deviceName);
  if (!license) {
    return json({
      ok: false,
      code: 'sign_in_changed',
      message: 'Your account changed while you were signing in. Sign in again.',
    }, 409);
  }
  return json(license);
}

async function resetPassword(request, env) {
  const body = await bodyJson(request);
  const resetToken = String(body.resetToken || '');
  const password = String(body.newPassword || '');
  const deviceId = String(body.deviceId || '');
  const deviceName = String(body.deviceName || '').slice(0, 100);
  if (resetToken.length < 32 || password.length < 10 || password.length > 256 || !validDeviceId(deviceId)) {
    return json({ ok: false, code: 'invalid_reset', message: 'Use a password of at least 10 characters.' }, 400);
  }

  const tokenHash = await sha256(resetToken);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT u.* FROM password_reset_tokens r
    JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.consumed_at IS NULL AND r.expires_at > ?
  `).bind(tokenHash, now).first();
  if (!row || !row.active) return json({ ok: false, code: 'invalid_reset', message: 'This password reset has expired. Sign in again.' }, 401);

  const record = await newPasswordRecord(password, env);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
        must_reset_password = 0, updated_at = ? WHERE id = ?
    `).bind(record.hash, record.salt, record.iterations, now, row.id),
    env.DB.prepare('UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ?')
      .bind(now, tokenHash),
    env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'password_reset'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, row.id),
  ]);
  const license = await mintLicense(env, {
    ...row,
    password_hash: record.hash,
    must_reset_password: 0,
  }, deviceId, deviceName);
  if (!license) {
    return json({
      ok: false,
      code: 'sign_in_changed',
      message: 'Your account changed while you were signing in. Sign in again.',
    }, 401);
  }
  return json(license);
}

function bearer(request) {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function licenseRebindStatements(db, {
  licenseId,
  userId,
  deviceId,
  deviceName,
  now,
  expiresAt,
}) {
  return [
    db.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'new_login'
      WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL AND id != ?
    `).bind(now, userId, deviceId, licenseId),
    db.prepare(`
      UPDATE licenses SET device_id = ?, device_name = ?, last_validated_at = ?, expires_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(deviceId, deviceName, now, expiresAt, licenseId),
  ];
}

function canRebindLicense(row, now) {
  return Boolean(row && row.active && !row.revoked_at && Number(row.expires_at) > now);
}

function licenseFailure(row, deviceId, now) {
  if (!row) {
    return { code: 'session_invalid', message: 'Your Zyn session is no longer valid. Sign in again to continue.' };
  }
  if (!row.active) {
    return { code: 'account_disabled', message: 'This account has been disabled. Contact support if you think this is a mistake.' };
  }
  if (row.revoked_at) {
    if (row.revoked_reason === 'new_login' || row.revoked_reason === 'device_limit') {
      return {
        code: 'session_replaced',
        message: 'You were signed out because another sign-in replaced this session. Sign in again to use Zyn here.',
      };
    }
    if (row.revoked_reason === 'device_limit_reduced') {
      return {
        code: 'session_limit_reduced',
        message: 'You were signed out because an administrator reduced this account\u2019s active-device limit. Sign in again or contact support if this was unexpected.',
      };
    }
    if (row.revoked_reason === 'password_reset' || row.revoked_reason === 'admin_password_reset') {
      return {
        code: 'password_changed',
        message: 'Your password was changed, so this device was signed out. Sign in again with your current password.',
      };
    }
    if (row.revoked_reason === 'logout') {
      return { code: 'signed_out', message: 'You are signed out. Sign in again to continue.' };
    }
    if (row.revoked_reason === 'expired') {
      return { code: 'session_expired', message: 'Your Zyn session expired. Sign in again to continue.' };
    }
    return {
      code: 'session_revoked',
      message: 'This Zyn session was revoked by an administrator. Sign in again or contact support if this was unexpected.',
    };
  }
  if (row.device_id !== deviceId) {
    return {
      code: 'session_device_mismatch',
      message: 'This saved session belongs to a different device. Sign in again to continue.',
    };
  }
  if (Number(row.expires_at) <= now) {
    return { code: 'session_expired', message: 'Your Zyn session expired. Sign in again to continue.' };
  }
  return null;
}

async function validateLicense(request, env) {
  const token = bearer(request);
  const body = await bodyJson(request);
  const deviceId = String(body.deviceId || '');
  const knownProxyRevision = /^[a-f0-9]{64}$/i.test(String(body.proxyRevision || ''))
    ? String(body.proxyRevision).toLowerCase() : '';
  if (!token || !validDeviceId(deviceId)) return json({ ok: false, code: 'license_invalid' }, 401);

  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT l.id AS license_id, l.device_id, l.device_name, l.expires_at, l.revoked_at, l.revoked_reason,
      u.id AS user_id, u.email, u.active, u.proxy_access, u.access_until,
      u.billing_plan, u.billing_status
    FROM licenses l JOIN users u ON u.id = l.user_id
    WHERE l.token_hash = ?
  `).bind(tokenHash).first();
  let failure = licenseFailure(row, deviceId, now);
  if (!failure) failure = paidAccessFailure(row, now);
  const expiresAt = now + LICENSE_TTL_MS;
  if (failure && failure.code === 'session_device_mismatch' && canRebindLicense(row, now)) {
    const deviceName = String(body.deviceName || row.device_name || '').slice(0, 100);
    await env.DB.batch(licenseRebindStatements(env.DB, {
      licenseId: row.license_id,
      userId: row.user_id,
      deviceId,
      deviceName,
      now,
      expiresAt,
    }));
    failure = null;
  }
  if (failure) {
    const status = failure.code === SUBSCRIPTION_EXPIRED.code ? 402 : 401;
    return json({ ok: false, ...failure }, status);
  }

  await env.DB.prepare('UPDATE licenses SET last_validated_at = ?, expires_at = ? WHERE id = ?')
    .bind(now, expiresAt, row.license_id).run();
  return json({
    ok: true,
    userId: row.user_id,
    email: row.email,
    expiresAt,
    ...billingPublicFields(row),
    ...await licenseEntitlements(env, row, knownProxyRevision),
  });
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'logout'
      WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(Date.now(), tokenHash).run();
  }
  return json({ ok: true });
}

function validBackupId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function inspectBackupEnvelope(bytes) {
  const magic = [82, 67, 65, 82, 84, 66, 49, 0]; // RCARTB1\0
  if (bytes.length < magic.length + 4 + 16) return null;
  for (let index = 0; index < magic.length; index += 1) if (bytes[index] !== magic[index]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(magic.length);
  const headerStart = magic.length + 4;
  const ciphertextStart = headerStart + headerLength;
  if (headerLength < 2 || headerLength > 64 * 1024 || ciphertextStart + 16 >= bytes.length) return null;
  try {
    const header = JSON.parse(decoder.decode(bytes.subarray(headerStart, ciphertextStart)));
    if (header.formatVersion !== 1 || header.compression !== 'gzip' || header.encryption !== 'AES-256-GCM'
        || !validBackupId(header.backupId) || !/^[a-f0-9]{16}$/i.test(String(header.keyFingerprint || ''))
        || !/^[A-Za-z0-9_-]{22}$/.test(String(header.salt || ''))
        || !/^[A-Za-z0-9_-]{16}$/.test(String(header.nonce || ''))) return null;
    return header;
  } catch { return null; }
}

async function authenticatedLicense(request, env) {
  const token = bearer(request);
  const deviceId = String(request.headers.get('x-rcart-device-id') || '');
  if (!token || !validDeviceId(deviceId)) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT l.id AS license_id, l.device_id, l.device_name, l.expires_at,
      u.id AS user_id, u.email, u.active
    FROM licenses l JOIN users u ON u.id = l.user_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL
  `).bind(tokenHash).first();
  if (!row || !row.active || row.device_id !== deviceId || Number(row.expires_at) <= now) return null;
  return row;
}

function analyticsText(value, max = ANALYTICS_TEXT_MAX) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function analyticsSite(value) {
  const compact = analyticsText(value, 80).toLowerCase().replace(/[^a-z]/g, '');
  if (compact === 'target') return 'Target';
  if (compact === 'pokemoncenter' || compact === 'pokemoncenterus') return 'Pokemon Center US';
  return '';
}

function analyticsInteger(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeAnalyticsEvent(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const eventId = analyticsText(value.eventId, 80);
  const eventType = analyticsText(value.eventType, 20).toLowerCase();
  const site = analyticsSite(value.site);
  if (!/^[a-z0-9-]{16,80}$/i.test(eventId)
      || !['carted', 'checkout', 'decline'].includes(eventType) || !site) return null;
  const occurredAt = analyticsInteger(value.occurredAt, 0, now + ANALYTICS_FUTURE_SKEW_MS, now);
  if (occurredAt < now - ANALYTICS_MAX_AGE_MS) return null;
  const rawItems = Array.isArray(value.items) ? value.items.slice(0, ANALYTICS_ITEMS_MAX) : [];
  const items = rawItems.map((item) => {
    const input = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const productUrl = analyticsText(input.productUrl, 1000);
    return {
      sku: analyticsText(input.sku, 120),
      name: analyticsText(input.name, 300),
      image: analyticsText(input.image, 1000),
      productUrl: /^https?:\/\//i.test(productUrl) ? productUrl : '',
      size: analyticsText(input.size, 120),
      unitPriceCents: analyticsInteger(input.unitPriceCents, 0, 100000000, 0),
      quantity: analyticsInteger(input.quantity, 1, 999, 1),
    };
  });
  return {
    eventId,
    eventType,
    site,
    taskId: analyticsText(value.taskId, 160),
    runId: analyticsText(value.runId, 160),
    orderNumber: analyticsText(value.orderNumber, 160),
    totalCents: analyticsInteger(value.totalCents, 0, 1000000000, 0),
    occurredAt,
    items,
  };
}

function analyticsWindow(url, now = Date.now()) {
  const ranges = { today: 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000, '90d': 90 * 24 * 60 * 60 * 1000 };
  const range = Object.hasOwn(ranges, url.searchParams.get('range')) ? url.searchParams.get('range') : 'all';
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  const requestedFrom = rawFrom == null ? Number.NaN : Number(rawFrom);
  const requestedTo = rawTo == null ? Number.NaN : Number(rawTo);
  const fallbackFrom = range === 'all' ? 0 : now - ranges[range];
  const from = Number.isSafeInteger(requestedFrom)
    ? Math.max(0, Math.min(now + ANALYTICS_FUTURE_SKEW_MS, requestedFrom)) : fallbackFrom;
  const to = Number.isSafeInteger(requestedTo)
    ? Math.max(from, Math.min(now + ANALYTICS_FUTURE_SKEW_MS, requestedTo)) : now + 1;
  return { range, from, to };
}

async function ingestAnalytics(request, env) {
  const license = await authenticatedLicense(request, env);
  if (!license) return json({ ok: false, message: 'A valid Zyn session is required.' }, 401);
  const body = await bodyJson(request);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > ANALYTICS_BATCH_MAX) {
    return json({ ok: false, message: `Submit 1-${ANALYTICS_BATCH_MAX} analytics events.` }, 400);
  }
  const now = Date.now();
  const events = body.events.map(value => normalizeAnalyticsEvent(value, now));
  if (events.some(event => !event)) return json({ ok: false, message: 'An analytics event is invalid.' }, 400);

  const ingestId = crypto.randomUUID();
  const statementGroups = [];
  for (const event of events) {
    const statements = [env.DB.prepare(`
      INSERT OR IGNORE INTO analytics_events
        (user_id, event_id, event_type, site, task_id, run_id, order_number,
         total_cents, occurred_at, created_at, ingest_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      license.user_id, event.eventId, event.eventType, event.site, event.taskId, event.runId,
      event.orderNumber, event.totalCents, event.occurredAt, now, ingestId,
    )];
    event.items.forEach((item, lineNumber) => {
      statements.push(env.DB.prepare(`
        INSERT OR IGNORE INTO analytics_items
          (user_id, event_id, line_number, sku, name, image, product_url, size, unit_price_cents, quantity)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM analytics_events
          WHERE user_id = ? AND event_id = ? AND ingest_id = ?
        )
      `).bind(
        license.user_id, event.eventId, lineNumber, item.sku, item.name, item.image,
        item.productUrl, item.size, item.unitPriceCents, item.quantity,
        license.user_id, event.eventId, ingestId,
      ));
    });
    statementGroups.push(statements);
  }
  // Keep every event and its item rows in one transactional D1 batch while placing a conservative
  // ceiling on each request. If a later group fails, replaying the desktop outbox remains safe.
  let chunk = [];
  for (const group of statementGroups) {
    if (chunk.length && chunk.length + group.length > 50) {
      await env.DB.batch(chunk);
      chunk = [];
    }
    chunk.push(...group);
  }
  if (chunk.length) await env.DB.batch(chunk);
  return json({ ok: true, accepted: events.length });
}

async function analyticsDashboard(request, env, url) {
  const license = await authenticatedLicense(request, env);
  if (!license) return json({ ok: false, message: 'A valid Zyn session is required.' }, 401);
  const window = analyticsWindow(url);
  const summary = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN e.event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
      SUM(CASE WHEN e.event_type = 'decline' THEN 1 ELSE 0 END) AS declines,
      SUM(CASE WHEN e.event_type = 'checkout' THEN e.total_cents ELSE 0 END) AS total_spent_cents,
      SUM(CASE WHEN e.event_type = 'carted' AND NOT EXISTS (
        SELECT 1 FROM analytics_events terminal
        WHERE terminal.user_id = e.user_id
          AND e.run_id != '' AND terminal.run_id = e.run_id
          AND terminal.event_type IN ('checkout', 'decline')
          AND terminal.occurred_at >= e.occurred_at
      ) THEN 1 ELSE 0 END) AS stuck_in_cart
    FROM analytics_events e
    WHERE e.user_id = ? AND e.occurred_at >= ? AND e.occurred_at < ?
  `).bind(license.user_id, window.from, window.to).first();
  const series = await env.DB.prepare(`
    SELECT date(occurred_at / 1000, 'unixepoch') AS day,
      SUM(CASE WHEN event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
      SUM(CASE WHEN event_type = 'decline' THEN 1 ELSE 0 END) AS declines,
      SUM(CASE WHEN event_type = 'checkout' THEN total_cents ELSE 0 END) AS total_spent_cents
    FROM analytics_events
    WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?
    GROUP BY day ORDER BY day ASC LIMIT 4000
  `).bind(license.user_id, window.from, window.to).all();
  return json({
    ok: true,
    window,
    summary: {
      checkouts: Number(summary && summary.checkouts) || 0,
      declines: Number(summary && summary.declines) || 0,
      totalSpentCents: Number(summary && summary.total_spent_cents) || 0,
      stuckInCart: Number(summary && summary.stuck_in_cart) || 0,
    },
    series: (series.results || []).map(row => ({
      day: String(row.day || ''),
      checkouts: Number(row.checkouts) || 0,
      declines: Number(row.declines) || 0,
      totalSpentCents: Number(row.total_spent_cents) || 0,
    })),
  });
}

async function analyticsCheckouts(request, env, url) {
  const license = await authenticatedLicense(request, env);
  if (!license) return json({ ok: false, message: 'A valid Zyn session is required.' }, 401);
  const window = analyticsWindow(url);
  const page = analyticsInteger(Number(url.searchParams.get('page')), 1, 1000000, 1);
  const pageSize = analyticsInteger(Number(url.searchParams.get('pageSize')), 1, 100, 20);
  const search = analyticsText(url.searchParams.get('search'), 120);
  const like = `%${search}%`;
  const filter = `e.user_id = ? AND e.event_type = 'checkout' AND e.occurred_at >= ? AND e.occurred_at < ?
    AND (? = '' OR e.site LIKE ? COLLATE NOCASE OR e.order_number LIKE ? COLLATE NOCASE OR EXISTS (
      SELECT 1 FROM analytics_items ai
      WHERE ai.user_id = e.user_id AND ai.event_id = e.event_id
        AND (ai.name LIKE ? COLLATE NOCASE OR ai.sku LIKE ? COLLATE NOCASE)
    ))`;
  const bindings = [license.user_id, window.from, window.to, search, like, like, like, like];
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM analytics_events e WHERE ${filter}`)
    .bind(...bindings).first();
  const rows = await env.DB.prepare(`
    SELECT e.event_id, e.site, e.order_number, e.total_cents, e.occurred_at,
      i.line_number, i.sku, i.name, i.image, i.product_url, i.size, i.unit_price_cents, i.quantity
    FROM (
      SELECT e.* FROM analytics_events e WHERE ${filter}
      ORDER BY e.occurred_at DESC LIMIT ? OFFSET ?
    ) e
    LEFT JOIN analytics_items i ON i.user_id = e.user_id AND i.event_id = e.event_id
    ORDER BY e.occurred_at DESC, i.line_number ASC
  `).bind(...bindings, pageSize, (page - 1) * pageSize).all();
  const checkouts = [];
  const byId = new Map();
  for (const row of (rows.results || [])) {
    let checkout = byId.get(row.event_id);
    if (!checkout) {
      checkout = {
        eventId: row.event_id, site: row.site, orderNumber: row.order_number,
        totalCents: Number(row.total_cents) || 0, occurredAt: Number(row.occurred_at) || 0, items: [],
      };
      byId.set(row.event_id, checkout);
      checkouts.push(checkout);
    }
    if (row.line_number != null) checkout.items.push({
      sku: row.sku, name: row.name, image: row.image, productUrl: row.product_url, size: row.size,
      unitPriceCents: Number(row.unit_price_cents) || 0, quantity: Number(row.quantity) || 1,
    });
  }
  return json({ ok: true, window, page, pageSize, total: Number(totalRow && totalRow.total) || 0, checkouts });
}

async function deleteAnalytics(request, env) {
  const license = await authenticatedLicense(request, env);
  if (!license) return json({ ok: false, message: 'A valid Zyn session is required.' }, 401);
  const result = await env.DB.prepare('DELETE FROM analytics_events WHERE user_id = ?').bind(license.user_id).run();
  return json({ ok: true, deleted: Number(result.meta && result.meta.changes) || 0 });
}

async function consumeHyperQuota(env, userId, now = Date.now()) {
  const windowStartedAt = Math.floor(now / HYPER_RATE_WINDOW_MS) * HYPER_RATE_WINDOW_MS;
  await env.DB.prepare(`
    INSERT INTO service_rate_windows
      (user_id, service, window_started_at, request_count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, service) DO UPDATE SET
      request_count = CASE
        WHEN service_rate_windows.window_started_at = excluded.window_started_at
          THEN service_rate_windows.request_count + 1
        ELSE 1
      END,
      window_started_at = excluded.window_started_at,
      updated_at = excluded.updated_at
  `).bind(userId, HYPER_SERVICE_NAME, windowStartedAt, now).run();
  const row = await env.DB.prepare(`
    SELECT request_count FROM service_rate_windows WHERE user_id = ? AND service = ?
  `).bind(userId, HYPER_SERVICE_NAME).first();
  const count = Number(row && row.request_count) || 1;
  return {
    allowed: count <= HYPER_RATE_MAX_REQUESTS,
    count,
    retryAfter: Math.max(1, Math.ceil((windowStartedAt + HYPER_RATE_WINDOW_MS - now) / 1000)),
  };
}

function safeHyperResponseType(response) {
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) return `${type}; charset=utf-8`;
  if (type === 'text/plain') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function hyperResponseBody(response, apiKey) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_HYPER_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel('Hyper response body is too large.');
    throw brokerError('Hyper returned an oversized response.', 502, 'upstream_response_too_large');
  }
  const bytes = await boundedBodyBytes(
    response.body,
    MAX_HYPER_RESPONSE_BYTES,
    'Hyper returned an oversized response.',
    502,
    'upstream_response_too_large',
  );
  const raw = decoder.decode(bytes);
  return raw.includes(apiKey) ? encoder.encode(raw.replaceAll(apiKey, '[redacted]')) : bytes;
}

async function hyperUpstreamRequest(operation, requestBody, apiKey) {
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };
  if (operation === 'incapsula-utmvc') {
    headers['content-encoding'] = 'gzip';
    return { headers, body: await gzipBytes(requestBody) };
  }
  return { headers, body: requestBody };
}

async function brokerHyper(request, env, operation, dependencies = {}) {
  const upstream = HYPER_UPSTREAMS[operation];
  if (!upstream) return json({ ok: false, code: 'operation_not_found', message: 'Hyper operation not found.' }, 404);
  if (request.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405);

  const authenticate = dependencies.authenticate || authenticatedLicense;
  const entitlementsFor = dependencies.entitlements || taskTypeEntitlements;
  const credentialFor = dependencies.credential || serviceCredentialValue;
  const rateLimit = dependencies.rateLimit || consumeHyperQuota;
  const upstreamFetch = dependencies.fetch || fetch;

  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to use Pokémon Center.' }, 401);
  }
  const entitlements = await entitlementsFor(env, identity);
  if (!entitlements.pokemoncenter) {
    return json({ ok: false, code: 'task_type_denied', message: 'Pokémon Center access is not enabled.' }, 403);
  }

  let requestBody;
  try {
    requestBody = await hyperRequestBody(request);
  } catch (error) {
    return json({ ok: false, code: error.code || 'invalid_request', message: error.message }, error.status || 400);
  }

  let apiKey;
  try {
    apiKey = await credentialFor(env, HYPER_SERVICE_NAME);
  } catch (error) {
    console.error('Hyper credential could not be decrypted', error && error.message);
    return json({ ok: false, code: 'service_unavailable', message: 'Hyper service configuration is unavailable.' }, 503);
  }
  if (!apiKey) {
    return json({ ok: false, code: 'service_unconfigured', message: 'Hyper service is not configured.' }, 503);
  }

  const quota = await rateLimit(env, identity.user_id);
  if (!quota.allowed) {
    return json(
      { ok: false, code: 'service_rate_limited', message: 'Hyper request limit reached. Try again shortly.' },
      429,
      { 'retry-after': String(quota.retryAfter) },
    );
  }

  let response;
  try {
    const upstreamRequest = await hyperUpstreamRequest(operation, requestBody, apiKey);
    response = await upstreamFetch(upstream, {
      method: 'POST',
      ...upstreamRequest,
      signal: AbortSignal.timeout(HYPER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return json({
      ok: false,
      code: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
      message: timedOut ? 'Hyper request timed out.' : 'Hyper service is unavailable.',
    }, timedOut ? 504 : 502);
  }

  let responseBody;
  try {
    responseBody = await hyperResponseBody(response, apiKey);
  } catch (error) {
    return json({ ok: false, code: error.code || 'upstream_error', message: error.message }, error.status || 502);
  }
  const headers = { 'content-type': safeHyperResponseType(response) };
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(responseBody, { status: response.status, headers: apiHeaders(headers) });
}

function pokemonQueueRelayStub(env) {
  if (!env.POKEMON_QUEUE_RELAY) return null;
  const id = env.POKEMON_QUEUE_RELAY.idFromName('pokemon-center-us');
  return env.POKEMON_QUEUE_RELAY.get(id);
}

async function notifyPokemonQueueRelay(env) {
  const stub = pokemonQueueRelayStub(env);
  if (!stub) return;
  try {
    await stub.fetch(new Request('https://queue-relay.internal/reconfigure', { method: 'POST' }));
  } catch {
    // Saving or removing the credential remains authoritative. A licensed client connection will
    // also wake and reconfigure the Durable Object, so a transient notification failure is safe.
  }
}

async function brokerPokemonQueueEvents(request, env, dependencies = {}) {
  if (request.method !== 'GET') return json({ ok: false, message: 'Method not allowed.' }, 405);
  if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return json({ ok: false, code: 'websocket_required', message: 'WebSocket upgrade required.' }, 426);
  }
  const authenticate = dependencies.authenticate || authenticatedLicense;
  const entitlementsFor = dependencies.entitlements || taskTypeEntitlements;
  const identity = await authenticate(request, env);
  if (!identity) {
    return json({ ok: false, code: 'license_invalid', message: 'Sign in again to monitor Pokémon Center.' }, 401);
  }
  const entitlements = await entitlementsFor(env, identity);
  if (!entitlements.pokemoncenter) {
    return json({ ok: false, code: 'task_type_denied', message: 'Pokémon Center access is not enabled.' }, 403);
  }
  const stub = dependencies.stub || pokemonQueueRelayStub(env);
  if (!stub) {
    return json({ ok: false, code: 'service_unavailable', message: 'Queue event monitoring is unavailable.' }, 503);
  }
  // The authenticated device headers terminate here. Constructing a new internal request prevents
  // the bearer token, device ID, user agent, IP metadata, or any other client header from reaching
  // the upstream connector.
  return stub.fetch(new Request('https://queue-relay.internal/client', {
    headers: { Upgrade: 'websocket' },
  }));
}

function backupJson(row) {
  return {
    id: row.id,
    createdAt: Number(row.created_at) || 0,
    clientCreatedAt: Number(row.client_created_at) || 0,
    deviceName: String(row.device_name || ''),
    sizeBytes: Number(row.size_bytes) || 0,
    sha256: String(row.sha256 || ''),
    keyFingerprint: String(row.key_fingerprint || ''),
    formatVersion: Number(row.format_version) || 1,
    appVersion: String(row.app_version || ''),
  };
}

function backupUploadRateLimit(env) {
  const configured = Number(env && env.BACKUP_UPLOAD_RATE_MAX_REQUESTS);
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, BACKUP_UPLOAD_RATE_MAX_REQUESTS)
    : BACKUP_UPLOAD_RATE_MAX_REQUESTS;
}

async function consumeBackupUploadQuota(env, userId, now = Date.now()) {
  const windowStartedAt = Math.floor(now / BACKUP_UPLOAD_RATE_WINDOW_MS) * BACKUP_UPLOAD_RATE_WINDOW_MS;
  await env.DB.prepare(`
    INSERT INTO service_rate_windows
      (user_id, service, window_started_at, request_count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(user_id, service) DO UPDATE SET
      request_count = CASE
        WHEN service_rate_windows.window_started_at = excluded.window_started_at
          THEN service_rate_windows.request_count + 1
        ELSE 1
      END,
      window_started_at = excluded.window_started_at,
      updated_at = excluded.updated_at
  `).bind(userId, BACKUP_UPLOAD_SERVICE_NAME, windowStartedAt, now).run();
  const row = await env.DB.prepare(`
    SELECT request_count FROM service_rate_windows WHERE user_id = ? AND service = ?
  `).bind(userId, BACKUP_UPLOAD_SERVICE_NAME).first();
  const count = Number(row && row.request_count) || 1;
  return {
    allowed: count <= backupUploadRateLimit(env),
    count,
    retryAfter: Math.max(1, Math.ceil((windowStartedAt + BACKUP_UPLOAD_RATE_WINDOW_MS - now) / 1000)),
  };
}

function checksumHex(value) {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
  }
  try {
    if (value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {}
  return '';
}

function r2Sha256(object) {
  return checksumHex(object && object.checksums && object.checksums.sha256);
}

async function deleteR2Objects(env, keys) {
  const unique = [...new Set((Array.isArray(keys) ? keys : [keys]).map(String).filter(Boolean))];
  if (!unique.length) return true;
  try {
    await env.BACKUPS.delete(unique.length === 1 ? unique[0] : unique);
    return true;
  } catch (error) {
    console.error('backup object cleanup failed', error && error.message);
    return false;
  }
}

async function enforceBackupRetention(env, userId) {
  // The D1 deletion is one atomic statement. Concurrent uploaders may select the same old row, but
  // cannot push the account below the retention limit because every statement computes its offset
  // from the rows visible in that transaction. `rowid` breaks millisecond timestamp ties by insert
  // order. R2 deletion follows; a failed object delete is reconciled as an inaccessible orphan.
  const expired = await env.DB.prepare(`
    DELETE FROM encrypted_backups
    WHERE user_id = ? AND id IN (
      SELECT id FROM encrypted_backups WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )
    RETURNING object_key
  `).bind(userId, userId, BACKUP_RETENTION).all();
  const keys = (expired.results || []).map(row => String(row.object_key || '')).filter(Boolean);
  if (keys.length) await deleteR2Objects(env, keys);
  return keys;
}

async function listedBackupObjects(env, userId) {
  const prefix = `backups/${userId}/`;
  const objects = [];
  let cursor;
  let complete = false;
  // Normal accounts have ten objects. The bound prevents a historical orphan flood from turning a
  // foreground request into unbounded work; later requests continue the cleanup.
  for (let page = 0; page < 10; page += 1) {
    const listed = await env.BACKUPS.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
      include: ['customMetadata'],
    });
    objects.push(...(listed.objects || []));
    if (!listed.truncated) {
      complete = true;
      break;
    }
    if (!listed.cursor || listed.cursor === cursor) break;
    cursor = listed.cursor;
  }
  return { complete, objects };
}

async function reconcileBackupStorage(env, userId, now = Date.now()) {
  const rows = await env.DB.prepare(
    'SELECT id, object_key FROM encrypted_backups WHERE user_id = ?',
  ).bind(userId).all();
  const knownByKey = new Map((rows.results || []).map(row => [String(row.object_key || ''), row]));
  const listed = await listedBackupObjects(env, userId);
  const present = new Set();
  const staleOrphans = [];
  for (const object of listed.objects) {
    const key = String(object && object.key || '');
    if (!key) continue;
    present.add(key);
    if (knownByKey.has(key)) continue;
    const uploadedAt = new Date(object.uploaded).getTime();
    // A put necessarily precedes its D1 insert. Keep recent unmatched objects so a concurrent
    // reconciliation cannot delete a legitimate upload in that small cross-service commit window.
    if (Number.isFinite(uploadedAt) && uploadedAt <= now - BACKUP_ORPHAN_GRACE_MS) {
      staleOrphans.push(key);
    }
  }
  if (staleOrphans.length) await deleteR2Objects(env, staleOrphans);

  let missingRows = 0;
  if (listed.complete) {
    for (const [objectKey, row] of knownByKey) {
      if (!objectKey || present.has(objectKey)) continue;
      await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
        .bind(row.id, userId).run();
      missingRows += 1;
    }
  }
  return { orphanObjects: staleOrphans.length, missingRows, complete: listed.complete };
}

async function maintainBackupStorage(env, userId) {
  try { await enforceBackupRetention(env, userId); }
  catch (error) { console.error('backup retention failed', error && error.message); }
  try { await reconcileBackupStorage(env, userId); }
  catch (error) { console.error('backup reconciliation failed', error && error.message); }
}

async function purgeBackupPair(env, row, userId) {
  if (!await deleteR2Objects(env, row.object_key)) return false;
  try {
    await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
      .bind(row.id, userId).run();
  } catch (error) {
    // The object is already gone. Reconciliation will remove this now-inaccessible metadata row.
    console.error('backup metadata cleanup failed', error && error.message);
    return false;
  }
  return true;
}

async function backupObjectBytes(object) {
  if (object && typeof object.arrayBuffer === 'function') {
    return new Uint8Array(await object.arrayBuffer());
  }
  return new Uint8Array(await new Response(object && object.body).arrayBuffer());
}

async function verifiedBackupBytes(object, row) {
  const expectedSha = String(row.sha256 || '').toLowerCase();
  const expectedSize = Number(row.size_bytes);
  if (!/^[a-f0-9]{64}$/.test(expectedSha)
      || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_BACKUP_BYTES
      || !Number.isSafeInteger(Number(object && object.size)) || Number(object.size) !== expectedSize) {
    return null;
  }
  const metadata = object.customMetadata && typeof object.customMetadata === 'object'
    ? object.customMetadata : {};
  const storedChecksum = r2Sha256(object);
  if (metadata.integrityVersion === '1') {
    if (metadata.sha256 !== expectedSha || Number(metadata.sizeBytes) !== expectedSize
        || metadata.backupId !== row.id || storedChecksum !== expectedSha) return null;
  } else {
    // Objects created before integrityVersion=1 have no SHA-256 R2 metadata. They remain readable,
    // but any checksum or SHA metadata that is present must agree with the authoritative D1 row.
    if ((metadata.sha256 && metadata.sha256 !== expectedSha)
        || (metadata.sizeBytes && Number(metadata.sizeBytes) !== expectedSize)
        || (storedChecksum && storedChecksum !== expectedSha)) return null;
  }

  const bytes = await backupObjectBytes(object);
  if (bytes.length !== expectedSize) return null;
  const actualSha = bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
  if (actualSha !== expectedSha) return null;
  const envelope = inspectBackupEnvelope(bytes);
  if (!envelope || String(envelope.backupId || '').toLowerCase() !== String(row.id || '').toLowerCase()
      || String(envelope.keyFingerprint || '').toLowerCase() !== String(row.key_fingerprint || '').toLowerCase()
      || Number(envelope.createdAt) !== Number(row.client_created_at)
      || String(envelope.appVersion || '') !== String(row.app_version || '')) return null;
  return bytes;
}

async function listBackups(request, env) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  await maintainBackupStorage(env, identity.user_id);
  const result = await env.DB.prepare(`
    SELECT id, created_at, client_created_at, device_name, size_bytes, sha256,
      key_fingerprint, format_version, app_version
    FROM encrypted_backups WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).bind(identity.user_id, BACKUP_RETENTION).all();
  return json({ ok: true, backups: (result.results || []).map(backupJson) });
}

async function putBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  if (!validBackupId(backupId)) return json({ ok: false, message: 'Invalid backup identifier.' }, 400);
  const type = String(request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/octet-stream')) return json({ ok: false, message: 'Encrypted backup body required.' }, 415);
  const declaredLength = Number(request.headers.get('content-length'));
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_BACKUP_BYTES) {
    return json({ ok: false, message: 'Encrypted backups must be 20 MB or smaller.' }, 413);
  }
  const keyFingerprint = String(request.headers.get('x-rcart-key-fingerprint') || '').toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(keyFingerprint)) return json({ ok: false, message: 'Invalid backup key fingerprint.' }, 400);
  const appVersion = String(request.headers.get('x-rcart-app-version') || '').slice(0, 40);
  const clientCreatedAt = Number(request.headers.get('x-rcart-created-at')) || 0;
  const existing = await env.DB.prepare(
    'SELECT id FROM encrypted_backups WHERE id = ? AND user_id = ?',
  ).bind(backupId, identity.user_id).first();
  if (existing) return json({ ok: false, message: 'That backup already exists.' }, 409);

  const quota = await consumeBackupUploadQuota(env, identity.user_id);
  if (!quota.allowed) {
    return json({
      ok: false,
      code: 'backup_rate_limited',
      message: 'Too many backup uploads. Try again later.',
    }, 429, { 'retry-after': String(quota.retryAfter) });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES || bytes.length !== declaredLength) {
    return json({ ok: false, message: 'Encrypted backups must be 20 MB or smaller.' }, 413);
  }
  const envelope = inspectBackupEnvelope(bytes);
  if (!envelope || envelope.backupId !== backupId || envelope.keyFingerprint !== keyFingerprint
      || Number(envelope.createdAt) !== clientCreatedAt
      || String(envelope.appVersion || '') !== appVersion) {
    return json({ ok: false, message: 'Invalid encrypted backup envelope.' }, 400);
  }

  const now = Date.now();
  const objectKey = `backups/${identity.user_id}/${backupId}.rcb`;
  const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const digest = bytesToHex(digestBuffer);
  const stored = await env.BACKUPS.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256: digestBuffer,
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      integrityVersion: '1',
      sha256: digest,
      sizeBytes: String(bytes.length),
      backupId,
      keyFingerprint,
      formatVersion: '1',
    },
  });
  if (!stored) return json({ ok: false, message: 'That backup already exists.' }, 409);
  if (Number(stored.size) !== bytes.length || r2Sha256(stored) !== digest
      || !stored.customMetadata || stored.customMetadata.sha256 !== digest) {
    await deleteR2Objects(env, objectKey);
    throw new Error('R2 did not confirm the backup checksum.');
  }
  try {
    await env.DB.prepare(`
      INSERT INTO encrypted_backups
        (id, user_id, object_key, created_at, client_created_at, device_id, device_name,
          size_bytes, sha256, key_fingerprint, format_version, app_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      backupId, identity.user_id, objectKey, now, clientCreatedAt,
      identity.device_id, String(identity.device_name || '').slice(0, 100),
      bytes.length, digest, keyFingerprint, appVersion,
    ).run();
  } catch (error) {
    await deleteR2Objects(env, objectKey);
    throw error;
  }

  // The new row is authoritative even if best-effort maintenance encounters a transient R2/D1
  // failure. A later upload or list retries retention and orphan cleanup without making the client
  // retry an upload that already committed.
  await maintainBackupStorage(env, identity.user_id);

  return json({
    ok: true,
    backup: backupJson({
      id: backupId,
      created_at: now,
      client_created_at: clientCreatedAt,
      device_name: identity.device_name,
      size_bytes: bytes.length,
      sha256: digest,
      key_fingerprint: keyFingerprint,
      format_version: 1,
      app_version: appVersion,
    }),
  }, 201);
}

async function getBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  const row = await env.DB.prepare(`
    SELECT * FROM encrypted_backups WHERE id = ? AND user_id = ?
  `).bind(backupId, identity.user_id).first();
  if (!row) return json({ ok: false, message: 'Backup not found.' }, 404);
  const object = await env.BACKUPS.get(row.object_key);
  if (!object) {
    try {
      await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
        .bind(backupId, identity.user_id).run();
    } catch (error) { console.error('missing backup metadata cleanup failed', error && error.message); }
    return json({ ok: false, message: 'Backup not found.' }, 404);
  }
  let bytes;
  try { bytes = await verifiedBackupBytes(object, row); }
  catch (error) {
    // A transient body-read failure is not evidence that the stored bytes are corrupt. Keep the
    // only encrypted copy intact and let the authenticated client retry.
    console.error('backup integrity verification unavailable', error && error.message);
    return json({
      ok: false,
      code: 'backup_read_failed',
      message: 'The encrypted backup could not be read right now. Try again.',
    }, 503);
  }
  if (!bytes) {
    await purgeBackupPair(env, row, identity.user_id);
    return json({
      ok: false,
      code: 'backup_integrity_failed',
      message: 'The stored backup failed an integrity check and was removed.',
    }, 502);
  }
  return new Response(bytes, {
    headers: apiHeaders({
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-rcart-backup-sha256': String(row.sha256),
    }),
  });
}

async function deleteBackup(request, env, backupId) {
  const identity = await authenticatedLicense(request, env);
  if (!identity) return json({ ok: false, code: 'license_invalid', message: 'Sign in again to access backups.' }, 401);
  const row = await env.DB.prepare(
    'SELECT object_key FROM encrypted_backups WHERE id = ? AND user_id = ?',
  ).bind(backupId, identity.user_id).first();
  if (!row) return json({ ok: false, message: 'Backup not found.' }, 404);
  await env.BACKUPS.delete(row.object_key);
  await env.DB.prepare('DELETE FROM encrypted_backups WHERE id = ? AND user_id = ?')
    .bind(backupId, identity.user_id).run();
  return json({ ok: true });
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function adminCookie(env) {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_MS, nonce: randomToken(12) })));
  return `${payload}.${await hmac(payload, env.ADMIN_SESSION_SECRET)}`;
}

function cookieValue(request, name) {
  for (const pair of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

async function adminAuthorized(request, env) {
  const value = cookieValue(request, 'hope_admin');
  const [payload, signature] = value.split('.');
  if (!payload || !signature || !constantTimeEqual(signature, await hmac(payload, env.ADMIN_SESSION_SECRET))) return false;
  try {
    const session = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return Number(session.exp) > Date.now();
  } catch {
    return false;
  }
}

function adminSetCookie(value, maxAge = Math.floor(ADMIN_SESSION_MS / 1000)) {
  return `hope_admin=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function audit(env, action, user = null, detail = '') {
  await env.DB.prepare(`
    INSERT INTO admin_audit (id, action, target_user_id, target_email, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), action, user && user.id, user && user.email, detail, Date.now()).run();
}

export function downloadSiteOrigin(request, env = {}) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === 'license.rcart.app' || hostname === 'license.zynbot.app') return DOWNLOAD_SITE_ORIGIN;
  const configured = String(env.DOWNLOAD_SITE_ORIGIN || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return DOWNLOAD_SITE_ORIGIN;
}

async function mintDownloadLink(request, env, user) {
  if (!Number(user.active)) {
    const error = new Error('Enable this account before generating a download link.');
    error.code = 'ACCOUNT_DISABLED';
    throw error;
  }
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + DOWNLOAD_ACCESS_TTL_MS;
  await env.DB.batch([
    // Only the newest unused invitation remains valid. Consumed rows are retained for the audit
    // trail until normal database maintenance removes them.
    env.DB.prepare(`
      DELETE FROM download_access_tokens WHERE user_id = ? AND consumed_at IS NULL
    `).bind(user.id),
    env.DB.prepare(`
      INSERT INTO download_access_tokens
        (id, user_id, token_hash, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).bind(crypto.randomUUID(), user.id, await sha256(token), now, expiresAt),
  ]);
  await audit(env, 'download_link_generated', user, String(expiresAt));
  const origin = downloadSiteOrigin(request, env);
  return {
    downloadUrl: `${origin}/download?key=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

async function createDownloadLink(request, env, user) {
  try {
    return json({ ok: true, ...await mintDownloadLink(request, env, user) });
  } catch (error) {
    if (error && error.code === 'ACCOUNT_DISABLED') return json({ ok: false, message: error.message }, 409);
    throw error;
  }
}

function validOpaqueToken(value) {
  return /^[A-Za-z0-9_-]{40,128}$/.test(String(value || ''));
}

async function redeemDownloadAccess(request, env) {
  const body = await bodyJson(request);
  const token = String(body.key || '');
  const now = Date.now();

  const row = validOpaqueToken(token) ? await env.DB.prepare(`
    SELECT t.id, t.user_id
    FROM download_access_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ? AND u.active = 1
  `).bind(await sha256(token), now).first() : null;
  if (!row) {
    return json({ ok: false, code: 'invalid_download_key', message: 'This download link is invalid or has expired.' }, 401);
  }

  // The conditional update is the single-use boundary. If two requests race, exactly one can
  // consume the key and mint a browser session.
  const consumed = await env.DB.prepare(`
    UPDATE download_access_tokens SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
  `).bind(now, row.id, now).run();
  if (!Number(consumed.meta && consumed.meta.changes)) {
    return json({ ok: false, code: 'invalid_download_key', message: 'This download link is invalid or has expired.' }, 401);
  }

  const sessionToken = randomToken();
  const expiresAt = now + DOWNLOAD_SESSION_MS;
  await env.DB.prepare(`
    INSERT INTO download_sessions
      (id, user_id, session_hash, created_at, expires_at, last_seen_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).bind(crypto.randomUUID(), row.user_id, await sha256(sessionToken), now, expiresAt, now).run();
  return json({ ok: true, sessionToken, expiresAt });
}

async function validateDownloadSession(request, env) {
  const body = await bodyJson(request);
  const sessionToken = String(body.sessionToken || '');
  if (!validOpaqueToken(sessionToken)) return json({ ok: false, code: 'download_session_invalid' }, 401);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT s.id, s.expires_at
    FROM download_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1
  `).bind(await sha256(sessionToken), now).first();
  if (!row) return json({ ok: false, code: 'download_session_invalid' }, 401);
  await env.DB.prepare('UPDATE download_sessions SET last_seen_at = ? WHERE id = ?')
    .bind(now, row.id).run();
  return json({ ok: true, expiresAt: Number(row.expires_at) });
}

async function adminLogin(request, env) {
  const body = await bodyJson(request);
  const password = String(body.password || '');
  const now = Date.now();
  const key = await rateKey('admin-login', 'admin', request);
  const retryAfter = await rateBlocked(env, key, now);
  if (retryAfter) return json({ ok: false, message: 'Too many attempts. Try again later.' }, 429, { 'retry-after': String(retryAfter) });

  const supplied = await sha256(password);
  const expected = await sha256(env.ADMIN_PASSWORD || randomToken());
  if (!constantTimeEqual(supplied, expected)) {
    await rateFailure(env, key, now);
    return json({ ok: false, message: 'Invalid admin password.' }, 401);
  }
  await rateSuccess(env, key);
  return json({ ok: true }, 200, { 'set-cookie': adminSetCookie(await adminCookie(env)) });
}

async function adminUsers(env) {
  const [result, taskTypes, overrideResult] = await Promise.all([
    env.DB.prepare(`
    SELECT u.id, u.email, u.active, u.proxy_access, u.must_reset_password,
      u.max_active_devices, u.created_at, u.updated_at, u.last_login_at,
      u.stripe_customer_id, u.stripe_subscription_id, u.billing_plan, u.billing_status, u.access_until,
      COUNT(DISTINCT CASE
        WHEN l.revoked_at IS NULL AND l.expires_at > ? THEN l.device_id
      END) AS active_licenses,
      MAX(l.last_validated_at) AS last_validated_at
    FROM users u LEFT JOIN licenses l ON l.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).bind(Date.now()).all(),
    taskTypeDefinitions(env),
    env.DB.prepare('SELECT user_id, task_type, enabled FROM user_task_type_access').all(),
  ]);
  const overridesByUser = new Map();
  for (const row of (overrideResult.results || [])) {
    if (!overridesByUser.has(row.user_id)) overridesByUser.set(row.user_id, new Map());
    overridesByUser.get(row.user_id).set(row.task_type, Number(row.enabled) === 1);
  }
  const users = (result.results || []).map(user => {
    const overrides = overridesByUser.get(user.id) || new Map();
    return {
      ...user,
      task_types: Object.fromEntries(taskTypes.map(type => {
        const override = overrides.has(type.key) ? overrides.get(type.key) : null;
        return [type.key, {
          override,
          enabled: override === null ? type.enabledForAll : override,
        }];
      })),
    };
  });
  return json({ ok: true, taskTypes, users });
}

async function adminAnalyticsDashboard(env, url) {
  const window = analyticsWindow(url);
  const [summary, series] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(DISTINCT e.user_id) AS active_users,
        SUM(CASE WHEN e.event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
        SUM(CASE WHEN e.event_type = 'decline' THEN 1 ELSE 0 END) AS declines,
        SUM(CASE WHEN e.event_type = 'checkout' THEN e.total_cents ELSE 0 END) AS total_spent_cents,
        SUM(CASE WHEN e.event_type = 'carted' AND NOT EXISTS (
          SELECT 1 FROM analytics_events terminal
          WHERE terminal.user_id = e.user_id
            AND e.run_id != '' AND terminal.run_id = e.run_id
            AND terminal.event_type IN ('checkout', 'decline')
            AND terminal.occurred_at >= e.occurred_at
        ) THEN 1 ELSE 0 END) AS stuck_in_cart
      FROM analytics_events e
      WHERE e.occurred_at >= ? AND e.occurred_at < ?
    `).bind(window.from, window.to).first(),
    env.DB.prepare(`
      SELECT date(occurred_at / 1000, 'unixepoch') AS day,
        COUNT(DISTINCT user_id) AS active_users,
        SUM(CASE WHEN event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
        SUM(CASE WHEN event_type = 'decline' THEN 1 ELSE 0 END) AS declines,
        SUM(CASE WHEN event_type = 'checkout' THEN total_cents ELSE 0 END) AS total_spent_cents
      FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ?
      GROUP BY day ORDER BY day ASC LIMIT 4000
    `).bind(window.from, window.to).all(),
  ]);
  return json({
    ok: true,
    window,
    summary: {
      activeUsers: Number(summary && summary.active_users) || 0,
      checkouts: Number(summary && summary.checkouts) || 0,
      declines: Number(summary && summary.declines) || 0,
      totalSpentCents: Number(summary && summary.total_spent_cents) || 0,
      stuckInCart: Number(summary && summary.stuck_in_cart) || 0,
    },
    series: (series.results || []).map(row => ({
      day: String(row.day || ''),
      activeUsers: Number(row.active_users) || 0,
      checkouts: Number(row.checkouts) || 0,
      declines: Number(row.declines) || 0,
      totalSpentCents: Number(row.total_spent_cents) || 0,
    })),
  });
}

async function adminAnalyticsUsers(env, url) {
  const window = analyticsWindow(url);
  const page = analyticsInteger(Number(url.searchParams.get('page')), 1, 1000000, 1);
  const pageSize = analyticsInteger(Number(url.searchParams.get('pageSize')), 1, 100, 20);
  const search = analyticsText(url.searchParams.get('search'), 120);
  const like = `%${search}%`;
  const filter = `e.occurred_at >= ? AND e.occurred_at < ?
    AND (? = '' OR u.email LIKE ? COLLATE NOCASE)`;
  const bindings = [window.from, window.to, search, like];
  const [totalRow, rows] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(DISTINCT e.user_id) AS total
      FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${filter}
    `).bind(...bindings).first(),
    env.DB.prepare(`
      SELECT u.id AS user_id, u.email, u.active,
        SUM(CASE WHEN e.event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
        SUM(CASE WHEN e.event_type = 'decline' THEN 1 ELSE 0 END) AS declines,
        SUM(CASE WHEN e.event_type = 'checkout' THEN e.total_cents ELSE 0 END) AS total_spent_cents,
        SUM(CASE WHEN e.event_type = 'carted' AND NOT EXISTS (
          SELECT 1 FROM analytics_events terminal
          WHERE terminal.user_id = e.user_id
            AND e.run_id != '' AND terminal.run_id = e.run_id
            AND terminal.event_type IN ('checkout', 'decline')
            AND terminal.occurred_at >= e.occurred_at
        ) THEN 1 ELSE 0 END) AS stuck_in_cart,
        MAX(CASE WHEN e.event_type = 'checkout' THEN e.occurred_at ELSE NULL END) AS last_checkout_at,
        MAX(e.occurred_at) AS last_event_at
      FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${filter}
      GROUP BY u.id, u.email, u.active
      ORDER BY total_spent_cents DESC, checkouts DESC, last_event_at DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, pageSize, (page - 1) * pageSize).all(),
  ]);
  return json({
    ok: true,
    window,
    page,
    pageSize,
    total: Number(totalRow && totalRow.total) || 0,
    users: (rows.results || []).map(row => ({
      userId: row.user_id,
      email: row.email,
      active: Number(row.active) === 1,
      checkouts: Number(row.checkouts) || 0,
      declines: Number(row.declines) || 0,
      totalSpentCents: Number(row.total_spent_cents) || 0,
      stuckInCart: Number(row.stuck_in_cart) || 0,
      lastCheckoutAt: Number(row.last_checkout_at) || 0,
      lastEventAt: Number(row.last_event_at) || 0,
    })),
  });
}

async function adminAnalyticsCheckouts(env, url) {
  const window = analyticsWindow(url);
  const page = analyticsInteger(Number(url.searchParams.get('page')), 1, 1000000, 1);
  const pageSize = analyticsInteger(Number(url.searchParams.get('pageSize')), 1, 100, 20);
  const search = analyticsText(url.searchParams.get('search'), 120);
  const like = `%${search}%`;
  const filter = `e.event_type = 'checkout' AND e.occurred_at >= ? AND e.occurred_at < ?
    AND (? = '' OR u.email LIKE ? COLLATE NOCASE OR e.site LIKE ? COLLATE NOCASE
      OR e.order_number LIKE ? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM analytics_items ai
        WHERE ai.user_id = e.user_id AND ai.event_id = e.event_id
          AND (ai.name LIKE ? COLLATE NOCASE OR ai.sku LIKE ? COLLATE NOCASE)
      ))`;
  const bindings = [window.from, window.to, search, like, like, like, like, like];
  const [totalRow, rows] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM analytics_events e JOIN users u ON u.id = e.user_id
      WHERE ${filter}
    `).bind(...bindings).first(),
    env.DB.prepare(`
      SELECT e.user_id, u.email, e.event_id, e.site, e.order_number, e.total_cents, e.occurred_at,
        i.line_number, i.sku, i.name, i.image, i.product_url, i.size, i.unit_price_cents, i.quantity
      FROM (
        SELECT e.* FROM analytics_events e JOIN users u ON u.id = e.user_id
        WHERE ${filter}
        ORDER BY e.occurred_at DESC LIMIT ? OFFSET ?
      ) e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN analytics_items i ON i.user_id = e.user_id AND i.event_id = e.event_id
      ORDER BY e.occurred_at DESC, i.line_number ASC
    `).bind(...bindings, pageSize, (page - 1) * pageSize).all(),
  ]);
  const checkouts = [];
  const byId = new Map();
  for (const row of (rows.results || [])) {
    const key = `${row.user_id}\u0000${row.event_id}`;
    let checkout = byId.get(key);
    if (!checkout) {
      checkout = {
        userId: row.user_id, email: row.email, eventId: row.event_id, site: row.site,
        orderNumber: row.order_number, totalCents: Number(row.total_cents) || 0,
        occurredAt: Number(row.occurred_at) || 0, items: [],
      };
      byId.set(key, checkout);
      checkouts.push(checkout);
    }
    if (row.line_number != null) checkout.items.push({
      sku: row.sku, name: row.name, image: row.image, productUrl: row.product_url, size: row.size,
      unitPriceCents: Number(row.unit_price_cents) || 0, quantity: Number(row.quantity) || 1,
    });
  }
  return json({
    ok: true, window, page, pageSize,
    total: Number(totalRow && totalRow.total) || 0,
    checkouts,
  });
}

async function adminTaskTypes(env) {
  return json({ ok: true, taskTypes: await taskTypeDefinitions(env) });
}

async function updateTaskType(request, env, key) {
  const supported = TASK_TYPE_REGISTRY.find(type => type.key === key);
  if (!supported) return json({ ok: false, message: 'Task type not found.' }, 404);
  const body = await bodyJson(request);
  if (typeof body.enabledForAll !== 'boolean') {
    return json({ ok: false, message: 'enabledForAll must be true or false.' }, 400);
  }
  await ensureTaskTypeRegistry(env);
  const now = Date.now();
  const statements = [env.DB.prepare(`
    UPDATE task_types SET enabled_for_all = ?, updated_at = ? WHERE key = ?
  `).bind(body.enabledForAll ? 1 : 0, now, key)];
  // "Enable globally" means every current user gets access immediately. Clear explicit denies;
  // the operator can add a new per-user Disabled override afterward if an exception is needed.
  if (body.enabledForAll) {
    statements.push(env.DB.prepare(`
      DELETE FROM user_task_type_access WHERE task_type = ? AND enabled = 0
    `).bind(key));
  }
  await env.DB.batch(statements);
  await audit(env, body.enabledForAll ? 'task_type_global_enabled' : 'task_type_global_disabled', null, key);
  return json({ ok: true, key, enabledForAll: body.enabledForAll });
}

async function createUserRecord(env, email, auditDetail = '') {
  const password = randomPassword();
  const record = await newPasswordRecord(password, env);
  const user = { id: crypto.randomUUID(), email };
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO users
      (id, email, password_hash, password_salt, password_iterations, must_reset_password, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).bind(user.id, email, record.hash, record.salt, record.iterations, now, now).run();
  await audit(env, 'user_created', user, auditDetail);
  return {
    user: {
      ...user,
      active: 1,
      proxy_access: 0,
      must_reset_password: 1,
      max_active_devices: MIN_ACTIVE_DEVICES,
    },
    temporaryPassword: password,
  };
}

async function createUser(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, message: 'Enter a valid email address.' }, 400);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ ok: false, message: 'That email already exists.' }, 409);

  const created = await createUserRecord(env, email);
  return json({
    ok: true,
    ...created,
  }, 201);
}

async function joinWaitlist(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, message: 'Enter a valid email address.' }, 400);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO waitlist_entries (id, email, created_at, updated_at, invited_at, user_id)
    VALUES (?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), email, now, now).run();
  // Always return the same response for new and existing addresses so this public endpoint cannot
  // be used to enumerate the waiting list.
  return json({ ok: true, message: 'You are on the Zyn waiting list.' }, 202);
}

async function adminWaitlist(env) {
  const result = await env.DB.prepare(`
    SELECT w.id, w.email, w.created_at, w.updated_at, w.invited_at, w.user_id,
      u.active AS user_active, u.must_reset_password
    FROM waitlist_entries w
    LEFT JOIN users u ON u.id = w.user_id
    ORDER BY CASE WHEN w.invited_at IS NULL THEN 0 ELSE 1 END, w.created_at DESC
  `).all();
  return json({ ok: true, entries: result.results || [] });
}

async function inviteWaitlistEntry(request, env, id) {
  const entry = await env.DB.prepare(`
    SELECT id, email, invited_at, user_id FROM waitlist_entries WHERE id = ?
  `).bind(id).first();
  if (!entry) return json({ ok: false, message: 'Waiting-list entry not found.' }, 404);

  let user = await env.DB.prepare(`
    SELECT id, email, active, proxy_access, must_reset_password, max_active_devices
    FROM users WHERE email = ?
  `).bind(entry.email).first();
  let temporaryPassword = '';
  let accountCreated = false;
  if (!user) {
    const created = await createUserRecord(env, entry.email, 'waitlist_invite');
    user = created.user;
    temporaryPassword = created.temporaryPassword;
    accountCreated = true;
  }
  if (!Number(user.active)) {
    return json({ ok: false, message: 'This email already has a disabled account. Enable it before inviting.' }, 409);
  }

  const download = await mintDownloadLink(request, env, user);
  const invitedAt = Date.now();
  await env.DB.prepare(`
    UPDATE waitlist_entries SET invited_at = ?, updated_at = ?, user_id = ? WHERE id = ?
  `).bind(invitedAt, invitedAt, user.id, entry.id).run();
  await audit(env, 'waitlist_invited', user, entry.id);
  return json({
    ok: true,
    entry: { ...entry, invited_at: invitedAt, user_id: user.id },
    user,
    accountCreated,
    temporaryPassword,
    ...download,
  }, accountCreated ? 201 : 200);
}

async function deleteWaitlistEntry(env, id) {
  const entry = await env.DB.prepare('SELECT id, email FROM waitlist_entries WHERE id = ?').bind(id).first();
  if (!entry) return json({ ok: false, message: 'Waiting-list entry not found.' }, 404);
  await env.DB.prepare('DELETE FROM waitlist_entries WHERE id = ?').bind(id).run();
  await audit(env, 'waitlist_entry_deleted', null, entry.email);
  return json({ ok: true });
}

async function adminUser(env, id) {
  return env.DB.prepare(
    `SELECT id, email, active, proxy_access, must_reset_password, max_active_devices
      FROM users WHERE id = ?`,
  ).bind(id).first();
}

async function revokeUser(env, user, reason = 'admin_revoked') {
  const result = await env.DB.prepare(`
    UPDATE licenses SET revoked_at = ?, revoked_reason = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(Date.now(), reason, user.id).run();
  await audit(env, 'licenses_revoked', user, String(result.meta && result.meta.changes || 0));
  return json({ ok: true, revoked: result.meta && result.meta.changes || 0 });
}

async function resetUserPassword(env, user) {
  const password = randomPassword();
  const record = await newPasswordRecord(password, env);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
        must_reset_password = 1, updated_at = ? WHERE id = ?
    `).bind(record.hash, record.salt, record.iterations, now, user.id),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.id),
    env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'admin_password_reset'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id),
  ]);
  await audit(env, 'password_reset_generated', user);
  return json({ ok: true, temporaryPassword: password });
}

async function updateUser(request, env, user) {
  const body = await bodyJson(request);
  const now = Date.now();
  const statements = [];
  let active = Number(user.active) === 1;
  let proxyAccess = Number(user.proxy_access) === 1;
  let maxActiveDevices = maxActiveDevicesForUser(user);
  const previousMaxActiveDevices = maxActiveDevices;
  const changesMaxActiveDevices = Object.hasOwn(body, 'maxActiveDevices');
  if (changesMaxActiveDevices && !validMaxActiveDevices(body.maxActiveDevices)) {
    return json({ ok: false, message: 'Active-device limit must be a whole number from 1 to 10.' }, 400);
  }
  if (typeof body.active === 'boolean') {
    active = body.active;
    statements.push(env.DB.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?')
      .bind(active ? 1 : 0, now, user.id));
    if (!active) statements.push(env.DB.prepare(`
      UPDATE licenses SET revoked_at = ?, revoked_reason = 'account_disabled'
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id));
    if (!active) statements.push(env.DB.prepare(`
      UPDATE download_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(now, user.id));
  }
  if (typeof body.proxyAccess === 'boolean') {
    proxyAccess = body.proxyAccess;
    statements.push(env.DB.prepare('UPDATE users SET proxy_access = ?, updated_at = ? WHERE id = ?')
      .bind(proxyAccess ? 1 : 0, now, user.id));
  }
  let devicePruneIndex = -1;
  if (changesMaxActiveDevices) {
    maxActiveDevices = body.maxActiveDevices;
    const deviceStatements = activeDeviceLimitStatements(env.DB, {
      userId: user.id,
      maxActiveDevices,
      now,
    });
    devicePruneIndex = statements.length + 1;
    statements.push(...deviceStatements);
  }
  const taskTypeChanges = [];
  if (body.taskTypeOverrides && typeof body.taskTypeOverrides === 'object' && !Array.isArray(body.taskTypeOverrides)) {
    await ensureTaskTypeRegistry(env);
    for (const type of TASK_TYPE_REGISTRY) {
      if (!Object.hasOwn(body.taskTypeOverrides, type.key)) continue;
      const override = body.taskTypeOverrides[type.key];
      if (override === null) {
        statements.push(env.DB.prepare(`
          DELETE FROM user_task_type_access WHERE user_id = ? AND task_type = ?
        `).bind(user.id, type.key));
      } else if (typeof override === 'boolean') {
        statements.push(env.DB.prepare(`
          INSERT INTO user_task_type_access (user_id, task_type, enabled, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, task_type) DO UPDATE SET
            enabled = excluded.enabled, updated_at = excluded.updated_at
        `).bind(user.id, type.key, override ? 1 : 0, now));
      } else {
        return json({ ok: false, message: `${type.label} access must be enabled, disabled, or inherited.` }, 400);
      }
      taskTypeChanges.push({ type, override });
    }
  }
  if (!statements.length) return json({ ok: false, message: 'No supported changes supplied.' }, 400);
  const results = await env.DB.batch(statements);
  const revoked = devicePruneIndex >= 0
    ? Number(results[devicePruneIndex] && results[devicePruneIndex].meta && results[devicePruneIndex].meta.changes) || 0
    : 0;
  if (typeof body.active === 'boolean') await audit(env, active ? 'user_enabled' : 'user_disabled', user);
  if (typeof body.proxyAccess === 'boolean') {
    await audit(env, proxyAccess ? 'proxy_access_enabled' : 'proxy_access_disabled', user);
  }
  for (const change of taskTypeChanges) {
    const mode = change.override === null ? 'inherit' : (change.override ? 'enabled' : 'disabled');
    await audit(env, 'user_task_type_changed', user, `${change.type.key}:${mode}`);
  }
  if (changesMaxActiveDevices) {
    await audit(
      env,
      'active_device_limit_changed',
      user,
      `${previousMaxActiveDevices}->${maxActiveDevices};revoked:${revoked}`,
    );
  }
  return json({
    ok: true,
    active,
    proxyAccess,
    maxActiveDevices,
    revoked,
    taskTypes: await taskTypeEntitlements(env, user),
  });
}

async function deleteUser(env, user) {
  let backupObjects = [];
  try {
    const backups = await env.DB.prepare(
      'SELECT object_key FROM encrypted_backups WHERE user_id = ?',
    ).bind(user.id).all();
    backupObjects = (backups.results || []).map(row => String(row.object_key || '')).filter(Boolean);
  } catch (error) {
    // During a rolling deployment the table may not exist yet. No objects can exist before that
    // migration, so only that exact compatibility case may continue without object cleanup.
    if (!/no such table:\s*encrypted_backups/i.test(String(error && error.message || error))) throw error;
  }
  if (backupObjects.length && !await deleteR2Objects(env, backupObjects)) {
    // Keep the user and D1 rows so the deletion can be retried. Cascading the rows first would leave
    // encrypted R2 objects with no owner metadata and no authenticated request able to reconcile them.
    return json({ ok: false, message: 'Encrypted backup cleanup failed. Try deleting the account again.' }, 503);
  }
  await audit(env, 'user_deleted', user);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return json({ ok: true });
}

async function adminProxyLists(env) {
  const result = await env.DB.prepare(`
    SELECT id, name, encrypted_raw, iv, proxy_count, created_at, updated_at
    FROM managed_proxy_lists ORDER BY name COLLATE NOCASE
  `).all();
  const lists = [];
  for (const row of (result.results || [])) {
    try {
      lists.push({
        id: row.id,
        name: row.name,
        raw: await decryptProxyList(row, env),
        count: Number(row.proxy_count) || 0,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
      });
    } catch {
      lists.push({
        id: row.id,
        name: row.name,
        raw: '',
        count: Number(row.proxy_count) || 0,
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
        decryptError: true,
      });
    }
  }
  return json({ ok: true, proxyLists: lists });
}

async function adminHyperCredential(env) {
  return json({ ok: true, ...serviceCredentialJson(await serviceCredentialRow(env, HYPER_SERVICE_NAME)) });
}

async function putHyperCredential(request, env) {
  const input = hyperCredentialInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const encrypted = await encryptServiceCredential(HYPER_SERVICE_NAME, input.apiKey, env);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO service_config
      (name, encrypted_value, iv, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      iv = excluded.iv,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
  `).bind(
    HYPER_SERVICE_NAME,
    encrypted.encryptedValue,
    encrypted.iv,
    encrypted.fingerprint,
    now,
    now,
  ).run();
  await audit(env, 'service_credential_updated', null, `${HYPER_SERVICE_NAME}:${encrypted.fingerprint}`);
  return json({ ok: true, configured: true, fingerprint: encrypted.fingerprint, updatedAt: now });
}

async function deleteHyperCredential(env) {
  const current = await serviceCredentialRow(env, HYPER_SERVICE_NAME);
  if (current) {
    await env.DB.prepare('DELETE FROM service_config WHERE name = ?').bind(HYPER_SERVICE_NAME).run();
    await audit(env, 'service_credential_deleted', null, `${HYPER_SERVICE_NAME}:${current.fingerprint}`);
  }
  return json({ ok: true, ...serviceCredentialJson(null) });
}

async function adminPokemonQueueCredential(env) {
  return json({
    ok: true,
    ...await pokemonQueueVersionJson(env),
    ...serviceCredentialJson(await serviceCredentialRow(env, POKEMON_QUEUE_SERVICE_NAME)),
  });
}

async function refreshPokemonQueueVersion(_request, env) {
  const result = await refreshPolarUpstreamVersion(env);
  const version = await pokemonQueueVersionJson(env);
  const credential = serviceCredentialJson(await serviceCredentialRow(env, POKEMON_QUEUE_SERVICE_NAME));
  if (!result.ok) {
    return json({
      ok: false,
      message: 'Could not read the latest Polar release.',
      reason: result.reason || '',
      ...version,
      ...credential,
    }, 502);
  }
  return json({
    ok: true,
    changed: result.changed === true,
    message: result.changed
      ? `Polar websocket version is now ${result.version}.`
      : `Polar websocket is already ${result.version}.`,
    ...version,
    ...credential,
  });
}

async function putPokemonQueueCredential(request, env) {
  const input = pokemonQueueCredentialInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const encrypted = await encryptServiceCredential(POKEMON_QUEUE_SERVICE_NAME, input.licenseKey, env);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO service_config
      (name, encrypted_value, iv, fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      iv = excluded.iv,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
  `).bind(
    POKEMON_QUEUE_SERVICE_NAME,
    encrypted.encryptedValue,
    encrypted.iv,
    encrypted.fingerprint,
    now,
    now,
  ).run();
  await audit(env, 'service_credential_updated', null, `${POKEMON_QUEUE_SERVICE_NAME}:${encrypted.fingerprint}`);
  await notifyPokemonQueueRelay(env);
  return json({
    ok: true,
    configured: true,
    fingerprint: encrypted.fingerprint,
    updatedAt: now,
    ...await pokemonQueueVersionJson(env),
  });
}

async function deletePokemonQueueCredential(env) {
  const current = await serviceCredentialRow(env, POKEMON_QUEUE_SERVICE_NAME);
  if (current) {
    await env.DB.prepare('DELETE FROM service_config WHERE name = ?').bind(POKEMON_QUEUE_SERVICE_NAME).run();
    await audit(env, 'service_credential_deleted', null, `${POKEMON_QUEUE_SERVICE_NAME}:${current.fingerprint}`);
  }
  await notifyPokemonQueueRelay(env);
  return json({ ok: true, ...await pokemonQueueVersionJson(env), ...serviceCredentialJson(null) });
}

async function createProxyList(request, env) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM managed_proxy_lists').first();
  if (Number(count && count.count) >= MAX_MANAGED_LISTS) {
    return json({ ok: false, message: `A maximum of ${MAX_MANAGED_LISTS} managed lists is supported.` }, 409);
  }
  const input = proxyListInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const existing = await env.DB.prepare('SELECT id FROM managed_proxy_lists WHERE name = ?')
    .bind(input.name).first();
  if (existing) return json({ ok: false, message: 'A proxy list with that name already exists.' }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  let encrypted;
  try { encrypted = await encryptProxyList(input.raw, env); }
  catch (error) {
    if (error && error.code === 'PROXY_STORAGE_LIMIT') return json({ ok: false, message: error.message }, 400);
    throw error;
  }
  await env.DB.prepare(`
    INSERT INTO managed_proxy_lists
      (id, name, encrypted_raw, iv, proxy_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, input.name, encrypted.encryptedRaw, encrypted.iv, input.count, now, now).run();
  await audit(env, 'proxy_list_created', null, `${input.name}:${input.count}`);
  return json({
    ok: true,
    proxyList: { id, name: input.name, count: input.count, createdAt: now, updatedAt: now },
  }, 201);
}

async function updateProxyList(request, env, id) {
  const current = await env.DB.prepare('SELECT id, name FROM managed_proxy_lists WHERE id = ?').bind(id).first();
  if (!current) return json({ ok: false, message: 'Proxy list not found.' }, 404);
  const input = proxyListInput(await bodyJson(request));
  if (input.error) return json({ ok: false, message: input.error }, 400);
  const existing = await env.DB.prepare('SELECT id FROM managed_proxy_lists WHERE name = ? AND id != ?')
    .bind(input.name, id).first();
  if (existing) return json({ ok: false, message: 'A proxy list with that name already exists.' }, 409);
  const now = Date.now();
  let encrypted;
  try { encrypted = await encryptProxyList(input.raw, env); }
  catch (error) {
    if (error && error.code === 'PROXY_STORAGE_LIMIT') return json({ ok: false, message: error.message }, 400);
    throw error;
  }
  await env.DB.prepare(`
    UPDATE managed_proxy_lists
    SET name = ?, encrypted_raw = ?, iv = ?, proxy_count = ?, updated_at = ? WHERE id = ?
  `).bind(input.name, encrypted.encryptedRaw, encrypted.iv, input.count, now, id).run();
  await audit(env, 'proxy_list_updated', null, `${input.name}:${input.count}`);
  return json({
    ok: true,
    proxyList: { id, name: input.name, count: input.count, updatedAt: now },
  });
}

async function deleteProxyList(env, id) {
  const current = await env.DB.prepare('SELECT id, name FROM managed_proxy_lists WHERE id = ?').bind(id).first();
  if (!current) return json({ ok: false, message: 'Proxy list not found.' }, 404);
  await env.DB.prepare('DELETE FROM managed_proxy_lists WHERE id = ?').bind(id).run();
  await audit(env, 'proxy_list_deleted', null, current.name);
  return json({ ok: true });
}

async function adminRoute(request, env, url) {
  if (url.pathname === '/api/admin/login' && request.method === 'POST') return adminLogin(request, env);

  if (request.headers.get('x-hope-admin') !== '1' || !await adminAuthorized(request, env)) {
    return json({ ok: false, message: 'Admin authentication required.' }, 401);
  }
  if (url.pathname === '/api/admin/session' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': adminSetCookie('', 0) });
  }
  if (url.pathname === '/api/admin/users' && request.method === 'GET') return adminUsers(env);
  if (url.pathname === '/api/admin/users' && request.method === 'POST') return createUser(request, env);
  if (url.pathname === '/api/admin/analytics/dashboard' && request.method === 'GET') return adminAnalyticsDashboard(env, url);
  if (url.pathname === '/api/admin/analytics/users' && request.method === 'GET') return adminAnalyticsUsers(env, url);
  if (url.pathname === '/api/admin/analytics/checkouts' && request.method === 'GET') return adminAnalyticsCheckouts(env, url);
  if (url.pathname.startsWith('/api/admin/analytics')) return json({ ok: false, message: 'Method not allowed.' }, 405);
  if (url.pathname === '/api/admin/waitlist' && request.method === 'GET') return adminWaitlist(env);
  if (url.pathname === '/api/admin/task-types' && request.method === 'GET') return adminTaskTypes(env);
  if (url.pathname === '/api/admin/proxy-lists' && request.method === 'GET') return adminProxyLists(env);
  if (url.pathname === '/api/admin/proxy-lists' && request.method === 'POST') return createProxyList(request, env);
  if (url.pathname === '/api/admin/service-config/hyper' && request.method === 'GET') return adminHyperCredential(env);
  if (url.pathname === '/api/admin/service-config/hyper' && request.method === 'PUT') return putHyperCredential(request, env);
  if (url.pathname === '/api/admin/service-config/hyper' && request.method === 'DELETE') return deleteHyperCredential(env);
  if (url.pathname === '/api/admin/service-config/hyper') return json({ ok: false, message: 'Method not allowed.' }, 405);
  if (url.pathname === '/api/admin/service-config/pokemon-queue-events' && request.method === 'GET') {
    return adminPokemonQueueCredential(env);
  }
  if (url.pathname === '/api/admin/service-config/pokemon-queue-events' && request.method === 'PUT') {
    return putPokemonQueueCredential(request, env);
  }
  if (url.pathname === '/api/admin/service-config/pokemon-queue-events' && request.method === 'DELETE') {
    return deletePokemonQueueCredential(env);
  }
  if (url.pathname === '/api/admin/service-config/pokemon-queue-events/refresh-version' && request.method === 'POST') {
    return refreshPokemonQueueVersion(request, env);
  }
  if (url.pathname === '/api/admin/service-config/pokemon-queue-events' ||
      url.pathname === '/api/admin/service-config/pokemon-queue-events/refresh-version') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }

  const proxyMatch = url.pathname.match(/^\/api\/admin\/proxy-lists\/([0-9a-f-]+)$/i);
  if (proxyMatch && request.method === 'PUT') return updateProxyList(request, env, proxyMatch[1]);
  if (proxyMatch && request.method === 'DELETE') return deleteProxyList(env, proxyMatch[1]);
  if (proxyMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const taskTypeMatch = url.pathname.match(/^\/api\/admin\/task-types\/([a-z0-9_-]+)$/i);
  if (taskTypeMatch && request.method === 'PATCH') return updateTaskType(request, env, taskTypeMatch[1].toLowerCase());
  if (taskTypeMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const waitlistMatch = url.pathname.match(/^\/api\/admin\/waitlist\/([0-9a-f-]+)(?:\/(invite))?$/i);
  if (waitlistMatch && waitlistMatch[2] === 'invite' && request.method === 'POST') {
    return inviteWaitlistEntry(request, env, waitlistMatch[1]);
  }
  if (waitlistMatch && !waitlistMatch[2] && request.method === 'DELETE') {
    return deleteWaitlistEntry(env, waitlistMatch[1]);
  }
  if (waitlistMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);

  const match = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)(?:\/(revoke|reset-password|download-link))?$/i);
  if (!match) return json({ ok: false, message: 'Not found.' }, 404);
  const user = await adminUser(env, match[1]);
  if (!user) return json({ ok: false, message: 'User not found.' }, 404);
  if (match[2] === 'revoke' && request.method === 'POST') return revokeUser(env, user);
  if (match[2] === 'reset-password' && request.method === 'POST') return resetUserPassword(env, user);
  if (match[2] === 'download-link' && request.method === 'POST') return createDownloadLink(request, env, user);
  if (!match[2] && request.method === 'PATCH') return updateUser(request, env, user);
  if (!match[2] && request.method === 'DELETE') return deleteUser(env, user);
  return json({ ok: false, message: 'Method not allowed.' }, 405);
}

async function createBillingCheckout(request, env) {
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, message: 'Enter a valid email address.' }, 400);
  const origin = downloadSiteOrigin(request, env);
  try {
    const session = await createCheckoutSession(env, {
      email,
      successUrl: `${origin}/buy/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/buy`,
    });
    return json({ ok: true, url: session.url, id: session.id });
  } catch (error) {
    if (error && (error.code === 'STRIPE_UNCONFIGURED' || error.code === 'BILLING_UNPROVISIONED')) {
      return json({ ok: false, message: 'Purchasing is not available yet.' }, 503);
    }
    console.error('stripe checkout failed', error && error.message);
    return json({ ok: false, message: 'Could not start checkout.' }, 502);
  }
}

async function billingSession(request, env) {
  const body = await bodyJson(request);
  const claim = await claimBillingSession(env, body.sessionId || body.session_id);
  if (!claim) return json({ ok: false, message: 'Checkout session not found.' }, 404);
  if (claim.expired) {
    return json({ ok: false, message: 'This purchase receipt has expired. Contact hello@zynbot.app.' }, 410);
  }
  return json({ ok: true, ...claim });
}

async function applyStripeCheckout(request, env, session) {
  const email = normalizeEmail(
    (session && session.customer_details && session.customer_details.email)
    || session.customer_email
    || (session.metadata && session.metadata.email),
  );
  if (!email) throw new Error('Checkout session is missing an email.');
  const plan = planById(session.metadata && session.metadata.plan_id) || defaultPlan();
  const accessUntil = accessUntilFromStripeObject(session, plan) || accessUntilFromIntro(plan);
  const result = await upsertPaidUser(env, {
    email,
    customerId: stripeId(session.customer),
    subscriptionId: stripeId(session.subscription),
    status: session.status === 'complete' ? 'trialing' : session.status,
    accessUntil,
    plan,
    createUser: createUserRecord,
  });
  let downloadUrl = '';
  try {
    downloadUrl = (await mintDownloadLink(request, env, result.user)).downloadUrl;
  } catch (error) {
    console.error('download link after checkout failed', error && error.message);
  }
  await storeBillingClaim(env, {
    checkoutSessionId: session.id,
    userId: result.user.id,
    createdNewUser: result.createdNewUser,
    temporaryPassword: result.temporaryPassword,
    downloadUrl,
  });
  await audit(env, 'stripe_checkout_completed', result.user, plan.id);
}

async function applyStripeInvoice(env, invoice) {
  const customerId = String(invoice && invoice.customer || '');
  if (!customerId) return;
  const user = await env.DB.prepare('SELECT * FROM users WHERE stripe_customer_id = ?')
    .bind(customerId).first();
  if (!user) return;
  const plan = planById(user.billing_plan) || defaultPlan();
  const nextAccess = Math.max(
    Number(user.access_until) || 0,
    accessUntilFromStripeObject(invoice, plan),
  );
  await env.DB.prepare(`
    UPDATE users SET billing_status = ?, access_until = ?,
      stripe_subscription_id = COALESCE(NULLIF(?, ''), stripe_subscription_id),
      updated_at = ?
    WHERE id = ?
  `).bind(
    invoice.paid ? 'active' : normalizeInvoiceStatus(invoice),
    nextAccess,
    String(invoice.subscription || ''),
    Date.now(),
    user.id,
  ).run();
}

function stripeId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.id || '');
}

function normalizeInvoiceStatus(invoice) {
  if (invoice && invoice.paid) return 'active';
  if (invoice && invoice.status === 'open') return 'past_due';
  return 'past_due';
}

async function applyStripeSubscription(env, subscription, deleted = false) {
  const customerId = String(subscription && subscription.customer || '');
  const subscriptionId = String(subscription && subscription.id || '');
  if (!customerId && !subscriptionId) return;
  const user = customerId
    ? await env.DB.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(customerId).first()
    : await env.DB.prepare('SELECT * FROM users WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
  if (!user) return;
  const plan = planById(user.billing_plan) || defaultPlan();
  const status = deleted ? 'canceled' : (subscription.status || user.billing_status);
  const accessUntil = deleted
    ? Number(user.access_until) || 0
    : Math.max(Number(user.access_until) || 0, accessUntilFromStripeObject(subscription, plan));
  await env.DB.prepare(`
    UPDATE users SET billing_status = ?, access_until = ?,
      stripe_subscription_id = COALESCE(NULLIF(?, ''), stripe_subscription_id),
      updated_at = ?
    WHERE id = ?
  `).bind(status, accessUntil, subscriptionId, Date.now(), user.id).run();
}

async function handleStripeEvent(request, env, event) {
  const type = String(event && event.type || '');
  const object = event && event.data && event.data.object;
  if (!object) return;
  if (type === 'checkout.session.completed') return applyStripeCheckout(request, env, object);
  if (type === 'invoice.paid') return applyStripeInvoice(env, object);
  if (type === 'invoice.payment_failed') {
    const user = await env.DB.prepare('SELECT id FROM users WHERE stripe_customer_id = ?')
      .bind(String(object.customer || '')).first();
    if (user) {
      await env.DB.prepare('UPDATE users SET billing_status = ?, updated_at = ? WHERE id = ?')
        .bind('past_due', Date.now(), user.id).run();
    }
    return;
  }
  if (type === 'customer.subscription.updated') return applyStripeSubscription(env, object, false);
  if (type === 'customer.subscription.deleted') return applyStripeSubscription(env, object, true);
}

async function stripeWebhook(request, env) {
  const raw = await request.text();
  const valid = await verifyStripeSignature(
    raw,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) return json({ ok: false, message: 'Invalid Stripe signature.' }, 400);
  let event;
  try { event = JSON.parse(raw); }
  catch { return json({ ok: false, message: 'Invalid Stripe payload.' }, 400); }
  if (!await rememberStripeEvent(env, event)) return json({ ok: true, duplicate: true });
  try {
    await handleStripeEvent(request, env, event);
    await markStripeEventProcessed(env, event.id);
  } catch (error) {
    console.error('stripe webhook failed', error && error.stack || error);
    return json({ ok: false, message: 'Webhook handling failed.' }, 500);
  }
  return json({ ok: true });
}

async function api(request, env, url) {
  if (url.pathname.startsWith('/api/admin/')) return adminRoute(request, env, url);
  const hyperMatch = url.pathname.match(/^\/api\/services\/hyper\/([a-z0-9-]+)$/i);
  if (hyperMatch) return brokerHyper(request, env, hyperMatch[1].toLowerCase());
  if (url.pathname === '/api/services/pokemon-center/queue-events') {
    return brokerPokemonQueueEvents(request, env);
  }
  if (url.pathname === '/api/billing/catalog' && request.method === 'GET') {
    return json({ ok: true, ...catalogSnapshot() });
  }
  if (url.pathname === '/api/billing/checkout' && request.method === 'POST') {
    return createBillingCheckout(request, env);
  }
  if (url.pathname === '/api/billing/session' && request.method === 'POST') {
    return billingSession(request, env);
  }
  if (url.pathname === '/api/billing/webhook' && request.method === 'POST') {
    return stripeWebhook(request, env);
  }
  if (url.pathname === '/api/waitlist' && request.method === 'POST') return joinWaitlist(request, env);
  if (url.pathname === '/api/download/redeem' && request.method === 'POST') return redeemDownloadAccess(request, env);
  if (url.pathname === '/api/download/session' && request.method === 'POST') return validateDownloadSession(request, env);
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (url.pathname === '/api/auth/reset-password' && request.method === 'POST') return resetPassword(request, env);
  if (url.pathname === '/api/license/validate' && request.method === 'POST') return validateLicense(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
  if (url.pathname === '/api/backups' && request.method === 'GET') return listBackups(request, env);
  if (url.pathname === '/api/analytics/events' && request.method === 'POST') return ingestAnalytics(request, env);
  if (url.pathname === '/api/analytics/dashboard' && request.method === 'GET') return analyticsDashboard(request, env, url);
  if (url.pathname === '/api/analytics/checkouts' && request.method === 'GET') return analyticsCheckouts(request, env, url);
  if (url.pathname === '/api/analytics' && request.method === 'DELETE') return deleteAnalytics(request, env);
  if (url.pathname.startsWith('/api/analytics')) return json({ ok: false, message: 'Method not allowed.' }, 405);
  const backupMatch = url.pathname.match(/^\/api\/backups\/([0-9a-f-]+)$/i);
  if (backupMatch && request.method === 'PUT') return putBackup(request, env, backupMatch[1]);
  if (backupMatch && request.method === 'GET') return getBackup(request, env, backupMatch[1]);
  if (backupMatch && request.method === 'DELETE') return deleteBackup(request, env, backupMatch[1]);
  if (backupMatch) return json({ ok: false, message: 'Method not allowed.' }, 405);
  return json({ ok: false, message: 'Not found.' }, 404);
}

function secureAsset(response) {
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const __test = Object.freeze({
  activeDeviceLimitStatements,
  HYPER_UPSTREAMS,
  POKEMON_QUEUE_RELEASES_URL,
  POKEMON_QUEUE_UPSTREAM_VERSION,
  brokerPokemonQueueEvents,
  brokerHyper,
  decodePokemonQueueMessage,
  decryptServiceCredential,
  encryptServiceCredential,
  ensureFreshPolarUpstreamVersion,
  hyperCredentialInput,
  normalizePolarReleaseVersion,
  normalizePokemonQueueEvent,
  notifyPokemonQueueDiscord,
  parsePolarLatestRelease,
  pokemonQueueDiscordPayload,
  pokemonQueueDiscordWebhook,
  licenseFailure,
  paidAccessFailure,
  licenseRebindStatements,
  canRebindLicense,
  maxActiveDevicesForUser,
  mintLicenseStatements,
  pokemonQueueCredentialInput,
  pokemonQueueUpstreamUrl,
  refreshPolarUpstreamVersion,
  serviceCredentialJson,
  validMaxActiveDevices,
  analyticsWindow,
  normalizeAnalyticsEvent,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ service: 'zyn-license-api', status: 'ok' });
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname === '/' || url.pathname === '/admin') {
        return Response.redirect(`${url.origin}/admin/`, 302);
      }
      return secureAsset(await env.ASSETS.fetch(request));
    } catch (error) {
      console.error('request failed', error && error.stack || error);
      return json({ ok: false, message: 'Request failed.' }, 500);
    }
  },
  async scheduled(_event, env) {
    const result = await refreshPolarUpstreamVersion(env);
    if (!result.ok) console.error('polar version refresh failed', result.reason || result.status || '');
    await notifyPokemonQueueRelay(env);
  },
};
