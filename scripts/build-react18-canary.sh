#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_APP="${HOPE_REACT18_BASE_APP:-$PROJECT_DIR/dist/Hope-Electron43.app}"
OUTPUT_APP="${HOPE_REACT18_OUTPUT_APP:-$PROJECT_DIR/dist/Hope-Electron43-React18.app}"
CONTROL_PLANE_RELEASE="${HOPE_CONTROL_PLANE_RELEASE:-R0}"
ASAR_BIN="$PROJECT_DIR/frontend/node_modules/.bin/asar"
TEMP_DIR="$(mktemp -d /private/tmp/hope-react18-build.XXXXXX)"

cleanup() {
  if [[ -n "$TEMP_DIR" && "$TEMP_DIR" == /private/tmp/hope-react18-build.* ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ ! -d "$BASE_APP" ]]; then
  echo "Missing Electron 43 base app: $BASE_APP" >&2
  exit 1
fi
if [[ ! -x "$ASAR_BIN" ]]; then
  echo "Missing ASAR packer. Run npm install in frontend/ first." >&2
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

cp -cR "$PROJECT_DIR/extracted/asar" "$TEMP_DIR/app"
mv "$TEMP_DIR/app/build" "$TEMP_DIR/app/build-react16-original"
cp -R "$PROJECT_DIR/frontend/build" "$TEMP_DIR/app/build"
node "$PROJECT_DIR/scripts/verify-native-farmer-upstream.js"
cp "$PROJECT_DIR/native-farmer/runtime-paths.js" "$TEMP_DIR/app/public/helpers/runtime-paths.js"
node "$PROJECT_DIR/scripts/patch-profile-imap-engines.js" "$TEMP_DIR/app/public/helpers"

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.dependencies.react = "18.3.1";
  pkg.dependencies["react-dom"] = "18.3.1";
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$TEMP_DIR/app/package.json"

"$ASAR_BIN" pack "$TEMP_DIR/app" "$TEMP_DIR/app-original.asar" \
  --unpack-dir node_modules/node-notifier

cp -cR "$BASE_APP" "$OUTPUT_APP"
RESOURCES="$OUTPUT_APP/Contents/Resources"
NATIVE_BROWSER_RUNTIME="$PROJECT_DIR/vendor/ms-playwright-mac-arm64"
if [[ ! -d "$NATIVE_BROWSER_RUNTIME" ]]; then
  echo "Missing native Chromium runtime: $NATIVE_BROWSER_RUNTIME" >&2
  echo "Run node scripts/prepare-native-farmer-runtime.js first." >&2
  exit 1
fi
cp "$PROJECT_DIR/native-farmer/"*.mjs "$RESOURCES/bot/"
rm -rf "$RESOURCES/vendor/ms-playwright-mac-arm64"
cp -R "$NATIVE_BROWSER_RUNTIME" "$RESOURCES/vendor/ms-playwright-mac-arm64"
mv "$RESOURCES/app-original.asar" "$RESOURCES/app-react16-original.asar"
mv "$RESOURCES/app-original.asar.unpacked" "$RESOURCES/app-react16-original.asar.unpacked"
cp "$TEMP_DIR/app-original.asar" "$RESOURCES/app-original.asar"
cp -R "$TEMP_DIR/app-original.asar.unpacked" "$RESOURCES/app-original.asar.unpacked"
cp "$PROJECT_DIR/launcher/bootstrap.js" "$RESOURCES/app/bootstrap.js"
cp "$PROJECT_DIR/launcher/feature-flags.js" "$RESOURCES/app/feature-flags.js"
cp "$PROJECT_DIR/launcher/license-client.js" "$RESOURCES/app/license-client.js"
cp "$PROJECT_DIR/launcher/license-authority.js" "$RESOURCES/app/license-authority.js"
cp "$PROJECT_DIR/launcher/license-observer.js" "$RESOURCES/app/license-observer.js"
cp "$PROJECT_DIR/launcher/task-type-access.js" "$RESOURCES/app/task-type-access.js"
cp "$PROJECT_DIR/launcher/task-type-ipc-guard.js" "$RESOURCES/app/task-type-ipc-guard.js"
cp "$PROJECT_DIR/launcher/task-group-store.js" "$RESOURCES/app/task-group-store.js"
cp "$PROJECT_DIR/launcher/window-size-state.js" "$RESOURCES/app/window-size-state.js"
cp "$PROJECT_DIR/launcher/imap-password.js" "$RESOURCES/app/imap-password.js"
cp "$PROJECT_DIR/launcher/imap-connection.js" "$RESOURCES/app/imap-connection.js"
cp "$PROJECT_DIR/launcher/profile-imap-control.js" "$RESOURCES/app/profile-imap-control.js"
cp "$PROJECT_DIR/launcher/managed-proxy-control.js" "$RESOURCES/app/managed-proxy-control.js"
cp "$PROJECT_DIR/launcher/managed-proxy-ipc-guard.js" "$RESOURCES/app/managed-proxy-ipc-guard.js"
cp -R "$PROJECT_DIR/launcher/node_modules" "$RESOURCES/app/node_modules"

PLIST="$OUTPUT_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :HopeReactVersion' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :HopeReactVersion string 18.3.1' "$PLIST"
/usr/libexec/PlistBuddy -c 'Delete :HopeControlPlaneRelease' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :HopeControlPlaneRelease string $CONTROL_PLANE_RELEASE" "$PLIST"
node "$PROJECT_DIR/scripts/write-build-receipt.js" "$OUTPUT_APP" "$CONTROL_PLANE_RELEASE"
codesign --force --deep --sign - "$OUTPUT_APP"
node "$PROJECT_DIR/scripts/verify-runtime-contract.js" "$OUTPUT_APP"

echo "$OUTPUT_APP"
