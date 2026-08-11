import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  assert.match(html, /<title>Zyn — Target \+ Pokémon Center US Automation<\/title>/i);
  assert.match(html, /Target \+ Pokémon Center US support/);
  assert.match(html, /Peak checkout<br\/>performance\./);
  assert.match(html, /Native checkout engines/);
  assert.match(html, /Every beta user gets one full year free/);
  assert.match(html, /Join the free beta/);
  assert.match(html, /href="\/join"/);
  assert.doesNotMatch(html, /Request access/);
  assert.match(html, /mailto:hello@rcart\.app/);
  assert.match(html, /https:\/\/zynbot\.app\/og-retailers-beta\.png/);
});

test("renders the branded waiting-list form and confirmation", async () => {
  const form = await render("/join");
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.match(formHtml, /<title>Join the free Zyn beta<\/title>/i);
  assert.match(formHtml, /Join the free beta\./);
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
    assert.match(homeHtml, /https:\/\/zynbot\.app\/og-retailers-beta\.png/);
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
  assert.match(download, /Download Zyn/);
  assert.match(download, /zyn-icon\.png/);
  assert.match(download, /serviceOriginForHostname/);
  assert.doesNotMatch(download, /build awaiting signature/);
  assert.match(layout, /Zyn — Target \+ Pokémon Center US Automation/);
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
  await access(new URL("../public/zyn-icon.png", import.meta.url));
  await access(new URL("../public/favicon.png", import.meta.url));
  await access(new URL("../public/apple-touch-icon.png", import.meta.url));
  await access(new URL("../public/manifest.webmanifest", import.meta.url));
  await access(new URL("../public/og-retailers-beta.png", import.meta.url));
});
