#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_APP="${ZYN_BASE_APP:-$PROJECT_DIR/dist/Zyn-Runtime-Base.app}"
BASE_RESOURCES="$BASE_APP/Contents/Resources"
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

if [[ ! -d "$BASE_RESOURCES" ]]; then
  echo "Missing Zyn runtime base: $BASE_APP" >&2
  exit 1
fi
if [[ ! -x "$ASAR_BIN" ]]; then
  echo "Missing ASAR packer. Run npm install in frontend/ first." >&2
  exit 1
fi
if [[ ! -f "$NATIVE_BACKEND" ]]; then
  echo "Missing Windows native checkout backend: $NATIVE_BACKEND" >&2
  echo "Run ./scripts/build-native-target-engine.sh windows-x64 first." >&2
  exit 1
fi
if [[ ! -f "$BASE_RESOURCES/vendor/node.exe" ]]; then
  echo "Missing bundled Windows Node runtime: $BASE_RESOURCES/vendor/node.exe" >&2
  exit 1
fi
if [[ ! -f "$ELECTRON_RUNTIME/electron.exe" ]]; then
  echo "Missing Windows Electron runtime: $ELECTRON_RUNTIME" >&2
  echo "Run node scripts/prepare-zyn-windows-electron.cjs first." >&2
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

cp -cR "$PROJECT_DIR/extracted/asar" "$TEMP_DIR/app"
rm -rf "$TEMP_DIR/app/build"
cp -R "$PROJECT_DIR/frontend/build" "$TEMP_DIR/app/build"
node "$PROJECT_DIR/scripts/verify-native-farmer-upstream.js"
cp "$PROJECT_DIR/native-farmer/runtime-paths.js" "$TEMP_DIR/app/public/helpers/runtime-paths.js"
node "$PROJECT_DIR/scripts/patch-profile-imap-engines.js" "$TEMP_DIR/app/public/helpers"
node "$PROJECT_DIR/scripts/patch-zyn-runtime-brand.js" "$TEMP_DIR/app"
node "$PROJECT_DIR/scripts/patch-zyn-checkout-webhook.cjs" \
  "$TEMP_DIR/app/public/helpers/checkout-reporter.js"

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.name = "zyn";
  pkg.productName = "Zyn";
  pkg.version = process.argv[2];
  pkg.dependencies.react = "18.3.1";
  pkg.dependencies["react-dom"] = "18.3.1";
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$TEMP_DIR/app/package.json" "$APP_VERSION"

"$ASAR_BIN" pack "$TEMP_DIR/app" "$TEMP_DIR/app-original.asar" \
  --unpack-dir node_modules/node-notifier

mkdir -p "$OUTPUT_APP"
rsync -a --exclude='.zyn-source.sha256' "$ELECTRON_RUNTIME/" "$OUTPUT_APP/"
mv "$OUTPUT_APP/electron.exe" "$OUTPUT_APP/Zyn.exe"
RESOURCES="$OUTPUT_APP/resources"
rm -f "$RESOURCES/default_app.asar"

cp -R "$BASE_RESOURCES/bot" "$RESOURCES/bot"
cp -R "$BASE_RESOURCES/node_modules" "$RESOURCES/node_modules"
mkdir -p "$RESOURCES/vendor"
cp "$BASE_RESOURCES/vendor/node.exe" "$RESOURCES/vendor/node.exe"
node "$PROJECT_DIR/scripts/patch-zyn-checkout-webhook.cjs" \
  "$RESOURCES/bot/pbandai-buyer.cjs"
cp "$PROJECT_DIR/native-farmer/"*.mjs "$RESOURCES/bot/"
cp "$PROJECT_DIR/native-farmer/"*.html "$RESOURCES/bot/"
mkdir -p "$RESOURCES/bot/node_modules"
cp -R "$PROJECT_DIR/launcher/node_modules/." "$RESOURCES/bot/node_modules/"

mkdir -p "$RESOURCES/engine"
cp "$NATIVE_BACKEND" "$RESOURCES/engine/backend.exe"
chmod 0755 "$RESOURCES/engine/backend.exe" "$RESOURCES/vendor/node.exe"
cp "$TEMP_DIR/app-original.asar" "$RESOURCES/app-original.asar"
if [[ -d "$TEMP_DIR/app-original.asar.unpacked" ]]; then
  cp -R "$TEMP_DIR/app-original.asar.unpacked" "$RESOURCES/app-original.asar.unpacked"
fi

mkdir -p "$RESOURCES/app"
for launcher_file in \
  bootstrap.js feature-flags.js license-client.js license-authority.js license-observer.js \
  checkout-reporting.js \
  pokemon-queue-events.js \
  task-type-access.js task-type-ipc-guard.js task-group-store.js task-group-schedule.js \
  task-group-scheduler.js target-group-launch.js window-size-state.js \
  imap-password.js imap-connection.js profile-imap-control.js managed-proxy-control.js \
  managed-proxy-ipc-guard.js runtime-manager.js; do
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

cp "$PROJECT_DIR/assets/brand/Zyn.ico" "$RESOURCES/Zyn.ico"
node "$PROJECT_DIR/scripts/write-windows-update-config.cjs" "$OUTPUT_APP"
node "$PROJECT_DIR/scripts/write-windows-build-receipt.cjs" "$OUTPUT_APP" "$APP_RELEASE"
node "$PROJECT_DIR/scripts/brand-zyn-windows-executable.cjs" "$OUTPUT_APP/Zyn.exe" "$APP_VERSION"
node "$PROJECT_DIR/scripts/verify-zyn-windows-build.cjs" "$OUTPUT_APP"

echo "$OUTPUT_APP"
