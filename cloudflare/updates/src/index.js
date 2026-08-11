const CHANNELS = new Set(['mac', 'windows', 'runtimes', 'extension']);
const MAC_ARCHES = new Set(['arm64', 'x64']);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CURRENT_MAC_VERSION = '1.6.92';
const EXTENSION_NAME = 'Zyn Harvester';
const EXTENSION_METADATA_KEY = 'extension/latest.json';
const EXTENSION_ICON_URL = 'https://zynbot.app/zyn-icon.png';
const EXTENSION_DOWNLOAD_URL = 'https://updates.zynbot.app/download/extension';
const EXTENSION_MAX_BYTES = 50 * 1024 * 1024;
const EXTENSION_WEBHOOK_SECRET = 'ZYN_EXTENSION_RELEASE_DISCORD_WEBHOOK';
const EXTENSION_METADATA_FIELDS = [
  'filename',
  'name',
  'publishedAt',
  'schemaVersion',
  'sha256',
  'size',
  'version',
];

function emptyMacFeed(key) {
  if (!/^mac\/(arm64|x64)\/latest-mac\.yml$/.test(key)) return null;
  return new Response([
    `version: ${CURRENT_MAC_VERSION}`,
    'files: []',
    `releaseDate: '${new Date(0).toISOString()}'`,
    '',
  ].join('\n'), {
    headers: {
      'content-type': 'text/yaml; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function releaseKey(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const parts = decoded.split('/').filter(Boolean);
  if (!CHANNELS.has(parts[0])) {
    return null;
  }
  if (parts[0] === 'mac') {
    const legacyMacKey = parts.length === 2 && SAFE_FILENAME.test(parts[1]);
    const architectureMacKey = parts.length === 3
      && MAC_ARCHES.has(parts[1])
      && SAFE_FILENAME.test(parts[2]);
    if (!legacyMacKey && !architectureMacKey) return null;
  } else if (parts.length !== 2 || !SAFE_FILENAME.test(parts[1])) {
    return null;
  }
  return parts.join('/');
}

function validExtensionVersion(value) {
  if (typeof value !== 'string') return false;
  const components = value.split('.');
  if (components.length < 1 || components.length > 4) return false;
  if (!components.every((component) => {
    if (!/^(0|[1-9][0-9]*)$/.test(component)) return false;
    const number = Number(component);
    return Number.isInteger(number) && number >= 0 && number <= 65535;
  })) return false;
  return components.some((component) => Number(component) !== 0);
}

function compareExtensionVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function extensionFilename(version) {
  return `Zyn-Harvester-${version}.zip`;
}

function extensionArchiveVersion(key) {
  const match = key.match(/^extension\/Zyn-Harvester-([0-9.]+)\.zip$/);
  if (!match || !validExtensionVersion(match[1])) return null;
  return extensionFilename(match[1]) === key.slice('extension/'.length) ? match[1] : null;
}

function extensionVersionedDownloadUrl(version) {
  return `${EXTENSION_DOWNLOAD_URL}/${version}`;
}

function responseHeaders(object, key, partial = false) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  if (key.endsWith('.dmg') || key.endsWith('.zip') || key.endsWith('.exe')) {
    const filename = extensionArchiveVersion(key) ? 'Zyn-Harvester.zip' : key.split('/').pop();
    headers.set('content-disposition', `attachment; filename="${filename}"`);
  }
  if (SHA256.test(object.customMetadata?.sha256 || '')) {
    headers.set('x-zyn-sha256', object.customMetadata.sha256);
  }

  if (!headers.has('cache-control')) {
    headers.set(
      'cache-control',
      key.endsWith('.yml') || key.endsWith('latest.json')
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
    );
  }

  if (partial && object.range) {
    const start = object.range.offset;
    const length = object.range.length;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
  } else {
    headers.set('content-length', String(object.size));
  }

  return headers;
}

async function latestMacDmg(env, arch) {
  let metadata = await env.RELEASES.get(`mac/${arch}/latest-mac.yml`);
  // Keep the original Apple-silicon release reachable while the new feed is populated.
  if ((!metadata || !('body' in metadata)) && arch === 'arm64') {
    metadata = await env.RELEASES.get('mac/latest-mac.yml');
  }
  if (!metadata || !('body' in metadata)) return null;
  const match = (await metadata.text()).match(/^\s*-\s+url:\s+([A-Za-z0-9][A-Za-z0-9._+-]*\.dmg)\s*$/m);
  return match ? match[1] : null;
}

async function latestWindowsInstaller(env) {
  const metadata = await env.RELEASES.get('windows/latest.yml');
  if (!metadata || !('body' in metadata)) return null;
  const match = (await metadata.text()).match(/^path:\s+([A-Za-z0-9][A-Za-z0-9._+-]*\.exe)\s*$/m);
  return match ? match[1] : null;
}

function canonicalExtensionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = Object.keys(value).sort();
  if (fields.length !== EXTENSION_METADATA_FIELDS.length
      || fields.some((field, index) => field !== EXTENSION_METADATA_FIELDS[index])) {
    return null;
  }
  if (value.schemaVersion !== 1 || value.name !== EXTENSION_NAME) return null;
  if (!validExtensionVersion(value.version)) return null;
  if (value.filename !== extensionFilename(value.version)) return null;
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > EXTENSION_MAX_BYTES) return null;
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) return null;
  if (typeof value.publishedAt !== 'string') return null;
  const publishedAt = new Date(value.publishedAt);
  if (!Number.isFinite(publishedAt.getTime()) || publishedAt.toISOString() !== value.publishedAt) return null;
  return {
    schemaVersion: 1,
    name: EXTENSION_NAME,
    version: value.version,
    filename: value.filename,
    size: value.size,
    sha256: value.sha256,
    publishedAt: value.publishedAt,
  };
}

async function readExtensionMetadata(env) {
  const object = await env.RELEASES.get(EXTENSION_METADATA_KEY);
  if (!object || !('body' in object)) return { state: 'missing', metadata: null };
  try {
    const metadata = canonicalExtensionMetadata(JSON.parse(await object.text()));
    return metadata
      ? { state: 'valid', metadata }
      : { state: 'invalid', metadata: null };
  } catch {
    return { state: 'invalid', metadata: null };
  }
}

async function latestExtension(env) {
  const result = await readExtensionMetadata(env);
  return result.state === 'valid' ? result.metadata : null;
}

function uploadAuthorized(request, env) {
  const authorization = request.headers.get('authorization');
  return Boolean(env.ZYN_UPLOAD_TOKEN && authorization === `Bearer ${env.ZYN_UPLOAD_TOKEN}`);
}

function uploadMetadata(request, customMetadata) {
  return {
    httpMetadata: {
      contentType: request.headers.get('x-object-content-type') || 'application/octet-stream',
      cacheControl: request.headers.get('x-object-cache-control') || 'no-store',
    },
    ...(customMetadata ? { customMetadata } : {}),
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function objectArrayBuffer(object) {
  if (typeof object.arrayBuffer === 'function') return object.arrayBuffer();
  if ('body' in object) return new Response(object.body).arrayBuffer();
  return null;
}

function extensionConflict(message) {
  return Response.json({ error: message }, { status: 409 });
}

async function uploadExtensionArchive(request, env, key, version) {
  if (request.method !== 'PUT' || !request.body) return new Response('Bad request', { status: 400 });
  const sha256 = request.headers.get('x-object-sha256') || '';
  const rawLength = request.headers.get('content-length') || '';
  if (!SHA256.test(sha256) || !/^[1-9][0-9]*$/.test(rawLength)) {
    return new Response('Missing or invalid extension integrity metadata', { status: 400 });
  }
  const expectedSize = Number(rawLength);
  if (!Number.isSafeInteger(expectedSize) || expectedSize > EXTENSION_MAX_BYTES) {
    return new Response('Extension archive is too large', { status: 413 });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== expectedSize || await sha256Hex(bytes) !== sha256) {
    return extensionConflict('Extension archive integrity check failed.');
  }

  const existing = await env.RELEASES.head(key);
  if (existing) {
    if (existing.size === expectedSize
        && existing.customMetadata?.sha256 === sha256
        && existing.customMetadata?.version === version) {
      return Response.json({
        key,
        etag: existing.httpEtag,
        duplicate: true,
        version,
        size: expectedSize,
        sha256,
      });
    }
    return extensionConflict('An extension archive already exists for this version.');
  }

  const metadata = uploadMetadata(request, { sha256, version });
  metadata.httpMetadata.contentType = 'application/zip';
  metadata.httpMetadata.cacheControl = 'public, max-age=31536000, immutable';
  const object = await env.RELEASES.put(key, bytes, metadata);
  return Response.json({
    key: object.key,
    etag: object.httpEtag,
    duplicate: false,
    version,
    size: expectedSize,
    sha256,
  });
}

async function uploadRequest(request, env, url) {
  if (!uploadAuthorized(request, env)) return new Response('Not found', { status: 404 });

  const key = releaseKey(url.pathname.slice('/__upload'.length));
  const action = url.searchParams.get('action');
  if (!key || !action) return new Response('Bad request', { status: 400 });

  if (key === EXTENSION_METADATA_KEY) {
    return extensionConflict('Extension metadata is managed by the publish endpoint.');
  }
  if (key.startsWith('extension/')) {
    const version = extensionArchiveVersion(key);
    if (!version) return new Response('Invalid extension archive name', { status: 400 });
    if (action !== 'put') {
      return new Response('Extension multipart uploads are not supported', { status: 400 });
    }
    return uploadExtensionArchive(request, env, key, version);
  }

  if (action === 'put' && request.method === 'PUT' && request.body) {
    const object = await env.RELEASES.put(key, request.body, uploadMetadata(request));
    return Response.json({ key: object.key, etag: object.httpEtag });
  }

  if (action === 'mpu-create' && request.method === 'POST') {
    const upload = await env.RELEASES.createMultipartUpload(key, uploadMetadata(request));
    return Response.json({ key: upload.key, uploadId: upload.uploadId });
  }

  const uploadId = url.searchParams.get('uploadId');
  if (!uploadId) return new Response('Missing uploadId', { status: 400 });
  const upload = env.RELEASES.resumeMultipartUpload(key, uploadId);

  try {
    if (action === 'mpu-uploadpart' && request.method === 'PUT' && request.body) {
      const partNumber = Number(url.searchParams.get('partNumber'));
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return new Response('Invalid partNumber', { status: 400 });
      }
      return Response.json(await upload.uploadPart(partNumber, request.body));
    }

    if (action === 'mpu-complete' && request.method === 'POST') {
      const { parts } = await request.json();
      if (!Array.isArray(parts) || !parts.length) return new Response('Missing parts', { status: 400 });
      const object = await upload.complete(parts);
      return Response.json({ key: object.key, etag: object.httpEtag });
    }

    if (action === 'mpu-abort' && request.method === 'DELETE') {
      await upload.abort();
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    return new Response(String(error), { status: 400 });
  }

  return new Response('Bad request', { status: 400 });
}

async function readPublishRequest(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16 * 1024) return null;
  const body = await request.text();
  if (body.length > 16 * 1024) return null;
  try {
    return canonicalExtensionMetadata(JSON.parse(body));
  } catch {
    return null;
  }
}

function validDiscordWebhook(rawUrl) {
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

function discordPayload(metadata) {
  const downloadUrl = extensionVersionedDownloadUrl(metadata.version);
  return {
    username: 'Zyn',
    avatar_url: EXTENSION_ICON_URL,
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Zyn Harvester v${metadata.version} is ready`,
      url: downloadUrl,
      description: `[Download Zyn Harvester v${metadata.version}](${downloadUrl})`,
      color: 14753096,
      thumbnail: { url: EXTENSION_ICON_URL },
      fields: [
        { name: 'Version', value: metadata.version, inline: true },
        { name: 'Download', value: `[Zyn-Harvester.zip](${downloadUrl})`, inline: true },
      ],
      footer: { text: 'Zyn', icon_url: EXTENSION_ICON_URL },
      timestamp: metadata.publishedAt,
    }],
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function postDiscordRelease(webhook, metadata) {
  const body = JSON.stringify(discordPayload(metadata));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(webhook.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'DiscordBot (https://zynbot.app, 1.0)',
        },
        body,
        redirect: 'manual',
      });
      if (response.ok) {
        const message = await response.json().catch(() => null);
        if (message && typeof message.id === 'string' && message.id) {
          return { messageId: message.id };
        }
        return { error: `Discord returned HTTP ${response.status} without a message id.` };
      }

      if (attempt < 2 && response.status === 429) {
        const rateLimit = await response.json().catch(() => null);
        const seconds = Number(rateLimit?.retry_after);
        await delay(Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1000, 0), 5000) : 500);
        continue;
      }
      if (attempt < 2 && response.status >= 500) {
        await delay(250 * (attempt + 1));
        continue;
      }
      return { error: `Discord returned HTTP ${response.status}.` };
    } catch {
      if (attempt === 2) return { error: 'Discord request failed before receiving a response.' };
      await delay(250 * (attempt + 1));
    }
  }
  return { error: 'Discord notification failed.' };
}

function publishResponse(metadata, options = {}) {
  return Response.json({
    published: true,
    notified: Boolean(options.messageId),
    duplicate: Boolean(options.duplicate),
    version: metadata.version,
    downloadUrl: extensionVersionedDownloadUrl(metadata.version),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.error ? { error: options.error } : {}),
  }, { status: options.error ? 502 : 200 });
}

async function publishExtension(request, env) {
  if (!uploadAuthorized(request, env)) return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  }
  const metadata = await readPublishRequest(request);
  if (!metadata) return new Response('Bad request', { status: 400 });

  const key = `extension/${metadata.filename}`;
  const artifact = await env.RELEASES.get(key);
  if (!artifact || !('body' in artifact)
      || artifact.size !== metadata.size
      || artifact.customMetadata?.sha256 !== metadata.sha256
      || artifact.customMetadata?.version !== metadata.version) {
    return extensionConflict('Extension archive metadata does not match the uploaded artifact.');
  }
  const artifactBytes = await objectArrayBuffer(artifact);
  if (!artifactBytes || artifactBytes.byteLength !== metadata.size
      || await sha256Hex(artifactBytes) !== metadata.sha256) {
    return extensionConflict('Extension archive integrity check failed.');
  }

  const current = await readExtensionMetadata(env);
  if (current.state === 'invalid') {
    return extensionConflict('The current extension release metadata is invalid.');
  }
  let duplicate = false;
  let publishedMetadata = metadata;
  if (current.state === 'valid') {
    const comparison = compareExtensionVersions(metadata.version, current.metadata.version);
    if (comparison < 0) return extensionConflict('Extension release downgrades are not allowed.');
    if (comparison === 0) {
      if (metadata.filename !== current.metadata.filename
          || metadata.size !== current.metadata.size
          || metadata.sha256 !== current.metadata.sha256) {
        return extensionConflict('This extension version has already been published with different contents.');
      }
      duplicate = true;
      publishedMetadata = current.metadata;
    }
  }

  if (!duplicate) {
    await env.RELEASES.put(
      EXTENSION_METADATA_KEY,
      `${JSON.stringify(publishedMetadata, null, 2)}\n`,
      {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'no-store',
        },
      },
    );
  }

  const receiptKey = `_internal/extension-notifications/${publishedMetadata.version}-${publishedMetadata.sha256}.json`;
  const receipt = await env.RELEASES.get(receiptKey);
  if (receipt && 'body' in receipt) {
    try {
      const saved = JSON.parse(await receipt.text());
      if (typeof saved.messageId === 'string' && saved.messageId) {
        return publishResponse(publishedMetadata, { duplicate: true, messageId: saved.messageId });
      }
    } catch {
      // An invalid internal receipt is retried without exposing its contents.
    }
  }

  const webhook = validDiscordWebhook(env[EXTENSION_WEBHOOK_SECRET]);
  const notification = webhook
    ? await postDiscordRelease(webhook, publishedMetadata)
    : { error: 'Discord webhook configuration is invalid.' };
  if (!notification.messageId) {
    return publishResponse(publishedMetadata, {
      duplicate,
      error: notification.error,
    });
  }
  const { messageId } = notification;

  await env.RELEASES.put(receiptKey, `${JSON.stringify({
    version: publishedMetadata.version,
    sha256: publishedMetadata.sha256,
    messageId,
    notifiedAt: new Date().toISOString(),
  })}\n`, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
    },
  });
  return publishResponse(publishedMetadata, { duplicate, messageId });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json(
        {
          service: 'zyn-updates',
          status: 'ok',
          macArchitectures: [...MAC_ARCHES],
          windowsArchitectures: ['x64'],
          extensionChannel: true,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (url.pathname === '/__publish/extension') {
      return publishExtension(request, env);
    }

    const macDownload = url.pathname.match(/^\/download\/mac\/(arm64|x64)$/);
    const legacyMacDownload = url.pathname === '/download'
      || url.pathname === '/rCart.dmg'
      || url.pathname === '/Zyn.dmg';
    if (macDownload || legacyMacDownload) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const arch = macDownload ? macDownload[1] : 'arm64';
      const filename = await latestMacDmg(env, arch);
      if (!filename) return new Response('No macOS release is available', { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: new URL(`/mac/${arch}/${filename}`, url.origin).toString(),
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === '/download/windows' || url.pathname === '/windows/download') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const filename = await latestWindowsInstaller(env);
      if (!filename) return new Response('No Windows release is available', { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: new URL(`/windows/${filename}`, url.origin).toString(),
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === '/download/extension') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const metadata = await latestExtension(env);
      if (!metadata) return new Response('No extension release is available', { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: new URL(`/extension/${metadata.filename}`, url.origin).toString(),
          'cache-control': 'no-store',
        },
      });
    }

    const versionedExtensionDownload = url.pathname.match(/^\/download\/extension\/([^/]+)$/);
    if (versionedExtensionDownload) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const version = versionedExtensionDownload[1];
      if (!validExtensionVersion(version)) return new Response('Not found', { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: new URL(`/extension/${extensionFilename(version)}`, url.origin).toString(),
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname.startsWith('/__upload/')) {
      return uploadRequest(request, env, url);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'GET, HEAD' },
      });
    }

    const architectureFeed = url.pathname.match(/^\/mac\/(arm64|x64)\/latest-mac\.yml$/);
    if (architectureFeed) {
      const feedKey = url.pathname.slice(1);
      const publishedFeed = await env.RELEASES.head(feedKey);
      if (!publishedFeed) {
        if (request.method === 'HEAD') {
          const body = `version: ${CURRENT_MAC_VERSION}\nfiles: []\n`;
          return new Response(null, {
            headers: {
              'content-type': 'text/yaml; charset=utf-8',
              'content-length': String(body.length),
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            },
          });
        }
        return emptyMacFeed(feedKey);
      }
    }

    const key = releaseKey(url.pathname);
    if (!key) return new Response('Not found', { status: 404 });

    if (request.method === 'HEAD') {
      const object = await env.RELEASES.head(key);
      if (!object) return new Response('Not found', { status: 404 });
      return new Response(null, { headers: responseHeaders(object, key) });
    }

    const rangeRequested = request.headers.has('range');
    const getOptions = { onlyIf: request.headers };
    if (rangeRequested) getOptions.range = request.headers;
    const object = await env.RELEASES.get(key, getOptions);
    if (!object) return emptyMacFeed(key) || new Response('Not found', { status: 404 });

    const headers = responseHeaders(object, key, rangeRequested);
    if (!('body' in object)) {
      const notModified = request.headers.has('if-none-match') || request.headers.has('if-modified-since');
      return new Response(null, { status: notModified ? 304 : 412, headers });
    }

    return new Response(object.body, {
      status: rangeRequested ? 206 : 200,
      headers,
    });
  },
};
