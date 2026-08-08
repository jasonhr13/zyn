# Hope for macOS

`dist/Hope.app` is a native Apple Silicon Electron build of Hope 1.6.74 from
`Hope-Setup.exe`. The frontend and JavaScript application archive are unchanged
apart from upstream version metadata.
Its packaged `backend.exe`, Windows Node runtime, and their Windows child
processes run through a private Wine 11 runtime inside the app bundle.

The Wine prefix is created on first use under Hope's normal macOS application
data directory. No Homebrew Wine or system Node installation is required by the
built app.

The original auto-updater is suppressed in this wrapper because its release
feed publishes a Windows installer and no macOS update artifact.

The wrapper also preserves Chromium hardware acceleration on macOS. The
upstream app disables it globally for a Windows window-restore workaround, but
that forced this gradient- and blur-heavy UI through SwiftShader software
compositing and made text entry noticeably laggy on a Mac.

## Electron 43 canary

`dist/Hope-Electron43.app` runs the same Hope 1.6.74 ASAR, backend, Wine runtime,
and React 16.14 bundle under Electron 43.3.0. `dist/Hope.app` remains the working
Electron 19.0.10 rollback build.

Modern Electron majors keep their Chromium-only cookies, caches, and browser
storage under `~/Library/Application Support/Hope/chromium-<major>`. Hope's JSON
data and Wine prefix stay in their original shared locations. This prevents a
new Chromium database format from making the Electron 19 rollback reject its
own browser storage.

To rebuild the Electron 43 canary after moving the old canary aside:

```sh
HOPE_ELECTRON_VERSION=43.3.0 \
HOPE_OUTPUT_APP="$PWD/dist/Hope-Electron43.app" \
./scripts/build-mac.sh
```

Run the reusable route, IPC, layout, and profile-input smoke test against an app
launched with `--remote-debugging-port=<port>`:

```sh
node ./scripts/runtime-smoke-test.js <port> /tmp/hope-profile.png
```

## React 18.3 canary

`dist/Hope-Electron43-React18.app` adds React and ReactDOM 18.3.1 on top of the
Electron 43 canary. The application source was recovered from the complete
source maps into `frontend/src`, and the entry point uses React 18's
`createRoot`. The previous React 16 build is retained inside this canary as
`app-react16-original.asar` for inspection and rollback.

Install the pinned frontend dependencies once, then rebuild after moving the
old React 18 output aside:

```sh
cd frontend
npm install --legacy-peer-deps --no-audit --no-fund
cd ..
./scripts/build-react18-canary.sh
```

The isolated profile persistence check is available as:

```sh
node ./scripts/profile-crud-smoke-test.js <port>
```

The current macOS development build uses a temporary local license adapter in
`launcher/bootstrap.js`. It does not contact the retired verification/session
endpoints, opens directly into the app, and identifies global checkout reports
as `seaniepokie`. Remove `enableLocalDeveloperLicense()` when the replacement
license client is ready.

The 1.6.74 update also carries the newer Go backend (source revision
`d01b552ad3a202686f9fd9a9ac95d24cbba35e45`) and the refreshed encrypted Target
and proxy resource pools from the August 7 installer.

## Control-plane R0 baseline

R0 is the frozen Electron 43 + React 18 integration baseline for the control-plane roadmap. Every
control-plane feature flag is disabled, and the packaged backend, Windows Node runtime, Wine binary,
bundle identifier, application version, and launcher symlinks are checked against
`config/runtime-contract.json` during the build.

Build the independently installable R0 artifact:

```sh
./scripts/build-r0.sh
```

The output is `dist/Hope-ControlPlane-R0.app`. Its `Contents/Resources/hope-build.json` receipt
records the source commit, dirty state, framework versions, build time, and immutable runtime
hashes. Verify an existing artifact without rebuilding it:

```sh
node ./scripts/verify-runtime-contract.js ./dist/Hope-ControlPlane-R0.app
```

Before a phase that changes persisted UI data, create a private, ignored snapshot of Hope's
top-level JSON data. The snapshot directory and every copied file are owner-only:

```sh
node ./scripts/snapshot-user-data.js
```

Use `--source <directory>` or `--output-root <directory>` when the data is stored elsewhere.

## Control-plane R1 design shell

R1 ports the repository's complete light/dark token palette, local SVG icon system, title bar, and
consolidated navigation without replacing React Router or any module implementation. The new Tasks
hub links to the existing Bandai, Target, Secret Lair, and Round1 routes; old bookmarks remain valid.
The wrapper also restores and atomically persists validated window dimensions.

```sh
./scripts/build-r1.sh
node ./scripts/window-size-state-smoke-test.js
```

The output is `dist/Hope-ControlPlane-R1.app`. R0 remains available from the
`control-plane-r0` Git tag and its previously built application bundle.

## Control-plane R2 task groups

R2 adds a persistent Target task-group control plane without replacing or modifying the Target
engine. Each group owns a shared SKU watch list, quantity, default proxy selection, and account task
membership. Starting a group resolves the same account-to-profile email match and sends the same
`startTarget` payload used by the legacy Target page. Task Groups becomes the visible Target entry
in the Tasks hub; the original `/target` route remains valid for bookmarks and rollback checks.

On first use, R2 copies an existing `target-tasks.json` workspace into a `Recovered Target Tasks`
group. The legacy file is never changed, so R1 remains a data-safe rollback. R2 writes the new
`task-groups.json` atomically with owner-only permissions and rotating backups. Task scheduling and
API-controlled module visibility remain disabled behind later release flags.

```sh
./scripts/build-r2.sh
node ./scripts/task-group-store-smoke-test.js
node ./scripts/task-group-crud-smoke-test.js <port> /tmp/hope-r2-task-groups.png <isolated-user-data-dir>
```

The independently installable output is `dist/Hope-ControlPlane-R2.app`. R1 remains available from
the `control-plane-r1` Git tag and its previously built application bundle.

## Control-plane R3 replacement-license observation

R3 brings the replacement licensing stack directly from
[`jasonhr13/hope`](https://github.com/jasonhr13/hope) commit
`423d13260bee6b6f9ba01d175c948c0afd86da9a`. The complete `cloudflare/license` Worker, migrations,
admin UI, and `public/helpers/license-client.js` are preserved byte-for-byte here. Their source
hashes are pinned in `config/upstream-license.json` and verified with:

```sh
node ./scripts/verify-upstream-license.js
```

`launcher/license-observer.js` is a wrapper-only adapter around that unchanged client. It stores the
bearer token with Electron `safeStorage`, keeps passwords, bearer tokens, reset tokens, hardware IDs,
and managed proxy credentials out of the renderer, and exposes a replacement-license status panel
in Settings. If OS-backed encryption is unavailable the token remains in memory and is never written.

R3 is observe-only. Its status does not replace the existing local developer session, gate the UI,
block task launches, hide modules, apply managed proxy lists, or change the `seaniepokie` reporter
identity. Signing in is nevertheless a live service action: the imported Cloudflare Worker revokes
the account's prior active license before minting the new device-bound session.

```sh
./scripts/build-r3.sh
node ./scripts/license-observer-smoke-test.js
```

The independently installable output is `dist/Hope-ControlPlane-R3.app`. R2 remains available from
the `control-plane-r2` Git tag and its previously built application bundle.

## Control-plane R4 license enforcement

R4 promotes the same imported Cloudflare client from observation to the authoritative application
license. The email/password gate and main-process lifecycle follow the Hope repository's replacement
license flow: device-bound login, first-login password replacement, encrypted bearer persistence,
validation every five minutes, a 15-minute offline grace window, server-side revoke/disable handling,
and explicit logout. The first successful R4 launch migrates an encrypted R3 observer session into
the authoritative `license-session.json`; invalidation and logout clear both copies.

The original app's mature launch checks now read this authority instead of the retired key service.
An additional helper/engine guard blocks internal retry timers and direct renderer IPC from spawning
work after a license loss. A revoke, disable, grace expiry, or logout stops running tasks and returns
the window to the account gate. The retired key is removed from settings and its activation IPC can
no longer authorize the app.

R4 does not apply task-type entitlements, managed proxy catalogs, cloud backup, or scheduling; those
remain behind later release flags. Checkout reporting continues to use the requested `seaniepokie`
identity. The imported Cloudflare Worker and API client remain byte-for-byte pinned to the same Hope
commit documented above.

```sh
./scripts/build-r4.sh
node ./scripts/license-authority-smoke-test.js
node ./scripts/license-enforcement-runtime-smoke-test.js <port> /tmp/hope-r4-license-gate.png
```

The independently installable output is `dist/Hope-ControlPlane-R4.app`. R3 remains available from
the `control-plane-r3` Git tag and its previously built application bundle.

## Control-plane R5 API module access

R5 enables the task-type entitlements already returned by the imported Cloudflare license Worker.
Its optional-module registry is copied byte-for-byte from the Hope repository and pinned alongside
the Worker and license client in `config/upstream-license.json`. Target, Bandai, and Secret Lair stay
available to every licensed account. Pokémon Center and Round1 are denied unless the signed session
explicitly enables their `pokemoncenter` or `round1` task type.

The Tasks hub hides unavailable optional modules, stale direct links return to the hub, and Settings
shows the account's current access. These renderer checks are only navigation: the main process also
guards both optional start IPC channels and the underlying task helpers. If periodic validation
removes access, running work for that module is stopped immediately. A forged renderer status cannot
authorize main. Managed proxy catalogs, cloud backup, and scheduling remain disabled.

```sh
./scripts/build-r5.sh
node ./scripts/verify-upstream-license.js
node ./scripts/task-type-access-smoke-test.js
node ./scripts/license-authority-smoke-test.js
node ./scripts/module-access-runtime-smoke-test.js <port> /tmp/hope-r5-module-access.png
```

The independently installable output is `dist/Hope-ControlPlane-R5.app`. R4 remains available from
the `control-plane-r4` Git tag and its previously built application bundle.

## Control-plane R6 per-profile IMAP

R6 ports Hope's per-profile IMAP model and connection tester from the same pinned upstream commit.
Each checkout profile can select Gmail, Outlook, Yahoo, iCloud, or a custom IMAP host and verify its
app password before saving. The password sanitizer and connection helper are preserved byte-for-byte
in `launcher/imap-password.js` and `launcher/imap-connection.js`; their hashes are pinned in
`config/upstream-license.json`.

Mailbox passwords are encrypted at rest with Electron `safeStorage`. A one-time migration copies an
existing global mailbox onto existing profiles that do not already own one, creates owner-only R5
rollback backups, and then removes the retired global keys. Target and Walmart resolve IMAP from the
profile selected for that task. A hash-gated build patch limits the engine changes to this routing;
`backend.exe`, Windows Node, and Wine remain frozen by the runtime contract.

Manual backup exports intentionally decrypt profile mailbox passwords in memory, alongside the other
portable credentials, so the upcoming encrypted cloud-backup phase can wrap the complete profile.
Import encrypts them for the destination Mac. The existing plaintext-export warning now names mailbox
passwords explicitly. Cloud upload itself remains disabled in R6.

```sh
./scripts/build-r6.sh
node ./scripts/verify-upstream-license.js
node ./scripts/profile-imap-control-smoke-test.js
node ./scripts/imap-connection-smoke-test.js
node ./scripts/profile-imap-engine-patch-smoke-test.js
node ./scripts/profile-imap-runtime-smoke-test.js <port> /tmp/hope-r6-profile-imap.png <isolated-user-data-dir>
```

The independently installable output is `dist/Hope-ControlPlane-R6.app`. R5 remains available from
the `control-plane-r5` Git tag and its previously built application bundle.

## Control-plane R7 managed proxy lists

R7 activates the managed-list protocol already present in the pinned Hope Cloudflare Worker. An
administrator can create encrypted remote proxy lists and grant or revoke each user's proxy access.
The desktop sends its current revision during five-minute license validation, so unchanged lists do
not need to be downloaded again. The existing Worker, D1 migration, admin UI, and license client are
reused without a new service implementation.

Remote proxy lines live only in Electron's main-process memory. The renderer receives a stable
`managed:<uuid>` reference, admin label, and line count; it never receives the host, port, username,
or password. Managed entries are read-only in the Proxies page and work in the existing Tasks,
Target, P-Bandai, Round1, Pokémon Center, Walmart, Settings, and Generate selectors. Local proxy
lists remain editable and persist in `proxies.json` as before. Managed lists are excluded from local
files and backup exports.

Main-process launch guards resolve the reference only at an existing engine boundary. A revoked or
missing managed list stops before launch instead of falling back to the home IP. Revision changes or
access removal also stop running subsystems because their child processes may hold an older proxy
snapshot. Cloud backup and scheduling remain disabled in R7.

```sh
./scripts/build-r7.sh
node ./scripts/verify-upstream-license.js
node ./scripts/managed-proxy-control-smoke-test.js
node ./scripts/managed-proxy-ipc-guard-smoke-test.js
node ./scripts/license-authority-smoke-test.js
node ./scripts/managed-proxy-runtime-smoke-test.js <port> /tmp/hope-r7-managed-proxies.png
```

The independently installable output is `dist/Hope-ControlPlane-R7.app`. R6 remains available from
the `control-plane-r6` Git tag and its previously built application bundle.

The R7 UI maintenance build removes the redundant device-session acknowledgement from account sign
in, restores the shared Target Engine & Monitor Log below each task group's task table, and ports the
Hope cookie-bank card into Target groups. The card polls the existing broker status for login and ATC
cookie totals, reports the active/configured farmer workers, and saves Bank Max to the existing
`targetCookieBank` setting for the next start. No `backend.exe` or Wine behavior changes.

To rebuild after moving the old output aside:

```sh
./scripts/build-mac.sh
```

The builds use the verified Electron 19.0.10 and 43.3.0 arm64 runtimes in
`vendor/` and the WineHQ Stable runtime currently installed at
`/Applications/Wine Stable.app`.
