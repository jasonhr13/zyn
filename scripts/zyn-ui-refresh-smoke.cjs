#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../bot-runtime/node_modules/playwright');
const { createPreviewServer } = require('./preview-zyn-ui.cjs');
const root = path.resolve(__dirname, '..');
const screenshots = path.join(root, '.local/ui-refresh');
const bundled = path.join(root, `vendor/ms-playwright-mac-${process.arch}/chromium-1228/chrome-mac-${process.arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);

async function main() {
  fs.mkdirSync(screenshots, { recursive: true });
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(bundled) ? { executablePath: bundled } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/#/profiles`);
    await page.waitForSelector('.sidebar');
    // Hold analytics until explicitly released so navigation's first paint is tested,
    // including returning to the dashboard after its component has unmounted.
    for (let visit = 0; visit < 2; visit += 1) {
      await page.evaluate(() => {
        const ipc = window.require('electron').ipcRenderer;
        const invoke = ipc.invoke.bind(ipc);
        const pending = [];
        ipc.invoke = (channel, ...args) => ['analyticsDashboard', 'analyticsCheckouts'].includes(channel)
          ? new Promise((resolve, reject) => pending.push(() => invoke(channel, ...args).then(resolve, reject)))
          : invoke(channel, ...args);
        window.releasePreviewAnalytics = () => {
          ipc.invoke = invoke;
          pending.forEach(release => release());
          delete window.releasePreviewAnalytics;
        };
      });
      await page.locator('.sidebar-link[href="#/dashboard"]').click();
      await page.waitForSelector('.analytics-chart-canvas[aria-busy="true"]');
      assert.equal(await page.locator('.analytics-chart-empty .ui-icon').count(), 0, 'Loading must not flash an empty-state icon');
      assert.equal(await page.locator('.analytics-chart-empty [role="status"]').innerText(), 'Loading activity…');
      const loadingHeight = (await page.locator('.analytics-chart-canvas').boundingBox()).height;
      if (visit === 0) await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'dashboard-loading.png') });
      await page.evaluate(() => window.releasePreviewAnalytics());
      await page.waitForSelector('.analytics-chart-point');
      assert.equal(await page.locator('.analytics-chart-empty').count(), 0);
      assert.equal((await page.locator('.analytics-chart-canvas').boundingBox()).height, loadingHeight, 'Loading must preserve the chart layout');
      if (visit === 0) await page.locator('.sidebar-link[href="#/profiles"]').click();
    }
    await page.waitForSelector('.analytics-card');
    assert.equal(await page.locator('.analytics-card').count(), 4);
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'dashboard-dark.png') });

    // Search, pagination, metric/range controls, and CSV stay connected to data.
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.analytics-checkouts footer').textContent.includes('13–18'));
    assert.equal(await page.locator('.analytics-checkout-row').count(), 6);
    await page.getByRole('textbox', { name: 'Search checkouts' }).fill('no-such-order');
    await page.waitForSelector('.analytics-list-empty');
    assert.match(await page.locator('.analytics-list-empty').innerText(), /No matching checkouts/);
    await page.getByRole('textbox', { name: 'Search checkouts' }).fill('');
    await page.waitForSelector('.analytics-checkout-row');
    await page.locator('.analytics-tabs').getByRole('button', { name: 'Total Spent', exact: true }).click();
    assert.match(await page.locator('.analytics-chart-canvas svg').getAttribute('aria-label'), /spent/);
    await page.locator('.analytics-ranges').getByRole('button', { name: 'Last 30 Days', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.analytics-chart-point').length < 14);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    assert.match((await download).suggestedFilename(), /^zyn-checkouts-.*\.csv$/);

    // Sidebar links remain directly accessible by keyboard.
    await page.locator('.sidebar-link[href="#/profiles"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/#/profiles');

    for (const route of ['task-groups', 'profiles', 'accounts', 'proxies', 'settings', 'pokemoncenter', 'walmart']) {
      await page.locator(`.sidebar-link[href="#/${route}"]`).click();
      await page.waitForURL(`**/#/${route}`);
      await page.screenshot({ animations: 'disabled', path: path.join(screenshots, `${route}-dark.png`) });
      assert.doesNotMatch(await page.locator('.page-area').innerText(), /Something went wrong/);
    }
    await page.locator('.sidebar-link[href="#/task-groups"]').click();
    await page.getByRole('button', { name: 'New Group', exact: true }).click();
    await page.waitForSelector('.task-group-modal');
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'new-group.png') });
    await page.locator('.task-group-modal .modal-close').click();
    await page.locator('.task-group-row').first().getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForSelector('.group-task-panel');
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'task-detail.png') });
    await page.locator('.target-harvester-rail').click();
    await page.waitForSelector('.target-harvester-drawer');
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'harvesters.png') });
    await page.getByRole('button', { name: 'Close Cookie Harvesters' }).click();

    await page.locator('.sidebar-link[href="#/dashboard"]').click();
    await page.getByRole('button', { name: 'Switch to day theme' }).click();
    await page.reload();
    await page.waitForSelector('.analytics-card');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('theme-night')), false);
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'dashboard-light.png') });
    for (const size of [{ width: 1100, height: 700 }, { width: 900, height: 600 }]) {
      await page.setViewportSize(size);
      for (const route of ['dashboard', 'task-groups']) {
        await page.locator(`.sidebar-link[href="#/${route}"]`).click();
        await page.screenshot({ animations: 'disabled', path: path.join(screenshots, `${route}-${size.width}.png`) });
        const overflow = await page.locator('.page-content').evaluate(el => el.scrollWidth - el.clientWidth);
        assert.ok(overflow <= 1, `${route} overflows at ${size.width}px by ${overflow}px`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${url}/?empty=1`);
    await page.waitForSelector('.analytics-chart-empty .ui-icon');
    const emptyIcon = await page.locator('.analytics-chart-empty .ui-icon').boundingBox();
    assert.equal(emptyIcon.width, 22, 'Empty-state icons must retain their own size');
    assert.equal(emptyIcon.height, 22, 'Chart dimensions must not stretch nested icons');
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'dashboard-empty.png') });
    await page.goto(`${url}/?locked=1`);
    await page.waitForSelector('.license-gate-card');
    await page.screenshot({ animations: 'disabled', path: path.join(screenshots, 'sign-in.png') });
    assert.equal(await page.locator('.sidebar').count(), 0);
    await page.goto(`${url}/?targetOnly=1`);
    await page.waitForSelector('.sidebar');
    assert.equal(await page.locator('.sidebar-link[href="#/pokemoncenter"], .sidebar-link[href="#/walmart"]').count(), 0);
    assert.equal(await page.locator('.sidebar-link').count(), 6);
    assert.deepEqual(errors, [], 'No uncaught renderer errors');
    console.log(JSON.stringify({ ok: true, routes: 8, themes: 2, minimumWindow: '900×600', keyboardNavigation: true, gatedNavigation: true, analyticsControls: true, dashboardLoading: true, emptyIconSizing: true, screenshots }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
