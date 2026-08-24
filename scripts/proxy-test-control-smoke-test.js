#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  parseProxyLine,
  lineKey,
  displayHost,
  speedBucket,
  percentile,
  pickSample,
  resolveMode,
  FULL_TEST_LIMIT,
  SAMPLE_SIZE,
  createProxyTestControl,
} = require('../launcher/proxy-test-control');

assert.deepEqual(parseProxyLine('proxy.example:8000:user:pass'), {
  server: 'proxy.example:8000', username: 'user', password: 'pass',
});
assert.equal(parseProxyLine('proxy.example'), null);
assert.equal(speedBucket(120), 'fast');
assert.equal(speedBucket(240), 'medium');
assert.equal(speedBucket(800), 'slow');
assert.equal(percentile([10, 20, 30, 40], 50), 20);
assert.equal(pickSample(['a', 'b', 'c'], 10).length, 3);
assert.equal(pickSample(Array.from({ length: 40 }, (_, i) => i), 10, () => 0).length, 10);
assert.equal(resolveMode(100, 'auto'), 'full');
assert.equal(resolveMode(FULL_TEST_LIMIT + 1, 'auto'), 'sample');
assert.equal(resolveMode(12, 'sample'), 'sample');
assert.match(displayHost(parseProxyLine('1.2.3.4:8000:user:secret'), '1.2.3.4:8000:user:secret'), /1\.2\.3\.4:8000 · auth/);
assert.doesNotMatch(displayHost(parseProxyLine('1.2.3.4:8000:user:secret'), '1.2.3.4:8000:user:secret'), /secret/);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-proxy-test-'));
const lines = {
  ISP: Array.from({ length: 80 }, (_, index) => `10.0.0.${index}:8000:user:pass`),
  Resi: Array.from({ length: 400 }, (_, index) => `11.0.${Math.floor(index / 256)}.${index % 256}:9000:user:pass`),
  Broken: ['not-a-proxy', '12.0.0.1:8000:user:pass'],
};

const outcomes = new Map();
const control = createProxyTestControl({
  dataDirectory: directory,
  getProxyLines: ref => lines[ref] || [],
  probe: async parsed => {
    const key = `${parsed.server}`;
    const scripted = outcomes.get(key);
    if (scripted) return scripted;
    const last = Number(String(parsed.server).split('.').pop().split(':')[0]);
    return last % 10 === 0
      ? { ok: false, error: 'timeout', ms: 5000 }
      : { ok: true, ms: 80 + (last % 7) * 15 };
  },
  random: () => 0,
  now: () => 1_700_000_000_000,
});

(async () => {
  const small = await control.start({ ref: 'ISP', mode: 'auto' });
  assert.equal(small.mode, 'full');
  assert.equal(small.sampled, 80);
  assert.equal(small.tested, 80);
  assert.ok(small.working > 0);
  assert.ok(small.failed > 0);
  assert.equal(small.working + small.failed, 80);
  assert.equal(typeof small.p50, 'number');

  const report = control.getReport('ISP');
  assert.equal(report.rows.length, 80);
  assert.ok(report.rows.every(row => row.host.includes('10.0.0.')));
  assert.ok(report.rows.every(row => !String(row.host).includes('pass')));
  assert.ok(report.rows.some(row => row.status === 'working'));
  assert.ok(report.rows.some(row => row.status === 'failed'));

  const large = await control.start({ ref: 'Resi', mode: 'auto' });
  assert.equal(large.mode, 'sample');
  assert.equal(large.sampled, SAMPLE_SIZE);
  assert.equal(large.tested, SAMPLE_SIZE);
  const largeReport = control.getReport('Resi');
  assert.ok(largeReport.rows.length <= 500);
  assert.ok(largeReport.tested <= SAMPLE_SIZE);

  const broken = await control.start({ ref: 'Broken', mode: 'full' });
  assert.equal(broken.invalid, 1);
  assert.equal(broken.tested, 1);
  const brokenReport = control.getReport('Broken');
  assert.equal(brokenReport.rows.filter(row => row.status === 'invalid').length, 1);

  const summaries = control.getSummaries();
  assert.equal(summaries.ISP.mode, 'full');
  assert.equal(summaries.Resi.mode, 'sample');
  assert.ok(fs.existsSync(path.join(directory, 'proxy-tests.json')));
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'proxy-tests.json'), 'utf8'));
  assert.equal(lineKey(lines.ISP[0]) in persisted.lists.ISP.results, true);

  const page = fs.readFileSync(path.join(__dirname, '../frontend/src/components/pages/proxies.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../launcher/bootstrap.js'), 'utf8');
  const macBuild = fs.readFileSync(path.join(__dirname, '../scripts/build-zyn.sh'), 'utf8');
  const winBuild = fs.readFileSync(path.join(__dirname, '../scripts/build-zyn-windows.sh'), 'utf8');
  assert.match(page, /startProxyTest/);
  assert.match(page, /Test sample/);
  assert.match(page, /healthLabel/);
  assert.match(page, /Target latency/);
  const tester = fs.readFileSync(path.join(__dirname, '../launcher/proxy-test-control.js'), 'utf8');
  assert.match(tester, /redsky\.target\.com/);
  assert.doesNotMatch(tester, /cloudflare\.com\/cdn-cgi\/trace/);
  assert.match(bootstrap, /createProxyTestControl/);
  assert.match(bootstrap, /installProxyTestIpc/);
  assert.match(macBuild, /proxy-test-control\.js/);
  assert.match(winBuild, /proxy-test-control\.js/);
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/runtime-contract.json'), 'utf8'));
  assert.ok(contract.requiredResources.includes('Contents/Resources/app/proxy-test-control.js'));

  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const proxy = net.createServer(client => {
    let header = '';
    const onData = chunk => {
      header += chunk.toString('latin1');
      const split = header.indexOf('\r\n\r\n');
      if (split < 0) return;
      client.removeListener('data', onData);
      const requestLine = header.slice(0, header.indexOf('\r\n'));
      const target = requestLine.match(/^CONNECT ([^:\s]+):(\d+)/);
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const upstream = net.connect({ host: target[1], port: Number(target[2]) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const leftover = header.slice(split + 4);
        if (leftover) upstream.write(Buffer.from(leftover, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-proxy-live-'));
  const live = createProxyTestControl({
    dataDirectory: liveDir,
    getProxyLines: () => [`127.0.0.1:${proxy.address().port}`],
    probeUrl: `http://127.0.0.1:${origin.address().port}/health`,
    timeoutMs: 2000,
    now: () => Date.now(),
  });
  const liveResult = await live.start({ ref: 'Local', mode: 'full' });
  assert.equal(liveResult.working, 1, `live CONNECT probe failed: ${JSON.stringify(liveResult)}`);
  origin.close();
  proxy.close();
  fs.rmSync(liveDir, { recursive: true, force: true });

  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    fullLimit: FULL_TEST_LIMIT,
    sampleSize: SAMPLE_SIZE,
    isp: { tested: small.tested, working: small.working, failed: small.failed },
    resi: { mode: large.mode, sampled: large.sampled },
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
