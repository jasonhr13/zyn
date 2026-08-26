import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import {
  MOBILE_MAX_PHONES,
  allowedMobileMessageType,
  canAcceptMobilePeer,
  mobilePairingUrl,
  parseMobileClientMessage,
  parseMobilePairingUrl,
} from '../src/mobile-harvester.js';

const DEVICE_A = 'aaaaaaaaaaaaaaaa';
const TOKEN_A = 'license-token-a';

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

class MemoryD1 {
  constructor() {
    this.users = new Map();
    this.licenses = [];
    this.rooms = [];
    this.statements = [];
  }

  prepare(sql) {
    const db = this;
    const normalized = compactSql(sql);
    return {
      bind(...bindings) {
        return {
          first: () => db.first(normalized, bindings),
          all: () => db.all(normalized, bindings),
          run: () => db.run(normalized, bindings),
        };
      },
    };
  }

  async first(sql, bindings) {
    if (sql.includes('FROM licenses l JOIN users u') && sql.includes('l.revoked_at IS NULL')) {
      const [tokenHash] = bindings;
      const license = this.licenses.find(row => row.token_hash === tokenHash && row.revoked_at == null);
      if (!license) return null;
      const user = this.users.get(license.user_id);
      if (!user) return null;
      return {
        license_id: license.id,
        device_id: license.device_id,
        device_name: license.device_name,
        expires_at: license.expires_at,
        user_id: user.id,
        email: user.email,
        active: user.active,
      };
    }
    if (sql.includes('FROM mobile_rooms') && sql.includes('WHERE room_id = ?')) {
      const [roomId] = bindings;
      return this.rooms.find(row => row.room_id === roomId) || null;
    }
    return null;
  }

  async all() {
    return { results: [] };
  }

  async run(sql, bindings) {
    this.statements.push({ sql, bindings });
    if (sql.startsWith('UPDATE mobile_rooms SET revoked_at')) {
      const [now, userId] = bindings;
      for (const room of this.rooms) {
        if (room.user_id === userId && room.revoked_at == null) room.revoked_at = now;
      }
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO mobile_rooms')) {
      const [roomId, userId, licenseId, tokenHash, createdAt, expiresAt] = bindings;
      this.rooms.push({
        room_id: roomId,
        user_id: userId,
        license_id: licenseId,
        token_hash: tokenHash,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
      });
      return { success: true };
    }
    return { success: true };
  }
}

async function environment(overrides = {}) {
  const DB = new MemoryD1();
  DB.users.set('user-a', { id: 'user-a', email: 'a@example.com', active: 1 });
  DB.licenses.push({
    id: 'license-a',
    user_id: 'user-a',
    token_hash: await sha256Hex(TOKEN_A),
    device_id: DEVICE_A,
    device_name: 'Mac A',
    expires_at: Date.now() + 60_000,
    revoked_at: null,
  });
  const wsCalls = [];
  return {
    DB,
    wsCalls,
    MOBILE_HARVESTER: {
      idFromName(name) {
        return { name };
      },
      get(id) {
        return {
          fetch: async (request) => {
            wsCalls.push({ id, url: String(request.url), headers: Object.fromEntries(request.headers) });
            // Node's Response constructor rejects 101; Cloudflare returns 101 for a real upgrade.
            return new Response('upgraded', { status: 200, headers: { 'x-test-upgrade': '1' } });
          },
        };
      },
    },
    ...overrides,
  };
}

function licenseHeaders() {
  return {
    authorization: `Bearer ${TOKEN_A}`,
    'x-rcart-device-id': DEVICE_A,
    'content-type': 'application/json',
  };
}

test('pairing URL round-trips room and token without embedding the license', () => {
  const pairingUrl = mobilePairingUrl('https://license.zynbot.app', 'zynm_abcdefghijklmnop', 'join-token-value-1234');
  assert.match(pairingUrl, /^zyn:\/\/pair\?/);
  assert.doesNotMatch(pairingUrl, /license-token/);
  const parsed = parseMobilePairingUrl(pairingUrl);
  assert.deepEqual(parsed, {
    roomId: 'zynm_abcdefghijklmnop',
    joinToken: 'join-token-value-1234',
    origin: 'https://license.zynbot.app',
  });
  assert.equal(parseMobilePairingUrl('https://evil.example/pair'), null);
});

test('mobile message allowlist is role-scoped', () => {
  assert.equal(allowedMobileMessageType('phone', 'capture'), true);
  assert.equal(allowedMobileMessageType('phone', 'need-proxies'), true);
  assert.equal(allowedMobileMessageType('phone', 'demand'), false);
  assert.equal(allowedMobileMessageType('desktop', 'demand'), true);
  assert.equal(allowedMobileMessageType('desktop', 'capture'), false);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'phone').ok, true);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'desktop').ok, false);
  assert.equal(parseMobileClientMessage('not-json', 'phone').code, 'invalid_json');
});

test('room occupancy rejects a second desktop and extra phones', () => {
  assert.equal(canAcceptMobilePeer({ desktopOnline: false, phoneCount: 0 }, 'desktop'), true);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, phoneCount: 0 }, 'desktop'), false);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, phoneCount: MOBILE_MAX_PHONES - 1 }, 'phone'), true);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, phoneCount: MOBILE_MAX_PHONES }, 'phone'), false);
});

test('pairing requires a live license session', async () => {
  const env = await environment();
  const denied = await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
  }), env);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, 'license_invalid');
});

test('pairing mints a room, hashes the join token, and revokes the previous room', async () => {
  const env = await environment();
  const first = await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  assert.equal(first.status, 200);
  const minted = await first.json();
  assert.equal(minted.ok, true);
  assert.match(minted.roomId, /^zynm_/);
  assert.ok(minted.joinToken.length >= 16);
  assert.equal(env.DB.rooms.length, 1);
  assert.equal(env.DB.rooms[0].token_hash, await sha256Hex(minted.joinToken));
  assert.notEqual(env.DB.rooms[0].token_hash, minted.joinToken);

  const second = await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  const rotated = await second.json();
  assert.equal(second.status, 200);
  assert.equal(env.DB.rooms.length, 2);
  assert.ok(env.DB.rooms[0].revoked_at);
  assert.equal(env.DB.rooms[1].revoked_at, null);
  assert.notEqual(rotated.roomId, minted.roomId);
});

test('reset pairing revokes the active room', async () => {
  const env = await environment();
  await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  const reset = await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair/reset', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  assert.equal(reset.status, 200);
  assert.ok(env.DB.rooms[0].revoked_at);
});

test('desktop websocket requires license auth and strips the bearer from the Durable Object request', async () => {
  const env = await environment();
  const minted = await (await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env)).json();
  const missingUpgrade = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=desktop`,
    { headers: licenseHeaders() },
  ), env);
  assert.equal(missingUpgrade.status, 426);

  const connected = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=desktop`,
    { headers: { ...licenseHeaders(), upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGVzdA==' } },
  ), env);
  assert.equal(connected.status, 200);
  assert.equal(connected.headers.get('x-test-upgrade'), '1');
  assert.equal(env.wsCalls.length, 1);
  assert.match(env.wsCalls[0].url, /mobile-harvester\.internal\/client/);
  assert.doesNotMatch(env.wsCalls[0].url, /token=/);
  assert.equal(env.wsCalls[0].headers.authorization, undefined);
  assert.equal(env.wsCalls[0].headers['x-rcart-device-id'], undefined);
  assert.equal(env.wsCalls[0].headers.upgrade, 'websocket');
  assert.equal(env.wsCalls[0].headers['sec-websocket-key'], 'dGVzdA==');
  assert.match(env.wsCalls[0].url, /role=desktop/);
});

test('phone websocket accepts the join token and rejects a bad token without hitting the Durable Object', async () => {
  const env = await environment();
  const minted = await (await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env)).json();

  const bad = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=phone&token=nope-nope-nope-nope&deviceId=phone-device-1`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(bad.status, 403);
  assert.equal(env.wsCalls.length, 0);

  const good = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=phone&token=${encodeURIComponent(minted.joinToken)}&deviceId=phone-device-1`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(good.status, 200);
  assert.equal(env.wsCalls.length, 1);
  assert.match(env.wsCalls[0].url, /role=phone/);
  assert.doesNotMatch(env.wsCalls[0].url, /token=/);
});
