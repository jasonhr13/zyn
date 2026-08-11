# External browser harvester compatibility

Zyn supports the legacy Target harvester as an **external Chromium extension**. Zyn publishes the
extension separately as a ZIP; it is not bundled with, loaded into, or executed by the Electron app.

## Install or update it

1. Download the current ZIP from
   [updates.zynbot.app/download/extension](https://updates.zynbot.app/download/extension).
2. In a dedicated Chrome or Brave profile, extract it to a durable `Zyn-Harvester` directory and load
   that directory as an unpacked extension on the browser's extensions page.
3. Copy the 32-character ID shown beneath the extension in each browser profile you use.
4. In Zyn Settings, open **Target — Browser Extension Harvesters**, turn extension harvesting on,
   paste one extension ID per line, and save.
5. Open a Target product page in the dedicated profile and click the extension toolbar button.

For an update, download the ZIP again, replace the contents of the same unpacked
`Zyn-Harvester` directory, then click **Reload** for the extension. Keep the same absolute directory
path: moving or renaming an unpacked extension can change its Chromium ID, which would also require
updating the saved entry in Zyn. The stable link always resolves to the latest release;
release-specific links use `/download/extension/<version>`. Reload every installed profile after
updating from an older build so it begins sending the current installation identity.

Turning on the extension is additive: Zyn's in-app harvesters remain available, and both sources can
run at the same time and feed the shared Target cookie bank.

With an ATC deficit, the bank banner shows whether Zyn is waiting to hear from the browser extension,
recently reached it, or recently accepted an extension ATC cookie. Browser-extension activity stays
separate from the in-app harvester and worker totals.

When extension harvesting is enabled and the Zyn account is active, Zyn accepts the extension's loopback
protocol at `127.0.0.1:4312`. The compatibility bridge forwards accepted captures into the shared
Target cookie bank at `127.0.0.1:4727`.

## Protocol translation

| Extension request | Zyn operation |
| --- | --- |
| WebSocket `/ws` `{ "action": "status", "clientId", "browser" }` | Reads broker pools, targets, and waiters |
| WebSocket `/ws` `{ "action": "save", "clientId", "browser", ... }` | Filters and posts one capture to `/saveCookies` |
| HTTP `GET /proxies` | Returns an empty group set; credentials are never exported |

Only the UA/client-hint fields and `x-gyjwza5z-*` fields used by Zyn's engine cross the bridge.
`Cookie`, `Authorization`, and unrelated captured headers are discarded. The requested expiry is
clamped to Zyn's configured cookie TTL. The server binds loopback only, pins the configured extension
ID, and adds Zyn's per-launch broker token without exposing that token to the browser. The optional
`clientId` and `browser` fields are backward-compatible and may be ignored by older Zyn builds.

The extension-ID check separates ordinary browser extensions; it is not cryptographic client
authentication against other software running as the same local user, because a raw local client
can forge an HTTP/WebSocket `Origin` header. A clean extension using a pairing proof or native
messaging is the long-term identity boundary. If Chromium assigns a new ID after the unpacked folder
moves, update its entry in Zyn.

## Safety limitations

The downloaded extension is obfuscated and has broad `debugger`, proxy, browsing-data, scripting,
tabs, and all-sites permissions. It clears Target storage, stores pasted proxy credentials in its
own local storage, and changes the browser profile's proxy settings. Its Stop action does not
detach the debugger or disable request interception, so close the harvested tab (or the dedicated
browser profile) before using Target normally. Do not load it in a primary browsing profile.

Zyn deliberately does not implement proxy import because the legacy protocol has no pairing secret.
Paste only user-owned proxy lines directly into the dedicated extension profile; Zyn-managed proxy
credentials remain main-process-only.

This compatibility mode is best treated as ATC-focused. The legacy client understands Zyn's ATC
deficit, but its login loop does not read a login deficit and can continue working after Zyn has
enough login captures. Stop it manually when the login bank is full.
