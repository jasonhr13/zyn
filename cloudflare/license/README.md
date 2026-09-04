# Zyn license service

The production service is deployed on both domain families during the Zyn migration:

- Admin: <https://license.rcart.app/admin/> and <https://license.zynbot.app/admin/>
- API/health: <https://license.rcart.app/health> and <https://license.zynbot.app/health>
- Website: <https://rcart.app> and <https://zynbot.app>
- Updates: <https://updates.rcart.app> and <https://updates.zynbot.app>
- D1 database: `hope-license` (`a6aa8a05-ca0c-4d7d-beca-ba1ba0f906f8`)

## Admin access

The admin password is generated locally, stored in macOS Keychain under the service
`com.thwebco.hope.license-api`, and uploaded as a Worker secret. Retrieve it without putting it in
the repository:

```sh
security find-generic-password -a admin-password -s com.thwebco.hope.license-api -w
```

The Pokémon Center Discord webhook is a Worker secret,
`ZYN_POKEMON_QUEUE_DISCORD_WEBHOOK`. Store it in Keychain as
`pokemon-queue-discord-webhook` under `com.thwebco.hope.license-api`, then run
`node scripts/configure-license-service.cjs`. Do not put the webhook URL in the
repository.

The admin page can:

- review waiting-list signups and invite them with a complete ready-to-copy message;
- create a user and generate a one-time temporary password;
- set each account's active-device limit from 1 to 10;
- generate a seven-day, single-use link to the private Zyn download page;
- create and edit encrypted managed proxy lists;
- save, replace, or remove the server-side Hyper API key without exposing it back to the browser;
- save, replace, or remove the server-side Pokémon Center queue-event license;
- keep the queue relay connected so a Discord webhook can announce queue-up pings even when no
  desktop client is online;
- grant or remove a user's access to all managed proxy lists;
- enable optional task types globally or override Pokémon Center/Round1 access per user;
- review global checkout analytics across all users, including range totals, charting, per-user
  performance, and searchable checkout history;
- revoke all active licenses for a user;
- generate a new temporary password (also revokes active licenses);
- disable or re-enable an account; and
- permanently delete a user and their licenses.

The admin interface is divided into hash-addressable Accounts, Waiting List, Managed Proxies,
Settings, and Analytics pages. Settings owns global module availability and the encrypted Hyper and
Pokémon Center queue credentials; account-specific module overrides remain with each account.

Send temporary passwords through a private channel. The password is only returned by the create or
reset response and is not recoverable from D1 afterward.

Download links contain a 256-bit random key. D1 stores only its SHA-256 hash, and generating a new
unused link invalidates the older unused link for that account. The download page uses an explicit
unlock step so email and chat link-preview scanners cannot consume the key with a GET request. A
successful unlock replaces it with an HttpOnly, 24-hour browser session; disabling or deleting the
account invalidates that session. Both production admin domains generate canonical
`https://zynbot.app/download` links while the rcart admin remains available during migration.

The public website accepts waiting-list email addresses at <https://rcart.app/join> and
<https://zynbot.app/join>. Each site forwards to the matching license-service domain. Submissions are
normalized and deduplicated in D1, and the public response does not reveal whether an address was
already present. Inviting an entry in Admin creates its Zyn account when needed, generates a
seven-day single-use download link, marks the waiting-list entry invited, and shows one copyable
invitation. New-account invitations include the one-time temporary password; existing accounts keep
their current password. Removing a waiting-list entry does not delete its Zyn account.

## Paid licenses

Self-serve purchase is <https://zynbot.app/buy>. The product, intro price, and renewal price live
in `config/billing-catalog.json`. The Worker snapshot in
`cloudflare/license/src/billing-catalog.js` must stay in lockstep with that file.

Current plan:

- $100 once for the first 60 days
- then $40 every month
- Target is always available; Pokémon Center US is granted on purchase

Set the live Stripe key and webhook signing secret from the environment (do not paste them into
the repo or a command-line history you share):

```sh
STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... node scripts/set-stripe-secret.cjs
```

Provision Stripe products and prices from this Mac:

```sh
# test mode
STRIPE_SECRET_KEY=sk_test_... node scripts/provision-stripe-catalog.cjs --sandbox
# live mode
STRIPE_SECRET_KEY=sk_live_... node scripts/provision-stripe-catalog.cjs --live
```

The script writes the Stripe product/price IDs back into the catalog JSON and the Worker snapshot.
Store the matching secret in Keychain as `stripe-secret-key-sandbox` or `stripe-secret-key-live`
under `com.thwebco.hope.license-api`, plus `stripe-webhook-secret`, then run
`node scripts/configure-license-service.cjs`. Point the Stripe webhook at
`https://license.zynbot.app/api/billing/webhook` for `checkout.session.completed`, `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted`.

Accounts without `access_until` keep working (admin-created and invited beta users). Paid accounts
get an expiry; login and license validation return `subscription_expired` after that time until
Stripe renews them.

## User flow

1. The admin creates the user's email and shares the generated temporary password.
2. The user signs into Zyn.
3. The first login requires a new password of at least 10 characters.
4. The API mints a device-bound license and enforces the account's assigned active-device limit,
   which can be set from 1 to 10 and defaults to 1. A repeat login replaces that device's previous
   session. When the account is already at its limit, a new device sign-in replaces the least
   recently active session.
5. Zyn validates each license every five minutes. A session replaced by another sign-in, or ended
   because an administrator reduced the account's device limit, asks the user to sign in again and
   says why. Expiration, password changes, administrator revocation, and account disablement have
   distinct messages. Any definite session end immediately returns the app to its sign-in gate and
   stops running tasks. Transient network failures have a bounded 15-minute grace period.

When `proxy_access` is enabled for a user, login returns the current managed proxy lists. Every
five-minute validation sends the revision already in memory; an unchanged revision returns only a
small metadata response, while an admin edit returns the complete new lists. The desktop keeps one
copy of credentials in main-process memory, exposes only names/counts to normal renderer screens,
and never writes managed lists to `proxies.json` or a backup. Removing access clears the lists on the
user’s next validation without revoking the app license.

Optional task types are denied by default. The admin page has a global default for each registered
type and a per-user override with Enabled, Disabled, or Use global. Effective access is returned on
login and every five-minute license validation. If access is removed, the desktop hides the module,
blocks new launches in the main process, and stops that module’s running tasks. Target remains the
always-available base task type. Enabling a type globally clears existing per-user denies so every
current user receives it; individual users can be disabled again afterward.

Each managed list accepts up to 50,000 proxies or 5 MB of raw text. Contents are gzip-compressed and
then AES-256-GCM encrypted before they are stored in D1, avoiding D1's 2 MB row limit for normal
large pools. Existing uncompressed encrypted rows remain readable. The encryption key is
kept in the Worker secret `PROXY_ENCRYPTION_KEY` and this Mac's Keychain under the account
`proxy-encryption-key`; losing or rotating it makes existing lists unreadable, so preserve it with
the other license-service secrets.

Passwords use PBKDF2-SHA256 plus a Worker-only pepper. D1 stores only hashes of passwords, reset
tokens, license bearer tokens, download keys, and download sessions. The desktop bearer token is
encrypted with Electron `safeStorage` and never enters renderer settings or exports.

The Hyper API key is encrypted with AES-256-GCM before D1 storage using the separate Worker-only
`SERVICE_CONFIG_ENCRYPTION_KEY`. Admin responses contain only its short SHA-256 fingerprint and
update time; neither the admin page nor an installed desktop can read the saved key. A licensed,
device-bound desktop with effective Pokémon Center access can POST to five fixed broker operations:
`reese84`, `datadome-tags`, `datadome-interstitial`, `datadome-slider`, and `incapsula-utmvc`. The
Worker applies the key to the corresponding Hyper Solutions request, enforces body/response limits,
a 30-second timeout, and a per-user request window, and never accepts a caller-supplied upstream URL.
Broker callers always submit JSON; the Worker applies the gzip content encoding required by the
Incapsula UTMVC endpoint.
The initial limit is 1,200 broker requests per user per minute and can be tightened after observing
real Pokémon Center task traffic.

The Pokémon Center queue-event license uses the same AES-256-GCM service-configuration storage and
is exposed in admin only as a short fingerprint and update time. A single Durable Object maintains
the upstream receive-only WebSocket while licensed Zyn clients are connected. Its upstream URL has
only the required `key` and `version` query parameters. `version` is Polar’s current app tag, read
from the public `PolarAIO/downloads` GitHub releases feed every 15 minutes (and whenever the stored
value is older than an hour). A last-known-good fallback is used if GitHub is unreachable. The
connector supplies no custom headers and sends no application messages, presence, task data,
products, profile names, device identifiers, or telemetry. The Worker decrypts incoming frames, discards configuration/user/stock data, and forwards
only normalized Pokémon Center `queue` or `captcha` events plus connection health. Desktop bearer
and device headers terminate at the Worker and are not forwarded into the Durable Object connector.
The native three-second HTTPS watcher remains active whenever the push stream is configured,
disconnected, or unavailable.

Encrypted account backups use a private object bucket plus D1 metadata. The desktop gzip-compresses
the portable data bundle, encrypts it with AES-256-GCM using a locally held recovery key, and uploads
only the encrypted envelope. Recovery keys are protected locally with Electron `safeStorage` and are
never sent to the service. Objects are scoped by user UUID and the newest ten revisions are retained.
Uploads are limited per account before the Worker reads the body or writes R2. New objects use
conditional creation and an R2 SHA-256 receipt; downloads verify the R2 receipt, full encrypted body,
D1 metadata, and envelope header before returning bytes. Legacy objects without the newer R2 custom
metadata remain readable after full verification. See `docs/encrypted-cloud-backup.md` for the
desktop compatibility, key lifecycle, data scope, and transactional restore contract.

Checkout analytics are stored in D1 under the authenticated user's server-derived UUID. The desktop
sends one idempotent outcome event per cart, checkout, or decline with nested product rows, integer
cents, quantities, site, order number, and time. The API ignores caller-supplied ownership and does
not accept account email, profile data, addresses, cards, passwords, proxies, or license tokens as
analytics fields. A local, permission-restricted outbox retries temporary failures and is bound to a
one-way hash of the signed-in account so queued events cannot cross an account switch. Dashboard
queries support Today, 30 Days, 90 Days, and All Time; checkout history is searchable, paginated,
exportable from the desktop, and deletable by the signed-in user.

The admin Analytics tab uses separate admin-session-protected endpoints to aggregate those same
events across all users. It shows active users, checkouts, declines, total spent, stuck carts, a
daily chart, per-user results, and global checkout history. The global indexes in migration 0009
keep range queries from depending on a user-prefixed index. These endpoints remain inside the
HttpOnly admin-cookie boundary and do not expose analytics through the public or desktop APIs.

Task telemetry (migration 0015) tracks how tasks fare against site protections: cart attempts,
carted, Shape blocks by login, cart and precart, soft blocks, DCO and 429 rate limits, Shape cookie
availability, queue passes, and checkout outcomes. The engine tags every event with the Shape cookie
source, cookie type, and cookie age at the moment it was used. Because a single user can produce
hundreds of cart attempts a minute, the desktop rolls events up locally into hourly buckets keyed
by site, event, step, cookie source, cookie type, engine version, and app version, then uploads
the counters once a minute to `POST /api/analytics/task-telemetry`. Each upload carries a batch id
that is claimed in `analytics_task_batches` before any counter is added, so a replayed batch whose
response was lost is applied once; claims older than seven days are pruned by the cron. Buckets
never carry task ids, accounts, profiles, products, or order numbers. The admin Analytics tab reads
`GET /api/admin/analytics/shape` for global totals, block rates and average cookie age by cookie
source, by engine and app version, an hourly or daily series, and the most blocked users.

## Operations

From the repository root:

```sh
# Sync Worker secrets directly (the script preserves existing Keychain values):
node scripts/configure-license-service.cjs

# First deployment only:
npm run license:storage:create

npm run license:configure
npm run license:migrate
npm run license:deploy
npm run license:verify
```

- `license:configure` preserves existing Keychain values, generating only missing secrets, and syncs
  them to Cloudflare. The direct `node` command above performs the same configuration in source-only
  checkouts that do not contain the historical root package scripts.
- `license:storage:create` creates the private encrypted-backup bucket. Run it once; later runs will
  report that the bucket already exists.
- `license:migrate` applies pending D1 migrations remotely.
- `license:deploy` deploys the Worker and static admin assets.
- `license:verify` creates a disposable waiting-list entry, invites it, and tests the website form,
  single-use download access, account-disable invalidation, first-login reset, minting, validation,
  encrypted proxy delivery/removal, revocation, rejection, and cleanup using the same API client
  embedded in Zyn.

For a schema change, add a new numbered SQL file under `migrations/`; do not edit an already-applied
migration.
