# Zyn for macOS

Zyn is an Apple silicon and Intel Electron application with native Go Target and Pokémon Center US
checkout support. The React interface, native Target farmer, licensing, per-profile IMAP, managed
proxy lists, and task workspaces are packaged together without Wine or Rosetta.

## Run the current build

Open the build matching the Mac from Finder, or run one of:

```bash
open -n ./dist/Zyn-mac-arm64.app
open -n ./dist/Zyn-mac-x64.app
```

The first branded launch copies existing application data into
`~/Library/Application Support/Zyn`. The previous data directory is retained as a rollback copy.

## Build

The build uses `dist/Zyn-Runtime-Base.app` as its source base. Release builds keep Electron and the
application shell and architecture-matched checkout engine in the app, while Chromium is installed
after sign-in from an architecture-aware signed manifest. The old Windows backend, Wine,
Chromium, and Node payloads are not needed by the native paths and are omitted entirely.

Rebuild the native engines before packaging whenever `polar-backend-source` changes:

```bash
POLAR_BACKEND_SOURCE=../polar-backend-source ./scripts/build-native-target-engine.sh all
```

```bash
ZYN_ARCH=arm64 ZYN_RUNTIME_MODE=remote ./scripts/build-zyn.sh
ZYN_ARCH=x64 ZYN_RUNTIME_MODE=remote ./scripts/build-zyn.sh
```

The outputs are `dist/Zyn-mac-arm64.app` and `dist/Zyn-mac-x64.app`. Move an existing output aside
before rebuilding. Override the input or output when needed:

```bash
ZYN_BASE_APP=/path/to/runtime.app \
ZYN_OUTPUT_APP=/path/to/Zyn-Test.app \
./scripts/build-zyn.sh
```

The builder compiles the React interface, patches the reviewed engine integration, writes the
`com.thwebco.zyn` identity and icon, removes heavyweight runtime payloads in remote mode, signs the
app ad hoc for local testing, updates deep links to `zyn://`, and verifies the native backend
contract plus the remote-runtime boundary. Use `ZYN_RUNTIME_MODE=bundled` only for recovery/debug
builds; that mode installs the matching native farmer browser, and the release script refuses to
publish it. Ad-hoc bundles are never uploaded as production updates.

## On-demand runtime channel

The runtime manager is ported from the established GitHub implementation rather than rebuilt. It starts only after a
valid Zyn account sign-in, resumes interrupted HTTP range downloads, verifies an Ed25519-signed
manifest and every archive SHA-256, rejects unsafe archive paths, installs atomically under Zyn's
user-data directory, and caches the verified runtime for offline use. Target launches wait only for
the Chromium component; the native checkout engine is already inside the signed app.

Production runtime preparation is:

```bash
node ./scripts/configure-zyn-runtime-signing-key.cjs
node ./scripts/create-zyn-runtime-manifest.cjs --verify-key
node ./scripts/prepare-zyn-runtime-artifacts.cjs all
node ./scripts/create-zyn-runtime-manifest.cjs
node ./scripts/upload-zyn-runtime-artifacts.cjs
node ./scripts/verify-zyn-runtime-channel.cjs
node ./scripts/zyn-production-runtime-install-smoke.cjs arm64
node ./scripts/zyn-production-runtime-install-smoke.cjs x64
node ./scripts/verify-zyn-public-release.cjs
```

`prepare-zyn-runtime-artifacts.cjs` signs and notarizes the ARM and Intel Chromium bundles. The
native checkout engines are pinned separately in `config/runtime-contract.json` and packaged by
`build-zyn.sh`. Manifest signing uses Keychain service
`com.thwebco.zyn.runtime-signing`; the private key must never enter the repository. Runtime uploads
reuse the Cloudflare R2 multipart channel and publish the signed manifest last.
When Cloudflare restricts authenticated POSTs on the custom download domain, set
`ZYN_UPLOAD_ORIGIN` to the Worker's direct `workers.dev` URL; public verification still uses
`ZYN_UPDATE_ORIGIN` and defaults to `https://updates.zynbot.app`.

The production switch requires both:

- `Developer ID Application: thwebco, LLC (GXWBXH5M77)` with its private key, for Chromium/app signing.
- The Zyn runtime-manifest private key in the login Keychain, matching the public key embedded in the app.

## Signed releases and auto-update feeds

A production release needs a valid `Developer ID Application: thwebco, LLC (GXWBXH5M77)` identity
with its private key in the login keychain. The existing `flume-notary` notarytool profile is used
for Apple notarization. After the identity is installed:

```bash
node ./scripts/release-zyn-macos.cjs arm64
node ./scripts/release-zyn-macos.cjs x64
node ./scripts/upload-zyn-macos-release.cjs arm64
node ./scripts/upload-zyn-macos-release.cjs x64
```

The release command clones the tested app, signs every nested Mach-O with hardened runtime,
notarizes and staples the app and DMG, verifies Gatekeeper, and creates the ZIP plus
`latest-mac.yml`. The uploader reuses the existing multipart R2 flow and publishes to
separate feeds:

- Apple silicon: `https://updates.zynbot.app/mac/arm64/latest-mac.yml`
- Intel: `https://updates.zynbot.app/mac/x64/latest-mac.yml`

The app selects its feed from `process.arch`; the public download routes are
`/download/mac/arm64` and `/download/mac/x64`.

## Verify

```bash
node ./scripts/verify-runtime-contract.js ./dist/Zyn-mac-arm64.app
node ./scripts/verify-runtime-contract.js ./dist/Zyn-mac-x64.app
node ./scripts/zyn-brand-smoke-test.js
node ./scripts/zyn-packaged-brand-smoke-test.js ./dist/Zyn-mac-arm64.app ./dist/Zyn-mac-x64.app
node ./scripts/target-only-ui-smoke-test.js
node ./scripts/pokemon-center-native-support-smoke-test.js
node ./scripts/target-farmer-controls-smoke-test.js
node ./scripts/target-farmer-new-headless-smoke-test.js
node ./scripts/native-target-engine-protocol-smoke.js
node ./scripts/runtime-manager-smoke.js
```

`Contents/Resources/zyn-build.json` records the product metadata, enabled features, source commit,
and immutable runtime hashes for each packaged build.
