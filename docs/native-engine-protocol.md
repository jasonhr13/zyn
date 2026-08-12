# Zyn native-engine protocol

This document defines protocol version 1 for the single native Go engine used by Zyn. The engine
source of truth is `/Users/jason/code/polar-backend-source`; the architecture-specific binaries are
packaged by `/Users/jason/code/hope2`.

Version 1 preserves the recovered backend's existing wire format. Compatibility is additive: new
sites and message types may be introduced, but the envelope and existing Target fields must not be
renamed.

## Transport and ownership

- Electron hosts one WebSocket server on `127.0.0.1`; one Go process connects as its client.
- Electron passes the selected loopback port to the Go process.
- The engine authenticates with the per-launch `x-zyn-token` header.
- Target and Pokemon Center US share this process, connection, profile map, and proxy map.
- Electron owns task-to-site routing and all user-facing windows.
- The Go process never receives the Zyn license bearer token or the Hyper API key.

Target also has a separate HTTP cookie broker on `127.0.0.1:4727`. When Zyn launches it with
`ZYN_SHAPE_TOKEN`, `/cookie`, `/saveCookies`, `/demand`, `/session-ready`, and producer-status writes
require that per-launch value in `x-zyn-token`; only aggregate `/status` remains readable without it.
The external Chrome compatibility listener on port 4312 filters a capture, then asks the Target
engine to perform the authenticated save after verifying that Zyn's tracked child still owns 4727.
The raw token is not exported to Chrome or the launcher. A standalone broker launched without
`ZYN_SHAPE_TOKEN` intentionally retains its local testing behavior.

Every message uses the existing envelope:

```json
{
  "type": "update-status",
  "messages": []
}
```

`messages` is always an array, including for a single request or response. Unknown message types
must be ignored for forward compatibility.

## Canonical sites and task identity

| Site key | Canonical engine value | Accepted input aliases |
| --- | --- | --- |
| `target` | `Target` | `target` |
| `pokemoncenter` | `Pokemon Center US` | `Pokemon Center`, `PokemonCenter`, `PCUS` |

Commands identify a task as `id`. Existing engine events identify it as `taskID`; captcha and the
future Hyper broker use `taskId`. These spellings are preserved on the wire. Electron normalizes
them internally and maintains a registry from task ID to canonical site.

Routing order is:

1. A recognized `site` or `siteName` on the payload.
2. The task-to-site registry populated by `start-tasks`.
3. A caller-supplied legacy fallback, only where the bridge already knows the module.

The nested notification `type` (`product`, `checkout`, or `declined`) is never interpreted as a site.
Task IDs must be unique across both modules while the engine process is alive.

## Electron to engine

| Envelope type | Required payload fields | Scope |
| --- | --- | --- |
| `send-configs` | `settings`, `profileList`, `proxyList`, `accountList` | Shared process configuration |
| `start-tasks` | `id`, `site`, `type`, `mode`, `item`, `monitorItems` | Start checkout tasks |
| `start-monitors` | `id`, `site`, `items` | Start a shared site monitor |
| `stop-tasks` | `id` | Stop tasks or monitors |
| `edit-tasks` | full start-task payload with `id` | Runtime item/config edit |
| `stock-ping` | `site`, `productKey`, `inStock` | Publish external stock |
| `set-task-proxy` | `id`, `proxyGroup` | Runtime proxy edit |
| `received-code` | `email`, `code`, `site` | Complete an OTP request |
| `code-watcher-ready` | `requestId` | Acknowledge OTP watcher setup |
| `received-token` | `taskId`, `token` | Complete a manual captcha request |
| `hyper-response` | correlation and result fields below | Complete a broker request |

The recovered Go schema uses the capitalized JSON field `QueueEntryDelay`. Builders must retain that
exact spelling. A start message carries the canonical site in both `site` and `type`.

## Engine to Electron

| Envelope type | Important payload fields | Routing |
| --- | --- | --- |
| `update-status` | `taskID`, `site?`, `status`, `color`, `state`, `running` | Task registry, with optional explicit site |
| `update-input` | `taskID`, `site?`, `productName`, `productSize` | Task registry |
| `task-log` | `taskID`, `site?`, `data` | Task registry |
| `task-notification` | `taskID`, `site?`, nested `type`, product/order fields | Task registry |
| `analytics-event` | `eventId`, `eventType`, `site`, task/run/order IDs, integer cents, nested items | Main-process analytics outbox |
| `monitor-bandwidth` | aggregate wire-byte fields below | Sanitized renderer event `targetMonitorBandwidth` |
| `product-titles` | `titles`, `missing` | Target monitor only in version 1 |
| `request-code` | `email`, `requestId`, `taskID?` | OTP handler |
| `account-cookie` | `accountId`, `cookie`, `site?` | Account store |
| `solve-captcha` | fields below | Manual captcha manager |
| `hyper-request` | correlation and request fields below | Licensed Hyper broker |

`site` is optional on legacy Target events because the registry is authoritative. New site-aware
engine events should include it.

### Local analytics outcome

The native engine emits one `analytics-event` for each cart, checkout, or decline. A multi-product
order remains one event and carries one item row per product, including its own quantity. Money is
always integer cents. `eventId` is generated once in Go and is the idempotency key used when the
main-process outbox retries an upload.

The event deliberately excludes profiles, addresses, cards, passwords, proxies, account email, and
license credentials. Electron binds it to the currently authenticated Zyn account and uploads it;
the Go process never connects to the analytics API.

### Target monitor bandwidth

The Target monitor emits cumulative TLS client wire-byte measurements using this exact payload:

```json
{
  "schemaVersion": 1,
  "measurement": "tls-client-wire",
  "monitorId": "target-monitor",
  "runId": "run-identifier",
  "site": "Target",
  "startedAt": 1786471200000,
  "observedAt": 1786471260000,
  "sequence": 1,
  "running": true,
  "downloadBytes": 6000,
  "uploadBytes": 600,
  "totalBytes": 6600,
  "proxyDownloadBytes": 5000,
  "proxyUploadBytes": 500,
  "directDownloadBytes": 1000,
  "directUploadBytes": 100,
  "polls": 20,
  "failedPolls": 2,
  "watchedItems": 3
}
```

All byte and count fields are nonnegative safe integers; timestamps are positive milliseconds since
the Unix epoch, and `sequence` is a positive safe integer starting at 1. Aggregate download, upload,
and total values must equal their component sums. Electron
rejects malformed events, discards unknown fields, and forwards only the normalized aggregate to
the renderer. URLs, headers, cookies, proxy values or credentials, product identifiers, and task or
account data are never part of this event. The measurement remains on Zyn's authenticated loopback
engine-to-Electron path and local renderer; it is not sent to checkout analytics or Cloudflare.
On a normal stop, Electron gives active monitor runs up to 1.5 seconds to send their terminal
cumulative snapshot before force-stopping the child. If that snapshot never arrives, the renderer
keeps the last periodic counters and labels them as a provisional last sample rather than a complete
measurement.

## Start-task common fields

A site adapter may add fields, but the bridge treats these as common:

```json
{
  "id": "task-id",
  "type": "Pokemon Center US",
  "site": "Pokemon Center US",
  "taskGroup": "group-id",
  "monitorDelay": "3000",
  "retryDelay": "3000",
  "proxyGroup": "Local",
  "profileId": "profile-id",
  "accountId": "",
  "item": [],
  "monitorItems": [],
  "mode": "Default",
  "loopCheckout": false,
  "waitForQueue": false,
  "QueueEntryDelay": "0",
  "startSchedule": "",
  "stopSchedule": ""
}
```

Pokemon Center US uses profiles and guest checkout; it does not require an account ID. Queue
protection is detected through two independent paths: a licensed Zyn event stream publishes
normalized `stock-ping` messages with product key `queue`, while the native engine keeps polling the
HTTPS queue-status endpoint every three seconds as a fallback. The upstream event-stream credential
and wire decoder exist only in Zyn's Cloudflare Durable Object; installed apps receive health plus
`queue`/`captcha` events and cannot read the saved credential.

## Manual captcha contract

The engine sends:

```json
{
  "type": "solve-captcha",
  "messages": [{
    "taskId": "task-id",
    "groupId": "group-id",
    "site": "Pokemon Center US",
    "siteKey": "hcaptcha-site-key",
    "siteUrl": "https://www.pokemoncenter.com/",
    "hcapData": "",
    "proxy": "http://user:pass@host:port",
    "cookies": [],
    "headers": [],
    "captchaType": "hcaptcha-PokemonCenter"
  }]
}
```

Electron returns `received-token` with the same `taskId`. One solve may be pending per task; multiple
different tasks may solve concurrently. Stopping a task, disconnecting the engine, or quitting the
app cancels and closes its solver without delivering a late token. The recovered Pokemon Center
emitter currently omits `site`; Electron resolves it from the task registry until the Go adapter adds
the optional field. Version 1 is manual-only: Electron serves a constrained hCaptcha document at the
real `https://www.pokemoncenter.com/` origin in a per-solve, sandboxed session, applies the task's
assigned HTTP proxy (including proxy authentication), and polls only for the user-completed token.
No provider API key, automatic image classifier, or autosolver is part of this path.

## Hyper broker contract

These message types carry Hyper solver requests through the existing engine transport. Electron
checks that the task is actively registered to Pokemon Center US, then asks the main-process license
authority to POST to `/api/services/hyper/:operation`. The authority supplies the in-memory Zyn
bearer and device identity; the Worker supplies the encrypted Hyper key. Neither credential crosses
the WebSocket bridge.

Engine request:

```json
{
  "type": "hyper-request",
  "messages": [{
    "requestId": "unique-correlation-id",
    "taskId": "task-id",
    "site": "Pokemon Center US",
    "operation": "reese84",
    "payload": {}
  }]
}
```

Electron response:

```json
{
  "type": "hyper-response",
  "messages": [{
    "requestId": "unique-correlation-id",
    "taskId": "task-id",
    "site": "Pokemon Center US",
    "ok": true,
    "status": 200,
    "body": "{}",
    "error": ""
  }]
}
```

Allowed operations are `reese84`, `datadome-tags`, `datadome-interstitial`, `datadome-slider`, and
`incapsula-utmvc`. Neither message may contain `hyperApiKey`, `apiKey`, or `x-api-key`.
Request IDs must be unique while in flight. Electron rejects duplicates and discards responses from
a request whose engine connection has closed. The UTMVC payload is ordinary JSON on this transport;
the Worker applies the gzip content encoding required by Hyper's upstream endpoint.

## Lifecycle invariants

- Starting a second site reuses the live engine and re-sends the accumulated shared configuration.
- A per-task stop does not kill the engine while sibling tasks remain.
- Engine exit retires every task and pending correlated request owned by that process.
- Task removal clears its site registration only after its final event has been routed.
- Site-specific adapters own UI mapping and reporting; the shared transport owns sockets, process
  lifetime, correlation, task registration, and secret boundaries.
- Target's version 1 payloads and renderer events remain valid throughout the Pokemon Center work.
