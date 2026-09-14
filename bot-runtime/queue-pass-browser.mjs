#!/usr/bin/env node
// Headed Chromium for a Queue-it pass. Same sticky proxy + cookies as the Go farm task.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const argOf = (name, dflt = '') => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

function parseProxy(raw) {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`,
      username: decodeURIComponent(u.username || '') || undefined,
      password: decodeURIComponent(u.password || '') || undefined,
    };
  } catch {
    return undefined;
  }
}

function cookiesFromHeader(header, origin) {
  const host = (() => {
    try { return new URL(origin).hostname; } catch { return ''; }
  })();
  if (!host) return [];
  return String(header || '').split(';').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    return {
      name: part.slice(0, eq).trim(),
      value: part.slice(eq + 1).trim(),
      url: origin,
    };
  }).filter((c) => c && c.name && c.value);
}

function cookiesFromPayload(raw, origin) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((c) => c && c.name && c.value).map((c) => ({
          name: String(c.name),
          value: String(c.value),
          url: String(c.url || origin || ''),
        })).filter((c) => c.url);
      }
    } catch {}
  }
  return cookiesFromHeader(text, origin);
}

const url = argOf('url');
const origin = argOf('origin') || (url ? new URL(url).origin : '');
const proxy = parseProxy(process.env.QUEUE_PASS_PROXY || argOf('proxy'));
let cookiePayload = argOf('cookies');
const cookieFile = argOf('cookie-file');
if (cookieFile) cookiePayload = readFileSync(cookieFile, 'utf8');
if (!url) {
  console.error('usage: queue-pass-browser.mjs --url=... [--origin=...] [--cookie-file=path]');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: false,
  channel: 'chromium',
  proxy,
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
});
const context = await browser.newContext({
  locale: 'en-US',
  proxy,
  viewport: null,
});
const cookies = cookiesFromPayload(cookiePayload, origin || url);
if (cookies.length) await context.addCookies(cookies);
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('queue-pass browser opened');
browser.on('disconnected', () => process.exit(0));
