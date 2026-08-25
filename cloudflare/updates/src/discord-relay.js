const ZYN_WEBHOOK_NAME = 'Zyn';
const ZYN_WEBHOOK_AVATAR = 'https://zynbot.app/zyn-icon.png';
const RELAY_TOKEN = 'ZYN_DISCORD_RELAY_TOKEN';
const RELAY_WEBHOOK = 'ZYN_DISCORD_RELAY_WEBHOOK';
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export function inboundRelayToken(pathname) {
  const discordShaped = String(pathname || '').match(/^\/api\/(?:v10\/)?webhooks\/[0-9]+\/([^/]+)$/);
  if (discordShaped) return decodeToken(discordShaped[1]);
  const simple = String(pathname || '').match(/^\/hooks\/([^/]+)$/);
  if (simple) return decodeToken(simple[1]);
  return '';
}

export function isDiscordRelayPath(pathname) {
  return Boolean(inboundRelayToken(pathname));
}

function decodeToken(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return '';
  }
}

function tokenEquals(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!TOKEN_SHAPE.test(a) || !TOKEN_SHAPE.test(b) || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export function brandText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/Hayha AIO/gi, 'Zyn AIO')
    .replace(/HayhaAIO/gi, 'Zyn AIO')
    .replace(/\bHayha\b/gi, 'Zyn')
    .replace(/Polar AIO/gi, 'Zyn')
    .replace(/PolarAIO/gi, 'Zyn')
    .replace(/Hope AIO/gi, 'Zyn')
    .replace(/\brCart\b/gi, 'Zyn')
    .replace(/\bPolar\b/gi, 'Zyn');
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

const FOREIGN_BRAND = /hayha|polaraio|polar[-_]?aio|hopeaio|hope[-_]?aio|\brcart\b|\bpolar\b/i;
const PRODUCT_IMAGE_HOST = /walmartimages|scene7|target\.com|targetimg|pokemoncenter|bestbuy|nike\.|adidas|shopify|googleusercontent|cloudfront\.net/i;

function looksLikeForeignBrand(value) {
  return FOREIGN_BRAND.test(String(value || ''));
}

function isProductImageUrl(url) {
  try {
    return PRODUCT_IMAGE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function collectBrandImageUrls(raw) {
  const urls = new Set();
  const add = value => {
    const url = httpsUrl(value);
    if (url) urls.add(url);
  };
  add(raw && raw.avatar_url);
  for (const embed of (Array.isArray(raw && raw.embeds) ? raw.embeds : [])) {
    if (!embed || typeof embed !== 'object') continue;
    add(embed.footer && embed.footer.icon_url);
    add(embed.author && embed.author.icon_url);
  }
  return urls;
}

function inboundUsesForeignBrand(raw) {
  const parts = [raw && raw.username, raw && raw.content];
  for (const embed of (Array.isArray(raw && raw.embeds) ? raw.embeds : [])) {
    if (!embed || typeof embed !== 'object') continue;
    parts.push(embed.title, embed.description, embed.author && embed.author.name, embed.footer && embed.footer.text);
  }
  return looksLikeForeignBrand(parts.filter(Boolean).join('\n'));
}

function brandedAssetUrl(value, { role = 'image', brandImages, replaceUnknownThumbnails } = {}) {
  const url = httpsUrl(value);
  if (!url) return role === 'icon' ? ZYN_WEBHOOK_AVATAR : '';
  if (role === 'icon') return ZYN_WEBHOOK_AVATAR;
  if (brandImages && brandImages.has(url)) return ZYN_WEBHOOK_AVATAR;
  if (looksLikeForeignBrand(url)) return ZYN_WEBHOOK_AVATAR;
  if (replaceUnknownThumbnails && (role === 'thumbnail' || role === 'image') && !isProductImageUrl(url)) {
    return ZYN_WEBHOOK_AVATAR;
  }
  return url;
}

function brandAuthor(author, options) {
  if (!author || typeof author !== 'object') return null;
  const name = brandText(author.name).slice(0, 256);
  if (!name) return null;
  const out = { name, icon_url: ZYN_WEBHOOK_AVATAR };
  const url = httpsUrl(author.url);
  if (url) out.url = url;
  return out;
}

function brandEmbed(embed, options) {
  if (!embed || typeof embed !== 'object' || Array.isArray(embed)) return null;
  const out = {};
  if (typeof embed.title === 'string' && embed.title.trim()) {
    out.title = brandText(embed.title).slice(0, 256);
  }
  if (typeof embed.description === 'string' && embed.description.trim()) {
    out.description = brandText(embed.description).slice(0, 4096);
  }
  const url = httpsUrl(embed.url);
  if (url) out.url = url;
  const color = Number(embed.color);
  if (Number.isFinite(color)) out.color = Math.max(0, Math.min(0xffffff, Math.trunc(color)));
  if (Array.isArray(embed.fields)) {
    out.fields = embed.fields.slice(0, 25).map((field) => {
      if (!field || typeof field !== 'object') return null;
      const name = brandText(field.name).slice(0, 256);
      const value = brandText(field.value).slice(0, 1024);
      if (!name && !value) return null;
      return { name: name || '\u200b', value: value || '\u200b', inline: field.inline === true };
    }).filter(Boolean);
  }
  const thumbnail = brandedAssetUrl(embed.thumbnail && embed.thumbnail.url, { ...options, role: 'thumbnail' });
  if (thumbnail) out.thumbnail = { url: thumbnail };
  const image = brandedAssetUrl(embed.image && embed.image.url, { ...options, role: 'image' });
  if (image) out.image = { url: image };
  const author = brandAuthor(embed.author, options);
  if (author) out.author = author;
  out.footer = { text: ZYN_WEBHOOK_NAME, icon_url: ZYN_WEBHOOK_AVATAR };
  if (typeof embed.timestamp === 'string' && !Number.isNaN(Date.parse(embed.timestamp))) {
    out.timestamp = new Date(embed.timestamp).toISOString();
  }
  if (!out.title && !out.description && !(out.fields && out.fields.length)) return null;
  return out;
}

export function brandDiscordPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const options = {
    brandImages: collectBrandImageUrls(raw),
    replaceUnknownThumbnails: inboundUsesForeignBrand(raw),
  };
  const embeds = Array.isArray(raw.embeds)
    ? raw.embeds.slice(0, 10).map(embed => brandEmbed(embed, options)).filter(Boolean)
    : [];
  const content = typeof raw.content === 'string' ? brandText(raw.content).slice(0, 2000) : '';
  if (!content && !embeds.length) return null;
  return {
    username: ZYN_WEBHOOK_NAME,
    avatar_url: ZYN_WEBHOOK_AVATAR,
    allowed_mentions: { parse: [] },
    ...(content ? { content } : {}),
    embeds,
  };
}

export async function handleDiscordRelay(request, env, {
  postDiscord,
  parseWebhook,
} = {}) {
  const token = inboundRelayToken(new URL(request.url).pathname);
  const expected = String((env && env[RELAY_TOKEN]) || '');
  if (!tokenEquals(token, expected)) {
    return new Response('Not found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const payload = brandDiscordPayload(parsed);
  if (!payload) return new Response('Empty webhook payload', { status: 400 });

  const webhook = typeof parseWebhook === 'function' ? parseWebhook(env && env[RELAY_WEBHOOK]) : null;
  if (!webhook) return new Response('Relay is not configured', { status: 503 });
  if (typeof postDiscord !== 'function') return new Response('Relay is not configured', { status: 503 });

  const result = await postDiscord(webhook, payload);
  if (result && result.messageId) return new Response(null, { status: 204 });
  return new Response('Upstream webhook failed', { status: 502 });
}

export const discordRelay = {
  name: ZYN_WEBHOOK_NAME,
  avatar: ZYN_WEBHOOK_AVATAR,
  tokenSecret: RELAY_TOKEN,
  webhookSecret: RELAY_WEBHOOK,
};
