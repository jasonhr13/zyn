'use strict';

require('./node-path');

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { createDataStore } = require('./data-store');
const { createCookieBank } = require('./cookie-bank');
const { createEngineHost } = require('./engine-host');
const { createHttpServer, webEngineDemand } = require('./http');
const { createLicenseHost } = require('./license-host');
const { createHarvestHost } = require('./harvest-host');
const { createWebSessions } = require('./sessions');
const { createBackupHost } = require('./backup-host');
const { createOtpHost } = require('./otp-host');
const { fileSafeStorage } = require('./license-host');

const dataDir = process.env.ZYN_DATA_DIR || path.join(__dirname, '..', 'data');
const publicPort = Number(process.env.PORT) || 8080;
const publicHost = process.env.ZYN_WEB_BIND || '0.0.0.0';
const shapeToken = process.env.ZYN_SHAPE_TOKEN || crypto.randomBytes(24).toString('hex');
const webToken = process.env.ZYN_WEB_TOKEN || '';
const shapePort = Number(process.env.ZYN_SHAPE_PORT) || 4727;

async function main() {
  const store = createDataStore(dataDir);
  const sessions = createWebSessions(store);
  let harvest = null;
  const license = createLicenseHost({
    dataDirectory: dataDir,
    logger: console,
    onStatus: status => {
      if (!harvest) return;
      if (status && status.ok) harvest.start();
      else harvest.stop();
    },
  });
  license.start();

  const bank = createCookieBank({
    token: shapeToken,
    port: shapePort,
    ttlMs: Math.max(30, Number(store.getSettings().targetCookieTtlSec) || 600) * 1000,
  });
  const engine = createEngineHost({
    token: shapeToken,
    shapePort,
    logger: console,
  });
  harvest = createHarvestHost({
    dataDirectory: dataDir,
    authority: license.authority,
    bank,
    store,
    logger: console,
  });
  const backup = createBackupHost({
    store,
    dataDirectory: dataDir,
    authority: license.authority,
    safeStorage: fileSafeStorage(),
    logger: console,
  });
  const otp = createOtpHost({
    store,
    engine,
    logger: console,
  });

  const publishDemand = async demand => {
    try {
      const body = JSON.stringify(demand);
      await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: shapePort,
          path: '/demand',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-zyn-token': shapeToken,
            'content-length': Buffer.byteLength(body),
          },
        }, res => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end(body);
      });
    } catch (error) {
      console.warn(`[zyn-web] demand publish failed: ${error.message}`);
    }
  };

  const { server } = createHttpServer({
    store,
    engine,
    bank,
    webToken,
    license,
    sessions,
    harvest,
    backup,
    otp,
    onDemand: publishDemand,
  });

  await bank.listen();
  await engine.listen();
  await license.refresh();
  await publishDemand(webEngineDemand(0, Number(store.getSettings().targetAtcCookiesPerTask) || 3));
  if (license.status().ok) harvest.start();
  await new Promise(resolve => server.listen(publicPort, publicHost, resolve));
  console.log(`zyn-web listening on ${publicHost}:${publicPort}`);
  console.log(`data directory ${dataDir}`);
  console.log(`engine ${engine.enginePath}`);
  console.log('cookie broker 127.0.0.1:' + shapePort);
  const signedIn = license.status();
  if (signedIn.ok) console.log(`signed in as ${signedIn.email} (Full Engine)`);
  else console.log('sign in at / with your Zyn email and password');
  if (webToken) console.log('ZYN_WEB_TOKEN extra lock is on');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
