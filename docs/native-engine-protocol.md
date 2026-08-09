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
- The engine authenticates with the per-launch `x-hope-token` header.
- Target and Pokemon Center US share this process, connection, profile map, and proxy map.
- Electron owns task-to-site routing and all user-facing windows.
- The Go process never receives the Zyn license bearer token or the Hyper API key.

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
| `product-titles` | `titles`, `missing` | Target monitor only in version 1 |
| `request-code` | `email`, `requestId`, `taskID?` | OTP handler |
| `account-cookie` | `accountId`, `cookie`, `site?` | Account store |
| `solve-captcha` | fields below | Manual captcha manager |
| `hyper-request` | correlation and request fields below | Licensed Hyper broker |

`site` is optional on legacy Target events because the registry is authoritative. New site-aware
engine events should include it.

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

Pokemon Center US uses profiles and guest checkout; it does not require an account ID. The initial
release retains the recovered Polar Railway queue-status calls.

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
the optional field.

## Hyper broker contract

These message types are reserved by version 1 so the later broker implementation does not invent a
second transport.

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

## Lifecycle invariants

- Starting a second site reuses the live engine and re-sends the accumulated shared configuration.
- A per-task stop does not kill the engine while sibling tasks remain.
- Engine exit retires every task and pending correlated request owned by that process.
- Task removal clears its site registration only after its final event has been routed.
- Site-specific adapters own UI mapping and reporting; the shared transport owns sockets, process
  lifetime, correlation, task registration, and secret boundaries.
- Target's version 1 payloads and renderer events remain valid throughout the Pokemon Center work.
