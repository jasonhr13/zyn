# Target drop follow-ups (2026-09-11)

Learnings from a live Target drop with 66 checkout tasks, 2 remote Zyn harvesters, and about a dozen remote browser extensions. Full Engine froze (Not Responding). Later, tasks sat on Shape Soft Block. Pulse chips still showed the previous wave after the monitor went OOS.

Do not treat this as a zyn-web change. Engine runtime pin is 1.2.9 with this ship.

## 1. Remote harvest must not push fat cookies into Full Engine

**Status:** implemented. License worker + extension 1.1.10 + Full Engine pull. Not live until the license worker is deployed and the extension is published.

Remote captures go to a Cloudflare harvest-room mailbox (`POST /api/harvester/capture`). Full Engine pulls ATC batches (`POST /api/harvester/take`, up to 64 when tasks are waiting) only when the local bank has remaining room or a waiter. Login cookies never enter the mailbox. WS is control-plane only (demand, proxies, ping, mailbox counts). Capture bodies, logs, and status are not forwarded to desktop. Mailbox cap is 1000 ATC. Extensions park when mailbox remaining is 0. Local extensions on the Full Engine machine stay on `127.0.0.1:4312`.

Companion WS captures are stored in the same mailbox instead of being pushed into Electron.

Checkout still only sees the local farmer bank. GetShape does not change.

## 2. Shape Soft Block — dump cookie+IP, keep ATCing

**Status:** done in engine source. Ships as checkout engine 1.2.9.

A Shape 401 means that cookie and its harvest sticky IP are dead. Cart used to retry the same cookie twice with `ErrorDelay` (~3s), then on the third block sleep **60s**, show Shape Soft Block, and `bailToRestockKeepSignal()`. If the SKU was still in stock, restock wait matched the same ping and the loop repeated.

**Plan**

- Any `Shape Block (Login)` or `Shape Block (Cart)`: discard headers/proxy, `get-shape`, retry the same step. New cookie already brings a new sticky IP (`SetProxy(t.ShapeProxy)`).
- No 60s park. No cart bail to restock on Soft Block. No `ErrorDelay` sleep to retry the dead cookie.
- Keep `shape_block_login` / `shape_block_cart` telemetry. Keep `shape_soft_block` when the consecutive count reaches 3 so analytics still show pressure.
- Status may flash `Shape Soft Block` then go to `Waiting For Shape`.
- Do not change Precart (alternate cart flow) or DCO handling.

This spends ATC cookies faster, which is why (1) has to land before the next high-volume remote drop.

## 3. Pulse chips are per wave, except successes

**Status:** done in the renderer.

- Adding to cart — live statuses. Unchanged.
- Carted / submitting — this wave. Zero after the shared monitor stays Out of Stock for 1.5s with nobody carting or submitting.
- Failed — this wave, same reset.
- Successful checkouts — this run. Never wiped on OOS.
- One OOS poll does not wipe. Mid-submit tasks delay the reset until they leave submitting. Row checkout/fail counts stay run totals.

## Order

1. Shape Soft Block — done in engine source.
2. Wave pulse — done in the renderer.
3. Remote mailbox + pull — implemented; deploy license worker and publish extension 1.1.10 to ship.
