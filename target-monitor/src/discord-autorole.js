import { fetch, WebSocket } from 'undici';
import { config } from './config.js';
import { log } from './log.js';

// Discord has no "role on join" setting; the only way to hand every new member a
// role is a bot holding a gateway connection and reacting to GUILD_MEMBER_ADD.
// This is that bot, kept deliberately tiny: undici's WebSocket (so it also runs on
// Node 20 locally), the gateway
// handshake, heartbeats, resume, and one REST call per join.
//
// Requires the Server Members privileged intent to be enabled on the bot in the
// Discord Developer Portal — without it Discord closes the socket with 4014 and
// we stop retrying, because no amount of reconnecting fixes a portal setting.

const API = 'https://discord.com/api/v10';
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg';
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MEMBERS = 1 << 1;
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
// Close codes after which reconnecting is pointless.
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function startDiscordAutorole() {
  const { token, guildId, roleId } = config.discordAutorole;
  if (!token || !guildId || !roleId) {
    log.info('discord autorole disabled — DISCORD_BOT_TOKEN, DISCORD_AUTOROLE_GUILD_ID and DISCORD_AUTOROLE_ROLE_ID all required');
    return { stop() {} };
  }

  let ws = null;
  let heartbeatTimer = null;
  let heartbeatAcked = true;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let stopped = false;
  let backoffMs = 1000;
  const stats = { joins: 0, assigned: 0, failures: 0, connects: 0, connectedAt: null };

  const send = (payload) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const startHeartbeat = (intervalMs) => {
    clearHeartbeat();
    heartbeatAcked = true;
    // Discord asks for jitter on the first beat so a fleet does not sync up.
    setTimeout(() => send({ op: OP.HEARTBEAT, d: seq }), Math.floor(Math.random() * intervalMs));
    heartbeatTimer = setInterval(() => {
      if (!heartbeatAcked) {
        // A missed ack is a zombie connection: close and let the reconnect path resume.
        log.warn('discord gateway heartbeat not acked — reconnecting');
        try { ws.close(4000, 'zombie'); } catch {}
        return;
      }
      heartbeatAcked = false;
      send({ op: OP.HEARTBEAT, d: seq });
    }, intervalMs);
  };

  async function assignRole(member) {
    const user = member.user || {};
    if (user.bot) return;
    stats.joins += 1;
    const url = `${API}/guilds/${guildId}/members/${user.id}/roles/${roleId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { authorization: `Bot ${token}`, 'x-audit-log-reason': 'Zyn autorole on join' },
        });
        if (res.status === 204) {
          stats.assigned += 1;
          log.info({ user: user.id, username: user.username }, 'discord autorole assigned');
          return;
        }
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          const wait = Math.min(Math.max(Number(body.retry_after) || 0.5, 0.5), 10) * 1000;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const text = await res.text().catch(() => '');
        log.error({ user: user.id, status: res.status, body: text.slice(0, 200) }, 'discord autorole failed');
        break;
      } catch (err) {
        log.error({ user: user.id, err: String(err) }, 'discord autorole request error');
      }
    }
    stats.failures += 1;
  }

  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.s != null) seq = msg.s;
    switch (msg.op) {
      case OP.HELLO:
        startHeartbeat(msg.d.heartbeat_interval);
        if (sessionId && resumeUrl) {
          send({ op: OP.RESUME, d: { token, session_id: sessionId, seq } });
        } else {
          send({
            op: OP.IDENTIFY,
            d: {
              token,
              intents: INTENT_GUILDS | INTENT_GUILD_MEMBERS,
              properties: { os: process.platform, browser: 'zyn-monitor', device: 'zyn-monitor' },
            },
          });
        }
        break;
      case OP.HEARTBEAT:
        send({ op: OP.HEARTBEAT, d: seq });
        break;
      case OP.HEARTBEAT_ACK:
        heartbeatAcked = true;
        break;
      case OP.RECONNECT:
        log.info('discord gateway asked us to reconnect');
        try { ws.close(4000, 'reconnect requested'); } catch {}
        break;
      case OP.INVALID_SESSION:
        // d === true means resumable; anything else means start a fresh session.
        if (msg.d !== true) { sessionId = null; resumeUrl = null; seq = null; }
        setTimeout(() => { try { ws.close(4000, 'invalid session'); } catch {} }, 1000 + Math.random() * 4000);
        break;
      case OP.DISPATCH:
        onDispatch(msg.t, msg.d);
        break;
      default:
        break;
    }
  }

  function onDispatch(type, data) {
    if (type === 'READY') {
      sessionId = data.session_id;
      resumeUrl = data.resume_gateway_url || null;
      backoffMs = 1000;
      stats.connects += 1;
      stats.connectedAt = Date.now();
      log.info({ bot: data.user?.username, guilds: (data.guilds || []).length }, 'discord autorole connected');
      return;
    }
    if (type === 'RESUMED') {
      backoffMs = 1000;
      log.info('discord autorole session resumed');
      return;
    }
    if (type === 'GUILD_MEMBER_ADD' && String(data.guild_id) === String(guildId)) {
      // Skip members that already carry the role (a rejoin after a kick, say).
      if ((data.roles || []).map(String).includes(String(roleId))) return;
      assignRole(data);
    }
  }

  function connect() {
    if (stopped) return;
    const base = resumeUrl || DEFAULT_GATEWAY;
    const url = `${base}${base.includes('?') ? '&' : '?'}v=10&encoding=json`;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log.error({ err: String(err) }, 'discord gateway socket failed to open');
      scheduleReconnect();
      return;
    }
    ws.addEventListener('message', (ev) => onMessage(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')));
    ws.addEventListener('error', (ev) => log.warn({ err: String(ev?.message || ev?.error || 'socket error') }, 'discord gateway error'));
    ws.addEventListener('close', (ev) => {
      clearHeartbeat();
      if (stopped) return;
      if (FATAL_CLOSE.has(ev.code)) {
        const hint = ev.code === 4014
          ? 'enable the Server Members intent for this bot in the Discord Developer Portal'
          : ev.code === 4004 ? 'bot token rejected' : 'not retrying';
        log.error({ code: ev.code, reason: ev.reason }, `discord gateway closed fatally — ${hint}`);
        return;
      }
      log.warn({ code: ev.code, reason: ev.reason }, 'discord gateway closed — reconnecting');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }

  connect();

  return {
    stats,
    stop() {
      stopped = true;
      clearHeartbeat();
      try { ws && ws.close(1000, 'shutdown'); } catch {}
    },
  };
}
