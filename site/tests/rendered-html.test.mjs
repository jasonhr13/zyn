import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function dispatch(pathname = "/", init = {}, origin = "http://localhost") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const requestUrl = new URL(pathname, origin);
  const requestHeaders = new Headers(init.headers);
  if (!requestHeaders.has("accept")) requestHeaders.set("accept", "text/html");
  if (!requestHeaders.has("x-forwarded-host")) requestHeaders.set("x-forwarded-host", requestUrl.host);
  if (!requestHeaders.has("x-forwarded-proto")) requestHeaders.set("x-forwarded-proto", requestUrl.protocol.slice(0, -1));

  return worker.fetch(
    new Request(requestUrl, {
      ...init,
      headers: requestHeaders,
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render(pathname = "/", init = {}, origin = "http://localhost") {
  return dispatch(pathname, init, origin);
}

test("server-renders the Zyn product site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ZynAIO — Target, Pokémon Center, and Walmart<\/title>/i);
  assert.match(html, /ZynAIO/);
  assert.match(html, /Retail automation for Target, Pokémon Center, and Walmart\./);
  assert.match(html, /Top-tier checkout on the three sites that matter/);
  assert.match(html, /What’s in the app\./);
  assert.match(html, /Task Groups/);
  assert.match(html, /Scheduled Tasks/);
  assert.match(html, /2FA Handling/);
  assert.match(html, /Cookie Harvest/);
  assert.match(html, /Proxy Support/);
  assert.match(html, /Local &amp; Secure|Local & Secure/);
  assert.match(html, /Discord webhooks/);
  assert.match(html, /Target/);
  assert.match(html, /Pokémon Center US/);
  assert.match(html, /Walmart/);
  assert.match(html, /href="\/join"/);
  assert.match(html, /\$100 for two months/);
  assert.match(html, /\$40 every month/);
  assert.doesNotMatch(html, /screenshots\/zyn-/);
  assert.doesNotMatch(html, /\bWine\b/i);
  assert.doesNotMatch(html, /\bcompiled\b/i);
  assert.doesNotMatch(html, /native engine/i);
  assert.doesNotMatch(html, /Free during beta/);
  assert.doesNotMatch(html, /not an all-in-one/i);
  assert.doesNotMatch(html, /Refract|Stellar|HiddenAIO|NSB/i);
  assert.doesNotMatch(html, /same license/i);
  assert.doesNotMatch(html, /not charged extra per computer/i);
  assert.doesNotMatch(html, /table dying/i);
  assert.match(html, /Buy Zyn/);
  assert.match(html, /href="\/buy"/);
  assert.doesNotMatch(html, /Request access/);
  assert.match(html, /mailto:hello@zynbot\.app/);
  assert.match(html, /https:\/\/zynbot\.app\/og-aio\.png/);
});

test("renders the Stripe purchase form", async () => {
  const response = await render("/buy");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Buy Zyn<\/title>/i);
  assert.match(html, /\$100 for two months/);
  assert.match(html, /\$40 every month/);
  assert.match(html, /Pokémon Center US/);
  assert.doesNotMatch(html, /same license/i);
  assert.match(html, /action="\/api\/checkout"/);
  assert.match(html, /name="email"/);
});

test("starts Stripe checkout through the license service without exposing the secret", async () => {
  const nativeFetch = globalThis.fetch;
  let licenseRequest;
  globalThis.fetch = async (input, init) => {
    licenseRequest = { input: String(input), init };
    return Response.json({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  };
  try {
    const response = await dispatch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: " Buyer@Example.com " }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(licenseRequest.input, "https://license.rcart.app/api/billing/checkout");
    assert.deepEqual(JSON.parse(licenseRequest.init.body), { email: "buyer@example.com" });
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("renders the branded waiting-list form and confirmation", async () => {
  const form = await render("/join");
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.match(formHtml, /<title>Join the Zyn waiting list<\/title>/i);
  assert.match(formHtml, /Join the waiting list\./);
  assert.match(formHtml, /ZynAIO/);
  assert.match(formHtml, /Leave your email for an invite/);
  assert.match(formHtml, /href="\/buy"/);
  assert.match(formHtml, /action="\/api\/waitlist"/);
  assert.match(formHtml, /name="email"/);

  const confirmation = await render("/join?joined=1");
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /You’re on the list\./);
});

test("submits waiting-list email server-side without exposing the license API", async () => {
  const nativeFetch = globalThis.fetch;
  let licenseRequest;
  globalThis.fetch = async (input, init) => {
    licenseRequest = { input: String(input), init };
    return Response.json({ ok: true }, { status: 202 });
  };
  try {
    const response = await dispatch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: " Person@Example.com " }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "http://localhost/join?joined=1");
    assert.equal(licenseRequest.input, "https://license.rcart.app/api/waitlist");
    assert.deepEqual(JSON.parse(licenseRequest.init.body), { email: "person@example.com" });

    licenseRequest = undefined;
    const trapped = await dispatch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "bot@example.com", company: "Bots Inc" }),
    });
    assert.equal(trapped.status, 303);
    assert.equal(trapped.headers.get("location"), "http://localhost/join?joined=1");
    assert.equal(licenseRequest, undefined);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("keeps downloads locked until a one-time key is explicitly unlocked", async () => {
  const locked = await render("/download");
  assert.equal(locked.status, 200);
  const lockedHtml = await locked.text();
  assert.match(lockedHtml, /A private link is required\./);
  assert.doesNotMatch(lockedHtml, /Download for macOS/);

  const invited = await render(`/download?key=${"a".repeat(43)}`);
  assert.equal(invited.status, 200);
  const invitedHtml = await invited.text();
  assert.match(invitedHtml, /Your private download is ready\./);
  assert.match(invitedHtml, /action="\/api\/download\/redeem"/);
  assert.doesNotMatch(invitedHtml, /Download for Windows/);
});

test("redeems the key server-side and stores only an HttpOnly download session", async () => {
  const nativeFetch = globalThis.fetch;
  let licenseRequest;
  globalThis.fetch = async (input, init) => {
    licenseRequest = { input: String(input), init };
    return Response.json({ ok: true, sessionToken: "s".repeat(43), expiresAt: Date.now() + 86400000 });
  };
  try {
    const response = await dispatch("/api/download/redeem", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: "k".repeat(43) }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "http://localhost/download");
    assert.match(response.headers.get("set-cookie") ?? "", /^rcart_download=s{43};/);
    assert.match(response.headers.get("set-cookie") ?? "", /Path=\/download/);
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(response.headers.get("set-cookie") ?? "", /Secure/);
    assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Lax/);
    assert.equal(licenseRequest.input, "https://license.rcart.app/api/download/redeem");
    assert.deepEqual(JSON.parse(licenseRequest.init.body), { key: "k".repeat(43) });
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("publishes the Zyn canonical identity and keeps service traffic in the visitor's domain family", async () => {
  const nativeFetch = globalThis.fetch;
  let licenseRequest;
  globalThis.fetch = async (input, init) => {
    licenseRequest = { input: String(input), init };
    if (licenseRequest.input.endsWith("/api/download/session")) {
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true }, { status: 202 });
  };

  try {
    const home = await render("/", {}, "https://zynbot.app");
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /https:\/\/zynbot\.app\/og-aio\.png/);
    assert.match(homeHtml, /href="https:\/\/zynbot\.app\/favicon\.png"/);
    assert.match(homeHtml, /href="https:\/\/zynbot\.app\/manifest\.webmanifest"/);

    const waitlist = await dispatch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "zyn@example.com" }),
    }, "https://zynbot.app");
    assert.equal(waitlist.status, 303);
    assert.equal(waitlist.headers.get("location"), "https://zynbot.app/join?joined=1");
    assert.equal(licenseRequest.input, "https://license.zynbot.app/api/waitlist");

    const download = await render("/download", {
      headers: { accept: "text/html", cookie: `rcart_download=${"s".repeat(43)}` },
    }, "https://zynbot.app");
    assert.equal(download.status, 200);
    const downloadHtml = await download.text();
    assert.equal(licenseRequest.input, "https://license.zynbot.app/api/download/session");
    assert.match(downloadHtml, /https:\/\/updates\.zynbot\.app\/download\/mac\/arm64/);
    assert.match(downloadHtml, /https:\/\/updates\.zynbot\.app\/download\/mac\/x64/);
    assert.match(downloadHtml, /https:\/\/updates\.zynbot\.app\/download\/windows/);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("ships the Zyn identity and both Cloudflare custom domains", async () => {
  const [page, download, layout, css, domain, wrangler] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/download/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/domain.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  assert.match(page, /zyn-icon\.png/);
  assert.doesNotMatch(page, /rcart-symbol\.png/);
  await assert.rejects(access(new URL("../public/rcart-symbol.png", import.meta.url)));
  assert.match(download, /Download Zyn/);
  assert.match(download, /zyn-icon\.png/);
  assert.match(download, /serviceOriginForHostname/);
  assert.doesNotMatch(download, /build awaiting signature/);
  assert.match(layout, /ZynAIO — Target, Pokémon Center, and Walmart/);
  assert.match(layout, /manifest\.webmanifest/);
  assert.match(css, /--zyn-orange:/);
  assert.match(css, /--zyn-rose:/);
  assert.match(css, /#e11d48/i);
  assert.doesNotMatch(css, /99,\s*242,\s*206/);
  assert.match(domain, /zynbot\.app/);
  assert.match(domain, /rcart\.app/);
  assert.match(wrangler, /"name": "rcart-site"/);
  assert.match(wrangler, /vinext\/server\/app-router-entry/);
  assert.match(wrangler, /"pattern": "rcart\.app"/);
  assert.match(wrangler, /"pattern": "zynbot\.app"/);
  await access(new URL("../app/download/page.tsx", import.meta.url));
  await access(new URL("../app/api/download/redeem/route.ts", import.meta.url));
  await access(new URL("../app/join/page.tsx", import.meta.url));
  await access(new URL("../app/api/waitlist/route.ts", import.meta.url));
  await access(new URL("../app/buy/page.tsx", import.meta.url));
  await access(new URL("../app/api/checkout/route.ts", import.meta.url));
  await access(new URL("../public/zyn-icon.png", import.meta.url));
  await access(new URL("../public/favicon.png", import.meta.url));
  await access(new URL("../public/apple-touch-icon.png", import.meta.url));
  await access(new URL("../public/manifest.webmanifest", import.meta.url));
  await access(new URL("../public/og-aio.png", import.meta.url));
  await access(new URL("../public/screenshots/zyn-target.png", import.meta.url));
});

test("ships only the reviewed Zyn raster brand assets", async () => {
  const reviewed = {
    "apple-touch-icon.png": "784039266ddfcdcf1e0ac5e06499038ad05aa6e0257e827e43e27633574abc00",
    "favicon.png": "268f21db55c7951a55895d4baa6f7318077983510bc56553b59d78b379b75438",
    "og-aio.png": "0e072ad1952320bf95dd77b536f2817ff7746e1f11242428600028c66d5945c8",
    "og-retailers-beta.png": "cbc518f8b028fe99aa3a1be2870289c1cda3897ad0e497057cfbb45db27ce171",
    "og-target-beta.png": "d5bfe6f405ab2f495996f9b6ef0aa4587c6a97d5ac07ee09bec8962aac3c4ddd",
    "og.png": "1e06a3c6b28fd1bb1346a59bf418ae4e6a6b4f51c8940593f6cfb95702765cc0",
    "zyn-icon.png": "863313a6dfc5191f8efb6f1eb5b215238c810b38eac2c070613ac134a2bb5e81",
  };
  const publicDirectory = new URL("../public/", import.meta.url);
  const rasterAssets = (await readdir(publicDirectory))
    .filter((file) => /\.(?:png|jpe?g|gif|webp)$/i.test(file))
    .sort();
  assert.deepEqual(rasterAssets, Object.keys(reviewed).sort());
  for (const [file, expected] of Object.entries(reviewed)) {
    const body = await readFile(new URL(file, publicDirectory));
    assert.equal(createHash("sha256").update(body).digest("hex"), expected, `${file} was not reviewed`);
  }
});
