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

To rebuild after moving the old output aside:

```sh
./scripts/build-mac.sh
```

The builds use the verified Electron 19.0.10 and 43.3.0 arm64 runtimes in
`vendor/` and the WineHQ Stable runtime currently installed at
`/Applications/Wine Stable.app`.
