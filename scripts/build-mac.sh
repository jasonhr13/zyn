#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_APP="$PROJECT_DIR/extracted/app"
HOPE_ELECTRON_VERSION="${HOPE_ELECTRON_VERSION:-19.0.10}"
ELECTRON_APP="$PROJECT_DIR/vendor/electron-v${HOPE_ELECTRON_VERSION}-darwin-arm64/Electron.app"
WINE_ROOT="/Applications/Wine Stable.app/Contents/Resources/wine"
OUTPUT_APP="${HOPE_OUTPUT_APP:-$PROJECT_DIR/dist/Hope.app}"

if [[ ! -f "$SOURCE_APP/resources/app.asar" ]]; then
  echo "Missing extracted Electron application at: $SOURCE_APP" >&2
  exit 1
fi
if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "Missing Electron $HOPE_ELECTRON_VERSION runtime at: $ELECTRON_APP" >&2
  exit 1
fi
if [[ ! -x "$WINE_ROOT/bin/wine" ]]; then
  echo "Missing Wine runtime at: $WINE_ROOT" >&2
  exit 1
fi
if [[ -e "$OUTPUT_APP" ]]; then
  echo "Output already exists: $OUTPUT_APP" >&2
  echo "Move it aside before rebuilding." >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/dist"
cp -R "$ELECTRON_APP" "$OUTPUT_APP"

CONTENTS="$OUTPUT_APP/Contents"
RESOURCES="$CONTENTS/Resources"

mv "$CONTENTS/MacOS/Electron" "$CONTENTS/MacOS/Hope"
mkdir -p "$RESOURCES/app"
cp "$PROJECT_DIR/launcher/package.json" "$RESOURCES/app/package.json"
cp "$PROJECT_DIR/launcher/bootstrap.js" "$RESOURCES/app/bootstrap.js"
cp "$PROJECT_DIR/launcher/feature-flags.js" "$RESOURCES/app/feature-flags.js"
cp "$PROJECT_DIR/launcher/license-client.js" "$RESOURCES/app/license-client.js"
cp "$PROJECT_DIR/launcher/license-authority.js" "$RESOURCES/app/license-authority.js"
cp "$PROJECT_DIR/launcher/license-observer.js" "$RESOURCES/app/license-observer.js"
cp "$PROJECT_DIR/launcher/task-group-store.js" "$RESOURCES/app/task-group-store.js"
cp "$PROJECT_DIR/launcher/window-size-state.js" "$RESOURCES/app/window-size-state.js"

cp "$SOURCE_APP/resources/app.asar" "$RESOURCES/app-original.asar"
if [[ -d "$SOURCE_APP/resources/app.asar.unpacked" ]]; then
  cp -R "$SOURCE_APP/resources/app.asar.unpacked" "$RESOURCES/app-original.asar.unpacked"
fi

for resource in app-update.yml bot engine node_modules vendor; do
  if [[ -e "$SOURCE_APP/resources/$resource" ]]; then
    cp -R "$SOURCE_APP/resources/$resource" "$RESOURCES/$resource"
  fi
done

# The original cross-platform path abstraction asks for extensionless names on
# macOS. These symlinks make its existence checks pass; bootstrap.js then sends
# those exact Windows executables through Wine.
ln -s backend.exe "$RESOURCES/engine/backend"
ln -s node.exe "$RESOURCES/vendor/node"

# Keep the complete WineHQ runtime inside Hope.app. Its relative lib/share
# layout is significant, so copy the tree without flattening it.
cp -R "$WINE_ROOT" "$RESOURCES/wine"

PLIST="$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable Hope' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.hope.macos' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Hope' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Hope' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleShortVersionString 1.6.74' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion 1.6.74' "$PLIST"
/usr/libexec/PlistBuddy -c "Add :HopeElectronVersion string $HOPE_ELECTRON_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes array' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0 dict' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLName string Hope' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string hope' "$PLIST"

# The upstream Electron archive is ad-hoc signed. Renaming its main executable
# and adding resources invalidates that seal, so sign the finished local bundle.
codesign --force --deep --sign - "$OUTPUT_APP"

echo "$OUTPUT_APP"
