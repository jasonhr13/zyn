import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function dispatch(pathname = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
      ...init,
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

async function render(pathname = "/") {
  return dispatch(pathname);
}

test("server-renders the Zyn product site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Zyn — Precision retail operations<\/title>/i);
  assert.match(html, /The checkout command center built for the drop\./);
  assert.match(html, /Less noise\./);
  assert.match(html, /Join waiting list/);
  assert.match(html, /href="\/join"/);
  assert.doesNotMatch(html, /Request access/);
  assert.match(html, /mailto:hello@rcart\.app/);
  assert.match(html, /https:\/\/rcart\.app\/og\.png/);
});

test("renders the branded waiting-list form and confirmation", async () => {
  const form = await render("/join");
  assert.equal(form.status, 200);
  const formHtml = await form.text();
  assert.match(formHtml, /<title>Join the Zyn waiting list<\/title>/i);
  assert.match(formHtml, /Join the waiting list\./);
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

test("ships the Zyn identity and Cloudflare configuration", async () => {
  const [page, download, layout, css, wrangler] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/download/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  assert.match(page, /rcart-symbol\.png/);
  assert.match(download, /Download Zyn/);
  assert.match(download, /zyn-icon\.png/);
  assert.match(download, /https:\/\/updates\.rcart\.app\/download\/mac\/arm64/);
  assert.match(download, /https:\/\/updates\.rcart\.app\/download\/mac\/x64/);
  assert.doesNotMatch(download, /build awaiting signature/);
  assert.match(layout, /Zyn — Precision retail operations/);
  assert.match(css, /--mint:/);
  assert.match(wrangler, /"name": "rcart-site"/);
  assert.match(wrangler, /vinext\/server\/app-router-entry/);
  await access(new URL("../app/download/page.tsx", import.meta.url));
  await access(new URL("../app/api/download/redeem/route.ts", import.meta.url));
  await access(new URL("../app/join/page.tsx", import.meta.url));
  await access(new URL("../app/api/waitlist/route.ts", import.meta.url));
  await access(new URL("../public/rcart-symbol.png", import.meta.url));
  await access(new URL("../public/zyn-icon.png", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
});
