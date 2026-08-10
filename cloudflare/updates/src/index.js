const CHANNELS = new Set(['mac', 'windows', 'runtimes']);
const MAC_ARCHES = new Set(['arm64', 'x64']);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CURRENT_MAC_VERSION = '1.6.85';

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

function responseHeaders(object, key, partial = false) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  if (key.endsWith('.dmg') || key.endsWith('.zip') || key.endsWith('.exe')) {
    headers.set('content-disposition', `attachment; filename="${key.split('/').pop()}"`);
  }

  if (!headers.has('cache-control')) {
    headers.set(
      'cache-control',
      key.endsWith('.yml') ? 'no-store' : 'public, max-age=31536000, immutable',
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

function uploadAuthorized(request, env) {
  const authorization = request.headers.get('authorization');
  return Boolean(env.ZYN_UPLOAD_TOKEN && authorization === `Bearer ${env.ZYN_UPLOAD_TOKEN}`);
}

function uploadMetadata(request) {
  return {
    httpMetadata: {
      contentType: request.headers.get('x-object-content-type') || 'application/octet-stream',
      cacheControl: request.headers.get('x-object-cache-control') || 'no-store',
    },
  };
}

async function uploadRequest(request, env, url) {
  if (!uploadAuthorized(request, env)) return new Response('Not found', { status: 404 });

  const key = releaseKey(url.pathname.slice('/__upload'.length));
  const action = url.searchParams.get('action');
  if (!key || !action) return new Response('Bad request', { status: 400 });

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
        },
        { headers: { 'cache-control': 'no-store' } },
      );
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
