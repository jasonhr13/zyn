# External Chrome harvester compatibility

Zyn supports the legacy Target harvester as an **external Chrome extension**. Zyn does not load the
extension into Electron and does not package or redistribute the downloaded extension files.

## Enable it

1. Use a dedicated Chrome profile and load the downloaded directory as an unpacked extension.
2. On `chrome://extensions`, copy the 32-character ID shown beneath the extension.
3. In Zyn Settings, open **Target — Chrome Extension Harvester**, turn **Chrome extension
   harvesting** on, paste that **Chrome extension ID**, and save.
4. Open a Target product page in the dedicated profile and click the extension toolbar button.

Turning on the extension is additive: Zyn's in-app harvesters remain available, and both sources can
run at the same time and feed the shared Target cookie bank.

With an ATC deficit, the bank banner shows whether Zyn is waiting to hear from Chrome, recently
reached the extension, or recently accepted an extension ATC cookie. Extension activity stays
separate from the in-app harvester and worker totals.

When extension harvesting is enabled and the Zyn account is active, Zyn accepts the extension's loopback
protocol at `127.0.0.1:4312`. The compatibility bridge forwards accepted captures into the shared
Target cookie bank at `127.0.0.1:4727`.

## Protocol translation

| Extension request | Zyn operation |
| --- | --- |
| WebSocket `/ws` `{ "action": "status" }` | Reads broker pools, targets, and waiters |
| WebSocket `/ws` `{ "action": "save", ... }` | Filters and posts one capture to `/saveCookies` |
| HTTP `GET /proxies` | Returns an empty group set; credentials are never exported |

Only the UA/client-hint fields and `x-gyjwza5z-*` fields used by Zyn's engine cross the bridge.
`Cookie`, `Authorization`, and unrelated captured headers are discarded. The requested expiry is
clamped to Zyn's configured cookie TTL. The server binds loopback only, pins the configured Chrome
extension ID, and adds Zyn's per-launch broker token without exposing that token to Chrome.

The extension-ID check separates ordinary browser extensions; it is not cryptographic client
authentication against other software running as the same local user, because a raw local client
can forge an HTTP/WebSocket `Origin` header. A clean extension using a pairing proof or Chrome Native
Messaging is the long-term identity boundary. If Chrome assigns a new ID after the unpacked folder
moves, update the saved ID in Zyn.

## Safety limitations

The downloaded extension is obfuscated and has broad `debugger`, proxy, browsing-data, scripting,
tabs, and all-sites permissions. It clears Target storage, stores pasted proxy credentials in its
own local storage, and changes the regular Chrome profile's proxy settings. Its Stop action does not
detach the debugger or disable request interception, so close the harvested tab (or the dedicated
Chrome profile) before using Target normally. Do not load it in a primary browsing profile.

Zyn deliberately does not implement proxy import because the legacy protocol has no pairing secret.
Paste only user-owned proxy lines directly into the dedicated extension profile; Zyn-managed proxy
credentials remain main-process-only.

This compatibility mode is best treated as ATC-focused. The legacy client understands Zyn's ATC
deficit, but its login loop does not read a login deficit and can continue working after Zyn has
enough login captures. Stop it manually when the login bank is full.
