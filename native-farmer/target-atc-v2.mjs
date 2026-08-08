import fs from 'node:fs';

export const TARGET_ATC_V2_DEFAULT_TCIN = '90188801';
export const TARGET_ATC_V2_SOURCE = 'inBotV2';
export const TARGET_ATC_V2_PDP_PATTERN = /^https:\/\/(?:www\.)?target\.com\/p\//i;
export const TARGET_ATC_V2_SSX_SELECTOR = 'html[data-ssx-ready="true"]';
export const TARGET_ATC_V2_SHIPPING_SELECTOR = '[data-test="fulfillment-cell-shipping"]';
export const TARGET_ATC_V2_ATC_SELECTOR = '[id^=addToCartButtonOrTextIdFor]:not([data-test=showInStockPrimaryButton])';

const TARGET_ATC_V2_TEMPLATE = fs.readFileSync(
  new URL('./target-atc-v2.html', import.meta.url),
  'utf8',
);

export function extractTargetAtcV2Tcin(productLink) {
  return String(productLink || '').match(/\/A-(\d+)/)?.[1] || TARGET_ATC_V2_DEFAULT_TCIN;
}

export function generateTargetAtcV2Html(productLink) {
  const tcin = extractTargetAtcV2Tcin(productLink);
  return TARGET_ATC_V2_TEMPLATE.split(TARGET_ATC_V2_DEFAULT_TCIN).join(tcin);
}

async function continueRoute(route) {
  try { await route.continue(); } catch {}
}

// Playwright's route is the equivalent of Polar's CDP setPdpHijack hook: the address bar and
// origin remain the configured Target product URL, while only the top-level PDP response is
// replaced by the recovered synthetic document. Target's ssx.mod.js is still fetched normally.
export async function setTargetAtcV2PdpHijack(page, productLink) {
  const html = generateTargetAtcV2Html(productLink);
  const handler = async (route) => {
    const request = route.request();
    const isDocument = request.resourceType() === 'document';
    const isNavigation = typeof request.isNavigationRequest !== 'function' || request.isNavigationRequest();
    if (request.method() !== 'GET' || !isDocument || !isNavigation) {
      await continueRoute(route);
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: {
        'cache-control': 'no-store',
        'x-frame-options': 'SAMEORIGIN',
      },
      body: html,
    });
  };

  await page.route(TARGET_ATC_V2_PDP_PATTERN, handler);
  let active = true;
  return {
    html,
    tcin: extractTargetAtcV2Tcin(productLink),
    async clear() {
      if (!active) return;
      active = false;
      try { await page.unroute(TARGET_ATC_V2_PDP_PATTERN, handler); } catch {}
    },
  };
}

async function clickWithMouse(page, human, selector, timeout) {
  if (human && typeof human.click === 'function') {
    try {
      if (await human.click(selector, { timeout })) return;
    } catch {}
  }
  await page.click(selector, { timeout });
}

function waitForResult(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// Executes the recovered V2 interaction order. waitForHeaders() is deliberately called after
// shipping is selected and before the ATC click, matching the original harvester state machine.
export async function runTargetAtcV2Flow({
  page,
  human,
  productLink,
  waitForHeaders,
  navigationTimeoutMs = 2500,
  ssxTimeoutMs = 30000,
  controlTimeoutMs = 10000,
  headersTimeoutMs = 20000,
}) {
  if (!page || typeof waitForHeaders !== 'function') {
    throw new TypeError('Target ATC+ requires a page and waitForHeaders callback');
  }

  const hijack = await setTargetAtcV2PdpHijack(page, productLink);
  try {
    await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    await page.waitForSelector(TARGET_ATC_V2_SSX_SELECTOR, { timeout: ssxTimeoutMs });
    await page.waitForSelector(TARGET_ATC_V2_SHIPPING_SELECTOR, { timeout: controlTimeoutMs });
    await clickWithMouse(page, human, TARGET_ATC_V2_SHIPPING_SELECTOR, controlTimeoutMs);
    await page.waitForSelector(TARGET_ATC_V2_ATC_SELECTOR, { timeout: controlTimeoutMs });

    const headersPromise = waitForHeaders();
    await clickWithMouse(page, human, TARGET_ATC_V2_ATC_SELECTOR, controlTimeoutMs);
    const headers = await waitForResult(headersPromise, headersTimeoutMs);
    if (!headers) throw new Error('Target ATC+ received no cart headers after Add to Cart');
    return { headers, source: TARGET_ATC_V2_SOURCE, tcin: hijack.tcin };
  } finally {
    await hijack.clear();
  }
}
