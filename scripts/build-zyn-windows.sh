#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_RUNTIME="$PROJECT_DIR/vendor/electron-v43.3.0-win32-x64"
OUTPUT_APP="${ZYN_OUTPUT_APP:-$PROJECT_DIR/dist/Zyn-win32-x64}"
APP_VERSION="${ZYN_VERSION:-}"
APP_RELEASE="${ZYN_RELEASE:-}"
if [[ -z "$APP_VERSION" ]]; then
  APP_VERSION="$(node -p "require('$PROJECT_DIR/config/runtime-contract.json').product.version")"
fi
if [[ -z "$APP_RELEASE" ]]; then
  APP_RELEASE="$(node -p "require('$PROJECT_DIR/config/runtime-contract.json').appRelease")"
fi
NATIVE_BACKEND="$PROJECT_DIR/native-backend/windows-x64/backend.exe"
ASAR_BIN="$PROJECT_DIR/frontend/node_modules/.bin/asar"
TEMP_DIR="$(mktemp -d /private/tmp/zyn-windows-build.XXXXXX)"

cleanup() {
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /private/tmp/zyn-windows-build.* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -x "$ASAR_BIN" ]]; then
  echo "Missing ASAR packer. Run npm install in frontend/ first." >&2
  exit 1
fi
if [[ ! -d "$PROJECT_DIR/runtime-app/node_modules" ]]; then
  echo "Missing runtime app dependencies. Run npm ci in runtime-app/ first." >&2
  exit 1
fi
if [[ ! -d "$PROJECT_DIR/bot-runtime/node_modules" ]]; then
  echo "Missing bot runtime dependencies. Run npm ci in bot-runtime/ first." >&2
  exit 1
fi
if [[ ! -f "$NATIVE_BACKEND" ]]; then
  echo "Missing Windows native checkout backend: $NATIVE_BACKEND" >&2
  echo "Run ./scripts/build-native-target-engine.sh windows-x64 first." >&2
  exit 1
fi
if [[ ! -f "$ELECTRON_RUNTIME/electron.exe" ]]; then
  echo "Missing Windows Electron runtime: $ELECTRON_RUNTIME" >&2
  echo "Run node scripts/prepare-zyn-electron.cjs windows-x64 first." >&2
  exit 1
fi
if [[ -e "$OUTPUT_APP" ]]; then
  echo "Output already exists: $OUTPUT_APP" >&2
  echo "Move it aside before rebuilding." >&2
  exit 1
fi

EXPECTED_BACKEND_SHA="$(node -e '
  const contract = require(process.argv[1]);
  process.stdout.write((contract.nativeEngines["windows-x64"] || {}).sha256 || "");
' "$PROJECT_DIR/config/runtime-contract.json")"
ACTUAL_BACKEND_SHA="$(shasum -a 256 "$NATIVE_BACKEND" | awk '{print $1}')"
if [[ -z "$EXPECTED_BACKEND_SHA" || "$ACTUAL_BACKEND_SHA" != "$EXPECTED_BACKEND_SHA" ]]; then
  echo "Windows backend does not match config/runtime-contract.json." >&2
  echo "Expected: ${EXPECTED_BACKEND_SHA:-missing}" >&2
  echo "Actual:   $ACTUAL_BACKEND_SHA" >&2
  exit 1
fi

(
  cd "$PROJECT_DIR/frontend"
  node --openssl-legacy-provider node_modules/react-scripts/scripts/build.js
)

mkdir -p "$TEMP_DIR/app"
rsync -a --exclude='node_modules' --exclude='package-lock.json' \
  "$PROJECT_DIR/runtime-app/" "$TEMP_DIR/app/"
cp -R "$PROJECT_DIR/runtime-app/node_modules" "$TEMP_DIR/app/node_modules"
cp -R "$PROJECT_DIR/frontend/build" "$TEMP_DIR/app/build"
node "$PROJECT_DIR/scripts/verify-native-farmer-upstream.js"
cp "$PROJECT_DIR/native-farmer/runtime-paths.js" "$TEMP_DIR/app/public/helpers/runtime-paths.js"
for helper in \
  analytics-recorder.js manual-captcha-manager.js native-engine-contract.js native-hyper-broker.js; do
  cp "$PROJECT_DIR/launcher/$helper" "$TEMP_DIR/app/public/helpers/$helper"
done
node "$PROJECT_DIR/scripts/patch-zyn-checkout-webhook.cjs" \
  "$TEMP_DIR/app/public/helpers/checkout-reporter.js"

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.name = "zyn";
  pkg.productName = "Zyn";
  pkg.description = "Zyn Checkout Automation";
  pkg.version = process.argv[2];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$TEMP_DIR/app/package.json" "$APP_VERSION"

"$ASAR_BIN" pack "$TEMP_DIR/app" "$TEMP_DIR/app-original.asar"

mkdir -p "$OUTPUT_APP"
rsync -a --exclude='.zyn-source.sha256' "$ELECTRON_RUNTIME/" "$OUTPUT_APP/"
mv "$OUTPUT_APP/electron.exe" "$OUTPUT_APP/Zyn.exe"
RESOURCES="$OUTPUT_APP/resources"
rm -f "$RESOURCES/default_app.asar"

mkdir -p "$RESOURCES/bot"
rsync -a --exclude='node_modules' --exclude='package-lock.json' --exclude='package.json' --exclude='README.md' \
  "$PROJECT_DIR/bot-runtime/" "$RESOURCES/bot/"
cp -R "$PROJECT_DIR/bot-runtime/node_modules" "$RESOURCES/node_modules"
mkdir -p "$RESOURCES/vendor"
cp "$PROJECT_DIR/native-farmer/"*.mjs "$RESOURCES/bot/"
cp "$PROJECT_DIR/native-farmer/"*.html "$RESOURCES/bot/"
node "$PROJECT_DIR/scripts/patch-zyn-bot-webhook-brand.cjs" "$RESOURCES/bot"
node "$PROJECT_DIR/scripts/patch-zyn-checkout-webhook.cjs" \
  "$RESOURCES/bot/pbandai-buyer.cjs"

mkdir -p "$RESOURCES/engine"
cp "$NATIVE_BACKEND" "$RESOURCES/engine/backend.exe"
chmod 0755 "$RESOURCES/engine/backend.exe"
cp "$TEMP_DIR/app-original.asar" "$RESOURCES/app-original.asar"
if [[ -d "$TEMP_DIR/app-original.asar.unpacked" ]]; then
  cp -R "$TEMP_DIR/app-original.asar.unpacked" "$RESOURCES/app-original.asar.unpacked"
fi

mkdir -p "$RESOURCES/app"
for launcher_file in \
  bootstrap.js feature-flags.js license-client.js license-session-reason.js license-authority.js license-observer.js \
  checkout-reporting.js analytics-recorder.js \
  pokemon-queue-events.js \
  task-type-access.js task-type-ipc-guard.js task-group-store.js task-group-schedule.js target-product-history.js \
  task-group-scheduler.js target-group-launch.js target-readiness.js proxy-resolve.js target-cookie-standby.js window-size-state.js \
  imap-password.js imap-connection.js profile-imap-control.js account-group-control.js proxy-group-control.js managed-proxy-control.js \
  managed-proxy-ipc-guard.js resifactory-client.js resifactory-control.js evomi-client.js evomi-control.js ipfist-client.js ipfist-control.js hcaptcha-autosolver.js harvester-extension-bridge.js cloud-backup.js cloud-backup-data.js runtime-manager.js; do
  cp "$PROJECT_DIR/launcher/$launcher_file" "$RESOURCES/app/$launcher_file"
done
cp "$PROJECT_DIR/launcher/package.json" "$RESOURCES/app/package.json"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = process.argv[2];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$RESOURCES/app/package.json" "$APP_VERSION"
mkdir -p "$RESOURCES/app/node_modules"
cp -R "$PROJECT_DIR/launcher/node_modules/." "$RESOURCES/app/node_modules/"
node "$PROJECT_DIR/scripts/prune-zyn-native-addons.cjs" "$RESOURCES/app/node_modules" win32 x64

cp "$PROJECT_DIR/assets/brand/Zyn.ico" "$RESOURCES/Zyn.ico"
node "$PROJECT_DIR/scripts/write-windows-update-config.cjs" "$OUTPUT_APP"
node "$PROJECT_DIR/scripts/write-windows-build-receipt.cjs" "$OUTPUT_APP" "$APP_RELEASE"
node "$PROJECT_DIR/scripts/brand-zyn-windows-executable.cjs" "$OUTPUT_APP/Zyn.exe" "$APP_VERSION"
node "$PROJECT_DIR/scripts/verify-zyn-windows-build.cjs" "$OUTPUT_APP"

echo "$OUTPUT_APP"
