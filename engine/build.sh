#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-polarBackend}"
OUT_DIR="${OUT_DIR:-dist}"
MAIN_PKG="${MAIN_PKG:-.}"
USE_GARBLE="${USE_GARBLE:-1}"

# Obfuscate only this module; dependencies are left readable for compatibility.
export GOGARBLE="${GOGARBLE:-zynbot.app/engine}"

mkdir -p "$OUT_DIR"

if [[ "$USE_GARBLE" == "1" ]]; then
  if ! command -v garble >/dev/null 2>&1; then
    echo "garble not found. Install a Go 1.24-compatible release:"
    echo "  go install mvdan.cc/garble@v0.15.0"
    echo "Or build without obfuscation:"
    echo "  USE_GARBLE=0 $0"
    exit 1
  fi
  BUILD_CMD=(garble -literals -tiny build -trimpath)
else
  BUILD_CMD=(go build -trimpath -ldflags="-s -w")
fi

echo "Building $APP_NAME into $OUT_DIR"
if [[ "$USE_GARBLE" == "1" ]]; then
  echo "Using garble: $(garble version | head -n1)"
fi

build_target() {
  local goos="$1"
  local goarch="$2"
  local ext="$3"
  local output="$OUT_DIR/${APP_NAME}-${goos}-${goarch}-v0.0.0${ext}"

  echo " -> $goos/$goarch"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" "${BUILD_CMD[@]}" -o "$output" "$MAIN_PKG"
}

# macOS (both architectures)
# Intel Macs
build_target darwin amd64 ""
# Apple Silicon (M1/M2/M3)
build_target darwin arm64 ""

# Windows
build_target windows amd64 ".exe"

echo "Done."
echo "Artifacts:"
ls -1 "$OUT_DIR"
