#!/usr/bin/env node
'use strict';
// Serves the compiled renderer with an in-memory Electron bridge. No production
// app data, credentials, engines, or external API endpoints are loaded.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const build = path.resolve(__dirname, '../frontend/build');
const bridge = path.join(__dirname, 'fixtures/zyn-ui-preview.js');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function createPreviewServer() {
  return http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    const relative = route === '/' ? '/index.html' : route;
    const file = route === '/__preview-bridge.js' ? bridge : path.resolve(build, `.${relative}`);
    if (file !== bridge && !file.startsWith(`${build}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    try {
      let content = fs.readFileSync(file);
      if (file.endsWith('index.html')) {
        content = content.toString().replace('<head>', '<head><script src="/__preview-bridge.js"></script><style>.title-bar-caption::after{content:" · Sample data";color:var(--accent)}</style>');
      }
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404); response.end('Build the frontend before starting the preview.'); }
  });
}
if (require.main === module) {
  const port = Number(process.env.ZYN_UI_PREVIEW_PORT) || 4173;
  createPreviewServer().listen(port, '127.0.0.1', () => {
    console.log(`Zyn UI preview: http://127.0.0.1:${port} (sample data only)`);
    console.log('Add ?empty=1 for empty states, ?locked=1 for sign-in, or ?targetOnly=1 for restricted navigation.');
  });
}
module.exports = { createPreviewServer };
