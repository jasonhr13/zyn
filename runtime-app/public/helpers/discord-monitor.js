// Shared stock monitor: listen to Discord channels a monitor service posts in-stock embeds to, and
// forward each one to the engines as a stock ping.
//
// WHY THIS EXISTS. On the first Target drop every copy of the app polled the same ~40 TCINs through
// the operator's own proxy pool. Forty users watching one product is forty times the data for
// exactly the information the first request already produced — and it is also what got the pools
// 403'd, because one provider making that many redsky calls looks like precisely what it is. A ping
// that arrives over Discord costs zero retailer requests and is the same signal.
//
// Read-only by design: this reads channels and never posts. Parsing lives in monitor-parse.js, which
// is separately tested; this file is only the transport.

const { parseMonitorEmbed } = require('./monitor-parse');

let client = null;          // discord.js Client, lazily required so a missing dep cannot break boot
let state = { on: false, why: 'not started', channels: {}, seen: 0, forwarded: 0 };
let onPing = () => {};      // set by start(): where a parsed ping goes
let onBuy = async () => '';  // set by start(): a BUY NOW click from the key's owner
let ownerId = '';           // the licence holder's Discord id, from the dashboard
let warnedNoOwner = false;  // so a missing id is said once, not on every click in the server
let sawForeignClick = false; // proof-of-life: this copy IS receiving interactions
let log = () => {};

// A monitor channel reposts the same drop repeatedly — a restock ping, an edit, a second service
// mirroring it. Firing a task per repost is how you spend three proxies to lose one item, so the
// same (site, sku) is suppressed for a short window. Short, not long: a genuine restock minutes
// later is a real event and must get through.
const REPOST_WINDOW_MS = 90 * 1000;
const recent = new Map();
function isRepost(site, sku) {
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > REPOST_WINDOW_MS) recent.delete(k);
  const key = `${site}|${sku}`;
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

// The licence identity arrives ASYNCHRONOUSLY and often AFTER this module has started.
//
// startGlobalMonitor() runs on a fixed timer at boot and passes the owner id by value, so a user
// sitting at the key gate at that moment hands over an empty string — and every Buy Now click is
// then refused for the rest of the session, with a good key and a linked Discord account, because
// the id that arrived seconds later had nowhere to go. Letting it be set afterwards is the whole
// fix; without it, activating a key at the gate silently breaks Buy Now until the next restart.
function setOwnerDiscordId(id) {
  const next = String(id || '');
  if (next === ownerId) return;
  ownerId = next;
  warnedNoOwner = false;
  sawForeignClick = false;   // a real id arriving makes the earlier complaint stale
  if (next) log(`[monitor] Buy Now enabled for this licence`);
}

function status() {
  return { ...state, channels: { ...state.channels } };
}

// channelMap: { "<channelId>": "target" | "pbandai" }
async function start({ token, channelMap, onStockPing, onBuyNow, ownerDiscordId, logger } = {}) {
  stop();
  log = typeof logger === 'function' ? logger : () => {};
  onPing = typeof onStockPing === 'function' ? onStockPing : () => {};
  onBuy = typeof onBuyNow === 'function' ? onBuyNow : async () => '';
  ownerId = String(ownerDiscordId || '');
  warnedNoOwner = false;
  state = { on: false, why: '', channels: { ...(channelMap || {}) }, seen: 0, forwarded: 0 };

  const ids = Object.keys(state.channels);
  if (!token) { state.why = 'no bot token set'; log('[monitor] not started — ' + state.why); return status(); }
  if (!ids.length) { state.why = 'no channels mapped'; log('[monitor] not started — ' + state.why); return status(); }

  let Discord;
  try { Discord = require('discord.js'); }
  catch (e) { state.why = 'discord.js is not installed'; log('[monitor] ' + state.why); return status(); }

  try {
    const { Client, Intents } = Discord;
    // GUILD_MESSAGES delivers the event; MESSAGE_CONTENT is the privileged intent that fills in the
    // embed. Without the latter enabled on the application, messages arrive with empty embeds and
    // this looks like a parser fault rather than a portal checkbox.
    client = new Client({
      intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.MESSAGE_CONTENT],
    });

    client.on('messageCreate', (msg) => {
      try {
        const cid = String(msg.channelId || (msg.channel && msg.channel.id) || '');
        if (!state.channels[cid]) return;
        state.seen += 1;
        const embeds = msg.embeds || [];
        if (!embeds.length) {
          log(`[monitor] ${cid}: message had no embed — is MESSAGE CONTENT INTENT enabled for the bot?`);
          return;
        }
        for (const embed of embeds) {
          const r = parseMonitorEmbed(embed, cid, state.channels);
          if (!r.ok) { log(`[monitor] ignored: ${r.why}`); continue; }
          if (isRepost(r.site, r.sku)) { log(`[monitor] repost within 90s — ${r.label} ${r.sku}`); continue; }
          state.forwarded += 1;
          log(`[monitor] ${r.label} ${r.sku} — ${r.name || 'unnamed'}${r.stock != null ? ` · stock ${r.stock}` : ''}${r.cartLimit ? ` · limit ${r.cartLimit}` : ''}`);
          onPing(r);
        }
      } catch (e) { log('[monitor] handler error: ' + e.message); }
    });

    // ── BUY NOW ────────────────────────────────────────────────────────────────
    // The restock embed carries a green button whose custom_id is
    //     buy:<site>:<sku>:<qty>
    // Clicking it fires an interaction, which Discord delivers over the gateway to EVERY app signed
    // in with this token. That is the whole danger: the monitor bot is shared, so without the owner
    // check below one person's click would start buying on every other user's machine.
    //
    // interaction.user.id is set by Discord, not by the message, so it cannot be spoofed by whoever
    // posted the embed. Only the copy belonging to the person who actually clicked acts; every other
    // copy returns silently and never acknowledges, because Discord accepts exactly one ack and a
    // chorus of them would race.
    client.on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isButton || !interaction.isButton()) return;
        const id = String(interaction.customId || '');
        if (!id.startsWith('buy:')) return;

        const clicker = String((interaction.user && interaction.user.id) || '');

        // No Discord id on this licence means EVERY click is refused, including the owner's. That is
        // a dashboard-side gap (a profile row with a null discord_id), and it is indistinguishable
        // from a dead button unless it says so. Logged once per process, not per click, because the
        // gateway delivers every user's clicks to every copy.
        if (!ownerId) {
          if (!warnedNoOwner) {
            warnedNoOwner = true;
            log('[monitor] Buy Now ignored — no Discord account is linked to this licence key');
          }
          return;
        }
        // Someone else's click. Every copy sees every click, so these are NOT logged per click —
        // that would fill each user's log with other people's activity. One line the first time is
        // worth having though: it is the only proof that this copy is receiving interactions at all,
        // which is what separates "the gateway is fine, that click was not yours" from "this copy
        // never heard the click" when a user reports the button timing out.
        if (clicker !== ownerId) {
          if (!sawForeignClick) {
            sawForeignClick = true;
            log('[monitor] Buy Now clicks are arriving (from other users) — this copy is connected');
          }
          return;
        }

        const [, site, sku, qtyRaw] = id.split(':');
        const qty = Math.max(1, Math.min(10, parseInt(qtyRaw, 10) || 1));
        if (!site || !sku) {
          log(`[monitor] Buy Now ignored — malformed button id "${id}"`);
          return;
        }
        // Always logged: a click that IS ours is rare and is the line that proves the chain worked
        // end to end. Its absence, with the line above present, means the licence's Discord account
        // is not the one that clicked.
        log(`[monitor] Buy Now — ${site} ${sku} x${qty}, clicked by you`);

        // Acknowledge FIRST, then do the work. Discord expires an unacknowledged interaction after
        // 3 seconds, and resolving profiles plus spawning browsers is well past that — reply last
        // and the button reports "This interaction failed" on a run that actually worked.
        let deferred = false;
        try {
          await interaction.deferReply({ ephemeral: true });
          deferred = true;
        } catch { /* window already closed; the buy below still runs */ }

        const said = await onBuy({ site, sku, qty });

        if (deferred) {
          try { await interaction.editReply(said || `Buying ${sku} ×${qty}`); } catch {}
        }
      } catch (e) { log('[monitor] buy-now error: ' + e.message); }
    });

    client.on('error', (e) => log('[monitor] gateway error: ' + (e && e.message)));
    // A dropped shard loses every interaction until it comes back, and the reconnect was silent —
    // so a user whose gateway had flapped saw a button that "worked before" and now times out, with
    // nothing in the log between the two. Both ends of the gap are now visible.
    client.on('shardDisconnect', (ev) => log(`[monitor] disconnected${ev && ev.code ? ` (code ${ev.code})` : ''} — clicks are missed until it reconnects`));
    client.on('shardReconnecting', () => log('[monitor] reconnecting…'));
    client.on('shardResume', (id, replayed) => log(`[monitor] reconnected — back online${Number.isFinite(replayed) ? ` (${replayed} events replayed)` : ''}`));
    client.on('ready', () => {
      state.on = true;
      state.why = '';
      log(`[monitor] connected on ${ids.length} channel(s)`);
    });

    await client.login(token);
  } catch (e) {
    state.why = e.message || String(e);
    log('[monitor] login failed — ' + state.why);
    stop();
  }
  return status();
}

function stop() {
  if (client) {
    try { client.destroy(); } catch {}
    client = null;
  }
  recent.clear();
  state.on = false;
  if (!state.why) state.why = 'stopped';
}

module.exports = { setOwnerDiscordId, start, stop, status };
