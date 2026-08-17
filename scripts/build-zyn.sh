#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ARCH="${ZYN_ARCH:-$(uname -m)}"
if [[ "$APP_ARCH" == "x86_64" ]]; then APP_ARCH="x64"; fi
if [[ "$APP_ARCH" != "arm64" && "$APP_ARCH" != "x64" ]]; then
  echo "Unsupported Zyn architecture: $APP_ARCH (expected arm64 or x64)" >&2
  exit 1
fi
OUTPUT_APP="${ZYN_OUTPUT_APP:-$PROJECT_DIR/dist/Zyn-mac-$APP_ARCH.app}"
ELECTRON_RUNTIME="$PROJECT_DIR/vendor/electron-v43.3.0-darwin-$APP_ARCH/Electron.app"
APP_RELEASE="${ZYN_RELEASE:-}"
APP_VERSION="${ZYN_VERSION:-}"
if [[ -z "$APP_VERSION" ]]; then
  APP_VERSION="$(node -p "require('$PROJECT_DIR/config/runtime-contract.json').product.version")"
fi
if [[ -z "$APP_RELEASE" ]]; then
  APP_RELEASE="$(node -p "require('$PROJECT_DIR/config/runtime-contract.json').appRelease")"
fi
NATIVE_BACKEND="$PROJECT_DIR/native-backend/darwin-$APP_ARCH/backend"
RUNTIME_MODE="${ZYN_RUNTIME_MODE:-remote}"
if [[ "$RUNTIME_MODE" != "remote" && "$RUNTIME_MODE" != "bundled" ]]; then
  echo "Unsupported Zyn runtime mode: $RUNTIME_MODE (expected remote or bundled)" >&2
  exit 1
fi
ASAR_BIN="$PROJECT_DIR/frontend/node_modules/.bin/asar"
TEMP_DIR="$(mktemp -d /private/tmp/zyn-build.XXXXXX)"

cleanup() {
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /private/tmp/zyn-build.* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -d "$ELECTRON_RUNTIME" ]]; then
  echo "Missing Electron runtime: $ELECTRON_RUNTIME" >&2
  echo "Run node scripts/prepare-zyn-electron.cjs $APP_ARCH first." >&2
  exit 1
fi
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
if [[ ! -x "$NATIVE_BACKEND" ]]; then
  echo "Missing native checkout backend: $NATIVE_BACKEND" >&2
  echo "Run ./scripts/build-native-target-engine.sh $APP_ARCH first." >&2
  exit 1
fi
EXPECTED_BACKEND_SHA="$(node -e '
  const contract = require(process.argv[1]);
  process.stdout.write((contract.nativeEngines[process.argv[2]] || {}).sha256 || "");
' "$PROJECT_DIR/config/runtime-contract.json" "$APP_ARCH")"
ACTUAL_BACKEND_SHA="$(shasum -a 256 "$NATIVE_BACKEND" | awk '{print $1}')"
if [[ -z "$EXPECTED_BACKEND_SHA" || "$ACTUAL_BACKEND_SHA" != "$EXPECTED_BACKEND_SHA" ]]; then
  echo "Native checkout backend does not match config/runtime-contract.json for $APP_ARCH." >&2
  echo "Expected: ${EXPECTED_BACKEND_SHA:-missing}" >&2
  echo "Actual:   $ACTUAL_BACKEND_SHA" >&2
  exit 1
fi
if [[ -e "$OUTPUT_APP" ]]; then
  echo "Output already exists: $OUTPUT_APP" >&2
  echo "Move it aside before rebuilding." >&2
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

cp -cR "$ELECTRON_RUNTIME" "$OUTPUT_APP"
CONTENTS="$OUTPUT_APP/Contents"
RESOURCES="$CONTENTS/Resources"
rm -f "$RESOURCES/default_app.asar"
rm -rf "$RESOURCES/bot" "$RESOURCES/node_modules"
mkdir -p "$RESOURCES/bot"
rsync -a --exclude='node_modules' --exclude='package-lock.json' --exclude='package.json' --exclude='README.md' \
  "$PROJECT_DIR/bot-runtime/" "$RESOURCES/bot/"
cp "$PROJECT_DIR/native-farmer/"*.mjs "$RESOURCES/bot/"
cp "$PROJECT_DIR/native-farmer/"*.html "$RESOURCES/bot/"
node "$PROJECT_DIR/scripts/patch-zyn-bot-webhook-brand.cjs" "$RESOURCES/bot"
node "$PROJECT_DIR/scripts/patch-zyn-checkout-webhook.cjs" \
  "$RESOURCES/bot/pbandai-buyer.cjs"
cp -R "$PROJECT_DIR/bot-runtime/node_modules" "$RESOURCES/node_modules"
mkdir -p "$RESOURCES/vendor"
rm -rf "$RESOURCES/engine"
mkdir -p "$RESOURCES/engine"
cp "$NATIVE_BACKEND" "$RESOURCES/engine/backend"
chmod 0755 "$RESOURCES/engine/backend"
rm -rf "$RESOURCES/vendor/ms-playwright-mac" "$RESOURCES/vendor/ms-playwright-mac-arm64"
if [[ "$RUNTIME_MODE" == "bundled" ]]; then
  NATIVE_BROWSER_RUNTIME="$PROJECT_DIR/vendor/ms-playwright-mac-$APP_ARCH"
  if [[ ! -d "$NATIVE_BROWSER_RUNTIME" ]]; then
    echo "Missing native Chromium runtime: $NATIVE_BROWSER_RUNTIME" >&2
    echo "Run ZYN_ARCH=$APP_ARCH node scripts/prepare-native-farmer-runtime.js first." >&2
    exit 1
  fi
  mkdir -p "$RESOURCES/vendor/ms-playwright-mac"
  rsync -a --exclude='chromium_headless_shell-*' \
    "$NATIVE_BROWSER_RUNTIME/" "$RESOURCES/vendor/ms-playwright-mac/"
fi
# Zyn's macOS engine is native and every JavaScript bot reuses Electron as Node. Never add a
# Windows Node, Windows Chromium, or Wine payload to a Zyn build.
rm -rf "$RESOURCES/wine" "$RESOURCES/vendor/ms-playwright"
rm -f "$RESOURCES/vendor/node" "$RESOURCES/vendor/node.exe"
rm -f "$RESOURCES/app-original.asar"
rm -rf "$RESOURCES/app-original.asar.unpacked"
rm -f "$RESOURCES/app-react16-original.asar"
rm -rf "$RESOURCES/app-react16-original.asar.unpacked"
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
  managed-proxy-ipc-guard.js resifactory-client.js resifactory-control.js harvester-extension-bridge.js cloud-backup.js cloud-backup-data.js; do
  cp "$PROJECT_DIR/launcher/$launcher_file" "$RESOURCES/app/$launcher_file"
done
cp "$PROJECT_DIR/launcher/runtime-manager.js" "$RESOURCES/app/runtime-manager.js"
cp "$PROJECT_DIR/launcher/package.json" "$RESOURCES/app/package.json"
mkdir -p "$RESOURCES/app/node_modules"
cp -R "$PROJECT_DIR/launcher/node_modules/." "$RESOURCES/app/node_modules/"

PLIST="$CONTENTS/Info.plist"
CURRENT_EXECUTABLE="$(plutil -extract CFBundleExecutable raw "$PLIST")"
if [[ "$CURRENT_EXECUTABLE" != "Zyn" ]]; then
  mv "$CONTENTS/MacOS/$CURRENT_EXECUTABLE" "$CONTENTS/MacOS/Zyn"
fi
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable Zyn' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.thwebco.zyn' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Zyn' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Zyn' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile Zyn.icns' "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleURLTypes' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string Zyn' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string zyn' "$PLIST"

LEGACY_PREFIX="$(printf '\110\157\160\145')"
for legacy_key in "${LEGACY_PREFIX}ElectronVersion" "${LEGACY_PREFIX}ReactVersion" "${LEGACY_PREFIX}ControlPlaneRelease"; do
  /usr/libexec/PlistBuddy -c "Delete :$legacy_key" "$PLIST" 2>/dev/null || true
done
for key in ZynArchitecture ZynElectronVersion ZynReactVersion ZynRelease ZynRuntimeMode; do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$PLIST" 2>/dev/null || true
done
/usr/libexec/PlistBuddy -c "Add :ZynArchitecture string $APP_ARCH" "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :ZynElectronVersion string 43.3.0' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :ZynReactVersion string 18.3.1' "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ZynRelease string $APP_RELEASE" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ZynRuntimeMode string $RUNTIME_MODE" "$PLIST"

if [[ "$RUNTIME_MODE" == "remote" ]]; then
  # Keep the small architecture-matched backend as an offline fallback. The signed runtime channel
  # installs newer engines side by side and selects them only for future drained engine processes.
  rm -rf "$RESOURCES/vendor/ms-playwright-mac"
fi

rm -f "$RESOURCES/electron.icns"
cp "$PROJECT_DIR/assets/brand/Zyn.icns" "$RESOURCES/Zyn.icns"
node "$PROJECT_DIR/scripts/write-update-config.js" "$OUTPUT_APP" "$APP_ARCH"
LEGACY_RECEIPT="$(printf '\150\157\160\145')-build.json"
rm -f "$RESOURCES/$LEGACY_RECEIPT"
node "$PROJECT_DIR/scripts/write-build-receipt.js" "$OUTPUT_APP" "$APP_RELEASE" "$RUNTIME_MODE"
codesign --force --deep --sign - "$OUTPUT_APP"
node "$PROJECT_DIR/scripts/verify-runtime-contract.js" "$OUTPUT_APP"

echo "$OUTPUT_APP"
