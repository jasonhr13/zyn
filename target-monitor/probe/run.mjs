#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProxyLine, REGION_LABELS, runSuite } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.PROBE_APP || 'hope-redsky-probe';
const DEFAULT_REGIONS = ['iad', 'dfw', 'ord'];

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx === process.argv.length - 1) return fallback;
  return process.argv[idx + 1];
}

function has(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(`Usage:
  node target-monitor/probe/run.mjs --proxies proxies.txt
  node target-monitor/probe/run.mjs --direct-only
  node target-monitor/probe/run.mjs --local --proxies proxies.txt

Options:
  --proxies <file>     One proxy per line (url, host:port:user:pass, or user:pass@host:port)
  --regions iad,dfw,ord
  --direct-only        Skip proxies; measure this Fly VM to Redsky only
  --local              Run the suite on this machine instead of Fly
  --rounds 1
  --concurrency 12
  --timeout-ms 8000
  --token <token>      Or PROBE_TOKEN, or target-monitor/probe/.token
`);
}

async function loadToken() {
  if (process.env.PROBE_TOKEN) return process.env.PROBE_TOKEN.trim();
  const fromArg = arg('--token');
  if (fromArg) return fromArg;
  const tokenFile = path.join(here, '.token');
  if (existsSync(tokenFile)) return (await readFile(tokenFile, 'utf8')).trim();
  return '';
}

async function loadProxies(file) {
  if (!file) return [];
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const parsed = lines.map(parseProxyLine);
  const ok = parsed.filter(Boolean);
  const bad = lines.length - ok.length;
  if (!ok.length) throw new Error(`no valid proxies in ${file}`);
  if (bad) console.warn(`skipped ${bad} unreadable proxy line(s)`);
  return lines;
}

function fly(args) {
  const result = spawnSync('fly', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`fly ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function machinesByRegion(wanted) {
  const raw = fly(['machines', 'list', '-a', APP, '--json']);
  const machines = JSON.parse(raw);
  const map = new Map();
  for (const machine of machines) {
    const region = machine.region;
    if (!wanted.includes(region)) continue;
    if (!map.has(region)) map.set(region, machine);
  }
  const missing = wanted.filter((region) => !map.has(region));
  if (missing.length) {
    throw new Error(`no Fly machines in ${missing.join(', ')}. Deploy/clone first.`);
  }
  return map;
}

function ms(v) {
  return v == null ? '—' : `${Number(v).toFixed(0)}ms`;
}

function printSummary(report) {
  const direct = report.direct.summary;
  const proxies = report.proxies.summary;
  const label = `${report.region} (${report.regionLabel})`;
  console.log(`\n== ${label} ==`);
  console.log(
    `  direct redsky  ok ${direct.ok}/${direct.count}  tcp ${ms(direct.tcpMs.p50)}  tls ${ms(direct.tlsMs.p50)}  ttfb ${ms(direct.ttfbMs.p50)}  rtt ${ms(direct.totalMs.p50)}  ip ${report.direct.samples[0]?.ip || '—'}`,
  );
  if (report.proxies.parsed) {
    console.log(
      `  proxies        ok ${proxies.ok}/${proxies.count} (${proxies.okRate}%)  connect ${ms(proxies.connectMs.p50)} p90 ${ms(proxies.connectMs.p90)}  rtt ${ms(proxies.totalMs.p50)} p90 ${ms(proxies.totalMs.p90)}`,
    );
    if (proxies.fail) {
      const errs = Object.entries(proxies.errors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, n]) => `${k}×${n}`)
        .join(', ');
      console.log(`  failures       ${errs}`);
    }
  }
}

function recommend(reports) {
  const withProxies = reports.filter((r) => r.proxies.parsed);
  const scored = (withProxies.length ? withProxies : reports).map((r) => {
    const summary = withProxies.length ? r.proxies.summary : r.direct.summary;
    return {
      region: r.region,
      label: r.regionLabel,
      p50: summary.totalMs.p50,
      connect: summary.connectMs?.p50 ?? null,
      okRate: summary.okRate,
      path: withProxies.length ? 'proxy→redsky' : 'direct redsky',
    };
  }).filter((row) => row.p50 != null);
  if (!scored.length) return 'No successful samples — cannot recommend a region.';
  scored.sort((a, b) => a.p50 - b.p50 || b.okRate - a.okRate);
  const best = scored[0];
  const rest = scored.slice(1).map((row) => `${row.region} ${ms(row.p50)}`).join(', ');
  const extra = best.connect != null ? ` (proxy CONNECT p50 ${ms(best.connect)})` : '';
  return `Best ${best.path} p50 is ${best.region} (${best.label}) at ${ms(best.p50)}${extra}. Next: ${rest || 'n/a'}.`;
}

async function postRegion({ machine, token, body, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${APP}.fly.dev/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'fly-force-instance-id': machine.id,
        'fly-prefer-region': machine.region,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${machine.region} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`${machine.region} HTTP ${res.status}: ${json.error || text.slice(0, 200)}`);
    if (json.region && json.region !== machine.region) {
      throw new Error(`wanted ${machine.region}, hit ${json.region}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (has('--help') || has('-h')) {
    usage();
    return;
  }

  const proxyFile = arg('--proxies');
  const directOnly = has('--direct-only');
  const local = has('--local');
  if (!proxyFile && !directOnly) {
    usage();
    process.exit(2);
  }

  const proxies = directOnly ? [] : await loadProxies(proxyFile);
  const rounds = Number(arg('--rounds', '1'));
  const concurrency = Number(arg('--concurrency', '12'));
  const timeoutMs = Number(arg('--timeout-ms', '8000'));
  const regions = String(arg('--regions', DEFAULT_REGIONS.join(',')))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = { proxies, rounds, concurrency, timeoutMs, directCount: 5 };

  let reports;
  if (local) {
    console.log(`running locally against redsky (${proxies.length} proxies)`);
    reports = [await runSuite(payload)];
  } else {
    const token = await loadToken();
    if (!token) throw new Error('missing PROBE_TOKEN (env, --token, or probe/.token)');
    const machines = machinesByRegion(regions);
    console.log(`running on ${APP}: ${[...machines.keys()].join(', ')}  proxies=${proxies.length}`);
    const waitMs = Math.max(120_000, proxies.length * rounds * timeoutMs / Math.max(1, concurrency) + 45_000);
    reports = await Promise.all(
      [...machines.entries()].map(([region, machine]) => {
        console.log(`  → ${region} (${REGION_LABELS[region] || region}) ${machine.id}`);
        return postRegion({ machine, token, body: payload, timeoutMs: waitMs });
      }),
    );
  }

  reports.sort((a, b) => regions.indexOf(a.region) - regions.indexOf(b.region));
  for (const report of reports) printSummary(report);

  console.log(`\n${recommend(reports)}`);

  const outDir = path.join(here, 'results');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${stamp}.json`);
  await writeFile(outFile, `${JSON.stringify({ reports }, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
