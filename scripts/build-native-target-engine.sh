#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${ZYN_ENGINE_SOURCE:-${POLAR_BACKEND_SOURCE:-$PROJECT_DIR/engine}}"
REQUESTED_ARCH="${1:-${ZYN_ARCH:-$(uname -m)}}"
USE_GARBLE="${USE_GARBLE:-1}"
GARBLE_VERSION="${ZYN_GARBLE_VERSION:-v0.16.0}"
GARBLE_BIN="${GARBLE_BIN:-}"

resolve_garble() {
  if [[ "$USE_GARBLE" != "1" ]]; then
    return
  fi
  if [[ -n "$GARBLE_BIN" && -x "$GARBLE_BIN" ]]; then
    return
  fi
  if command -v garble >/dev/null 2>&1; then
    GARBLE_BIN="$(command -v garble)"
    return
  fi
  local gobin
  gobin="$(go env GOPATH)/bin/garble"
  if [[ ! -x "$gobin" ]]; then
    echo "Installing garble ${GARBLE_VERSION} for production engine obfuscation..."
    env GOBIN="$(go env GOPATH)/bin" go install "mvdan.cc/garble@${GARBLE_VERSION}"
  fi
  GARBLE_BIN="$gobin"
  if [[ ! -x "$GARBLE_BIN" ]]; then
    echo "garble is not available. Install it with: go install mvdan.cc/garble@${GARBLE_VERSION}" >&2
    echo "Or build without obfuscation: USE_GARBLE=0 $0" >&2
    exit 1
  fi
}

resolve_garble

if [[ ! -f "$SOURCE_DIR/go.mod" ]]; then
  echo "Missing Zyn engine Go module: $SOURCE_DIR" >&2
  exit 1
fi

(
  cd "$SOURCE_DIR"
  go test ./...
  go test -tags zyn ./...
)

build_arch() {
  local zyn_arch="$1"
  local go_arch
  local go_os="darwin"
  local executable="backend"
  case "$zyn_arch" in
    arm64) go_arch="arm64" ;;
    x64|x86_64|amd64) zyn_arch="x64"; go_arch="amd64" ;;
    windows|windows-x64|win-x64)
      zyn_arch="windows-x64"
      go_os="windows"
      go_arch="amd64"
      executable="backend.exe"
      ;;
    *) echo "Unsupported Zyn backend architecture: $zyn_arch" >&2; exit 1 ;;
  esac

  local output_dir
  if [[ "$go_os" == "windows" ]]; then
    output_dir="$PROJECT_DIR/native-backend/$zyn_arch"
  else
    output_dir="$PROJECT_DIR/native-backend/darwin-$zyn_arch"
  fi
  local output="$output_dir/$executable"
  local temporary
  temporary="$(mktemp "/private/tmp/zyn-native-backend-$zyn_arch.XXXXXX")"
  trap 'rm -f "$temporary"' RETURN

  mkdir -p "$output_dir"
  if [[ "$USE_GARBLE" == "1" ]]; then
    echo "Obfuscating native engine with $($GARBLE_BIN version | head -n1)"
  fi
  (
    cd "$SOURCE_DIR"
    if [[ "$USE_GARBLE" == "1" ]]; then
      export GOGARBLE="${GOGARBLE:-zynbot.app/engine}"
      env GOOS="$go_os" GOARCH="$go_arch" CGO_ENABLED=0 \
        "$GARBLE_BIN" -literals -tiny -seed=random build -tags zyn -trimpath -o "$temporary" ./cmd/zyn-engine
    else
      env GOOS="$go_os" GOARCH="$go_arch" CGO_ENABLED=0 \
        go build -tags zyn -trimpath -ldflags "-s -w" -o "$temporary" ./cmd/zyn-engine
    fi
  )
  chmod 0755 "$temporary"
  mv "$temporary" "$output"
  node "$PROJECT_DIR/scripts/verify-zyn-native-webhook-brand.cjs" "$output"
  trap - RETURN

  local description
  description="$(file -b "$output")"
  if [[ "$go_os" == "windows" && "$description" != *"PE32+"* ]]; then
    echo "Native backend platform check failed: $description" >&2
    exit 1
  fi
  if [[ "$go_os" == "darwin" && "$go_arch" == "arm64" && "$description" != *"arm64"* ]]; then
    echo "Native backend architecture check failed: $description" >&2
    exit 1
  fi
  if [[ "$go_arch" == "amd64" && "$description" != *"x86-64"* && "$description" != *"x86_64"* ]]; then
    echo "Native backend architecture check failed: $description" >&2
    exit 1
  fi
  echo "$output"
}

if [[ "$REQUESTED_ARCH" == "all" ]]; then
  build_arch arm64
  build_arch x64
  build_arch windows-x64
else
  build_arch "$REQUESTED_ARCH"
fi
