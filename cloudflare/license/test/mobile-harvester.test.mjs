import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import {
  MOBILE_MAX_COMPANIONS,
  MOBILE_MAX_DESKTOPS,
  MOBILE_MAX_EXTENSIONS,
  MOBILE_MAX_PHONES,
  allowedMobileMessageType,
  canAcceptMobilePeer,
  sumHarvestDemand,
  mobilePairingUrl,
  parseMobileClientMessage,
  parseMobilePairingUrl,
  shouldReplaceMobilePeer,
} from '../src/mobile-harvester.js';
import {
  MAILBOX_MAX_ATC,
  enqueueMailboxCookie,
  mailboxSnapshot,
  normalizeMailboxCookie,
  takeMailboxCookies,
} from '../src/harvest-mailbox.js';

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
        session_kind: license.session_kind || 'engine',
        user_id: user.id,
        email: user.email,
        active: user.active,
      };
    }
    if (sql.includes('FROM mobile_rooms') && sql.includes('WHERE user_id = ?')) {
      const [userId, now] = bindings;
      return this.rooms.find(row => row.user_id === userId && row.revoked_at == null
        && Number(row.expires_at) > Number(now || 0)) || null;
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
    session_kind: 'engine',
  });
  const wsCalls = [];
  const mailboxHttp = [];
  let mailboxList = [];
  const shapeHeaders = Object.fromEntries([
    'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
    'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
    'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
  ].map(name => [name, `captured-${name}`]));
  return {
    DB,
    wsCalls,
    mailboxHttp,
    shapeHeaders,
    mailboxList: () => mailboxList,
    MOBILE_HARVESTER: {
      idFromName(name) {
        return { name };
      },
      get(id) {
        return {
          fetch: async (request) => {
            const url = new URL(request.url);
            if (url.pathname === '/mailbox/capture') {
              mailboxHttp.push({ id, path: url.pathname });
              const body = await request.json();
              const cookie = normalizeMailboxCookie(body, { now: Date.now(), id: 'cookie-1' });
              const next = enqueueMailboxCookie(mailboxList, cookie);
              mailboxList = next.list;
              return Response.json({
                ok: next.saved > 0,
                saved: next.saved,
                reason: next.reason,
                mailbox: mailboxSnapshot(mailboxList),
              });
            }
            if (url.pathname === '/mailbox/take') {
              mailboxHttp.push({ id, path: url.pathname });
              const body = await request.json().catch(() => ({}));
              const next = takeMailboxCookies(mailboxList, body);
              mailboxList = next.list;
              return Response.json({
                ok: true,
                cookies: next.cookies,
                mailbox: mailboxSnapshot(mailboxList),
              });
            }
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
  assert.equal(allowedMobileMessageType('companion', 'capture'), true);
  assert.equal(allowedMobileMessageType('companion', 'demand'), false);
  assert.equal(allowedMobileMessageType('extension', 'capture'), true);
  assert.equal(allowedMobileMessageType('extension', 'need-proxies'), true);
  assert.equal(allowedMobileMessageType('extension', 'demand'), false);
  assert.equal(allowedMobileMessageType('companion', 'ping'), true);
  assert.equal(allowedMobileMessageType('desktop', 'ping'), true);
  assert.equal(allowedMobileMessageType('phone', 'ping'), true);
  assert.equal(allowedMobileMessageType('extension', 'ping'), true);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'phone').ok, true);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'extension').ok, true);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'desktop').ok, false);
  assert.equal(parseMobileClientMessage('{"type":"capture"}', 'companion').ok, true);
  assert.equal(parseMobileClientMessage('{"type":"ping"}', 'companion').ok, true);
  assert.equal(parseMobileClientMessage('not-json', 'phone').code, 'invalid_json');
});

test('same-device reconnects replace the stale socket instead of occupying a second slot', () => {
  assert.equal(shouldReplaceMobilePeer({ role: 'desktop', deviceId: 'abc' }, 'desktop', 'abc'), true);
  assert.equal(shouldReplaceMobilePeer({ role: 'desktop', deviceId: 'abc' }, 'desktop', 'def'), false);
  assert.equal(shouldReplaceMobilePeer({ role: 'companion', deviceId: 'win-1' }, 'companion', 'win-1'), true);
  assert.equal(shouldReplaceMobilePeer({ role: 'companion', deviceId: 'win-1' }, 'companion', 'mac-2'), false);
  assert.equal(shouldReplaceMobilePeer({ role: 'desktop', deviceId: 'unknown' }, 'desktop', 'unknown'), false);
  assert.equal(shouldReplaceMobilePeer({ role: 'companion', deviceId: 'win-1' }, 'desktop', 'win-1'), false);
});

test('room occupancy allows multiple Full Engines and rejects extra phones', () => {
  assert.equal(canAcceptMobilePeer({ desktopCount: 0, phoneCount: 0 }, 'desktop'), true);
  assert.equal(canAcceptMobilePeer({ desktopCount: 1, phoneCount: 0 }, 'desktop'), true);
  assert.equal(canAcceptMobilePeer({ desktopCount: MOBILE_MAX_DESKTOPS - 1 }, 'desktop'), true);
  assert.equal(canAcceptMobilePeer({ desktopCount: MOBILE_MAX_DESKTOPS }, 'desktop'), false);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, phoneCount: MOBILE_MAX_PHONES - 1 }, 'phone'), true);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, phoneCount: MOBILE_MAX_PHONES }, 'phone'), false);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, companionCount: 0 }, 'companion'), true);
  assert.equal(canAcceptMobilePeer({
    desktopOnline: true, companionCount: MOBILE_MAX_COMPANIONS,
  }, 'companion'), false);
  assert.equal(canAcceptMobilePeer({ desktopOnline: true, extensionCount: 0 }, 'extension'), true);
  assert.equal(canAcceptMobilePeer({
    desktopOnline: true, extensionCount: MOBILE_MAX_EXTENSIONS,
  }, 'extension'), false);
});

test('harvest demand remaining room is the sum of every Full Engine', () => {
  const summed = sumHarvestDemand([
    { atc: 10, login: 0, waitingAtc: 2, activeTasks: 16, atcPerTask: 3, basis: 'live', room: { login: 0, atc: 20 } },
    { atc: 8, login: 0, waitingAtc: 4, activeTasks: 8, atcPerTask: 3, basis: 'live', room: { login: 0, atc: 12 } },
  ]);
  assert.equal(summed.engines, 2);
  assert.equal(summed.atc, 18);
  assert.equal(summed.waitingAtc, 6);
  assert.equal(summed.activeTasks, 24);
  assert.equal(summed.room.atc, 32);
  assert.equal(summed.basis, 'live');
  const pausedPlusLive = sumHarvestDemand([
    { basis: 'paused', room: { atc: 0, login: 0 }, waitingAtc: 0, activeTasks: 0 },
    { basis: 'live', room: { atc: 9, login: 0 }, waitingAtc: 1, activeTasks: 4 },
  ]);
  assert.equal(pausedPlusLive.room.atc, 9);
  assert.equal(pausedPlusLive.basis, 'live');
  assert.equal(sumHarvestDemand([]).room.atc, 0);
  assert.equal(sumHarvestDemand([]).basis, 'paused');
  assert.equal(sumHarvestDemand([
    { room: { atc: null, login: 0 } },
    { room: { atc: 4, login: 0 } },
  ]).room.atc, null, 'any uncapped engine keeps remote harvest running');
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

test('browser extension websocket accepts the phone pairing token', async () => {
  const env = await environment();
  const minted = await (await worker.fetch(new Request('https://license.zynbot.app/api/mobile/pair', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env)).json();

  const missingDevice = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=extension&token=${encodeURIComponent(minted.joinToken)}`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(missingDevice.status, 400);

  const good = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${minted.roomId}&role=extension&token=${encodeURIComponent(minted.joinToken)}&deviceId=11111111-2222-4333-a444-555555555555`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(good.status, 200);
  assert.equal(env.wsCalls.length, 1);
  assert.match(env.wsCalls[0].url, /role=extension/);
  assert.doesNotMatch(env.wsCalls[0].url, /token=/);
});

test('browser extension websocket accepts a signed-in Zyn license session', async () => {
  const env = await environment();
  const hosted = await (await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env)).json();

  const missingSession = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${hosted.roomId}&role=extension&deviceId=${DEVICE_A}`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(missingSession.status, 401);

  const badSession = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${hosted.roomId}&role=extension&session=nope-nope-nope-nope&deviceId=${DEVICE_A}`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(badSession.status, 401);
  assert.equal(env.wsCalls.length, 0);

  const good = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${hosted.roomId}&role=extension&session=${TOKEN_A}&deviceId=${DEVICE_A}`,
    { headers: { upgrade: 'websocket' } },
  ), env);
  assert.equal(good.status, 200);
  assert.equal(env.wsCalls.length, 1);
  assert.match(env.wsCalls[0].url, /role=extension/);
  assert.doesNotMatch(env.wsCalls[0].url, /session=/);
  assert.doesNotMatch(env.wsCalls[0].url, /token=/);
});

test('Full Engine hosts a harvest room that harvester-only companions can join', async () => {
  const env = await environment();
  const deniedCompanionHost = await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  const engineHost = await deniedCompanionHost.json();
  assert.equal(deniedCompanionHost.status, 200);
  assert.equal(engineHost.ok, true);
  assert.match(engineHost.roomId, /^zynm_/);
  assert.equal(engineHost.created, true);

  const reused = await (await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env)).json();
  assert.equal(reused.created, false);
  assert.equal(reused.roomId, engineHost.roomId);

  env.DB.licenses[0].session_kind = 'harvester';
  const harvesterHost = await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  assert.equal(harvesterHost.status, 403);
  assert.equal((await harvesterHost.json()).code, 'engine_required');

  const found = await (await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'GET',
    headers: licenseHeaders(),
  }), env)).json();
  assert.equal(found.ok, true);
  assert.equal(found.roomId, engineHost.roomId);

  env.DB.licenses[0].session_kind = 'engine';
  const engineCompanionDenied = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${engineHost.roomId}&role=companion`,
    { headers: { ...licenseHeaders(), upgrade: 'websocket' } },
  ), env);
  assert.equal(engineCompanionDenied.status, 403);
  assert.equal((await engineCompanionDenied.json()).code, 'harvester_required');

  env.DB.licenses[0].session_kind = 'harvester';
  const companion = await worker.fetch(new Request(
    `https://license.zynbot.app/api/mobile/ws?room=${engineHost.roomId}&role=companion`,
    { headers: { ...licenseHeaders(), upgrade: 'websocket' } },
  ), env);
  assert.equal(companion.status, 200);
  assert.match(env.wsCalls.at(-1).url, /role=companion/);
  assert.doesNotMatch(env.wsCalls.at(-1).url, /token=/);
});

test('mailbox parks at the ATC cap and hands cookies to Full Engine in batches', () => {
  const now = 1_000_000;
  const headers = Object.fromEntries([
    'sec-ch-ua-platform', 'sec-ch-ua', 'user-agent',
    'x-gyjwza5z-a', 'x-gyjwza5z-b', 'x-gyjwza5z-c',
    'x-gyjwza5z-d', 'x-gyjwza5z-f', 'x-gyjwza5z-z',
  ].map(name => [name, name]));
  const cookie = normalizeMailboxCookie({
    cookieType: 'atc',
    headers,
    proxy: 'http://user:pass@1.1.1.1:8000',
  }, { now, id: 'a' });
  assert.equal(cookie.type, 'atc');
  assert.equal(cookie.headers.cookie, undefined);
  assert.throws(() => normalizeMailboxCookie({ cookieType: 'login', headers }, { now, id: 'login' }), /ATC only/);
  let list = [];
  const caps = { login: 0, atc: 8 };
  for (let i = 0; i < 8; i += 1) {
    const next = enqueueMailboxCookie(list, { ...cookie, id: `c${i}` }, { now, caps });
    assert.equal(next.saved, 1);
    list = next.list;
  }
  const full = enqueueMailboxCookie(list, { ...cookie, id: 'overflow' }, { now, caps });
  assert.equal(full.saved, 0);
  assert.equal(full.reason, 'full');
  const login = enqueueMailboxCookie(list, { ...cookie, id: 'login-1', type: 'login' }, { now, caps });
  assert.equal(login.saved, 0);
  assert.equal(login.reason, 'login');
  const taken = takeMailboxCookies(list, { type: 'atc', n: 64, now });
  assert.equal(taken.cookies.length, 8);
  assert.equal(mailboxSnapshot(taken.list, now).atc, 0);
  assert.equal(mailboxSnapshot(taken.list, now).remaining.login, 0);
});

test('HTTP capture stores cookies on Cloudflare and take pulls them for Full Engine', async () => {
  const env = await environment();
  await worker.fetch(new Request('https://license.zynbot.app/api/harvester/room', {
    method: 'POST',
    headers: licenseHeaders(),
  }), env);
  const captured = await worker.fetch(new Request('https://license.zynbot.app/api/harvester/capture', {
    method: 'POST',
    headers: licenseHeaders(),
    body: JSON.stringify({
      cookieType: 'atc',
      headers: env.shapeHeaders,
      proxy: 'http://user:pass@1.1.1.1:8000',
    }),
  }), env);
  assert.equal(captured.status, 200);
  const stored = await captured.json();
  assert.equal(stored.ok, true);
  assert.equal(stored.saved, 1);
  assert.equal(stored.mailbox.atc, 1);
  assert.equal(env.wsCalls.length, 0, 'capture must not open a desktop websocket');

  env.DB.licenses[0].session_kind = 'harvester';
  const harvesterTake = await worker.fetch(new Request('https://license.zynbot.app/api/harvester/take', {
    method: 'POST',
    headers: licenseHeaders(),
    body: JSON.stringify({ type: 'atc', n: 10 }),
  }), env);
  assert.equal(harvesterTake.status, 403);

  env.DB.licenses[0].session_kind = 'engine';
  const taken = await worker.fetch(new Request('https://license.zynbot.app/api/harvester/take', {
    method: 'POST',
    headers: licenseHeaders(),
    body: JSON.stringify({ type: 'atc', n: 10 }),
  }), env);
  assert.equal(taken.status, 200);
  const pulled = await taken.json();
  assert.equal(pulled.cookies.length, 1);
  assert.equal(pulled.cookies[0].type, 'atc');
  assert.equal(pulled.mailbox.atc, 0);
});

