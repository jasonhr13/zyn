import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { downloadSiteOrigin } from '../src/index.js';

test('generates download links for the same domain family as the admin', () => {
  assert.equal(downloadSiteOrigin(new Request('https://license.rcart.app/api/admin/users/1/download-link')), 'https://rcart.app');
  assert.equal(downloadSiteOrigin(new Request('https://license.zynbot.app/api/admin/users/1/download-link')), 'https://zynbot.app');
  assert.equal(downloadSiteOrigin(
    new Request('https://license.zynbot.app/api/admin/users/1/download-link'),
    { DOWNLOAD_SITE_ORIGIN: 'https://preview.example/' },
  ), 'https://preview.example');
});

test('serves the license health endpoint on the Zyn domain', async () => {
  const response = await worker.fetch(new Request('https://license.zynbot.app/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'zyn-license-api', status: 'ok' });
});

test('ships the Zyn-branded admin assets and both custom domains', async () => {
  const [html, css, wrangler] = await Promise.all([
    readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin.css', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /Zyn License Admin/);
  assert.match(html, /\/zyn-icon\.png/);
  assert.match(html, /\/favicon\.png/);
  assert.match(html, /\/manifest\.webmanifest/);
  assert.match(css, /--rose:\s*#e11d48/i);
  assert.match(css, /--orange:\s*#f97316/i);
  assert.doesNotMatch(css, /#62d9a7/i);
  assert.match(wrangler, /license\.rcart\.app/);
  assert.match(wrangler, /license\.zynbot\.app/);
  await access(new URL('../public/zyn-icon.png', import.meta.url));
  await access(new URL('../public/favicon.png', import.meta.url));
  await access(new URL('../public/apple-touch-icon.png', import.meta.url));
  await access(new URL('../public/manifest.webmanifest', import.meta.url));
});
