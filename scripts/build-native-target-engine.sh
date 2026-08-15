#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${ZYN_ENGINE_SOURCE:-${POLAR_BACKEND_SOURCE:-$PROJECT_DIR/engine}}"
REQUESTED_ARCH="${1:-${ZYN_ARCH:-$(uname -m)}}"

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
  (
    cd "$SOURCE_DIR"
    env GOOS="$go_os" GOARCH="$go_arch" CGO_ENABLED=0 \
      go build -tags zyn -trimpath -ldflags "-s -w" -o "$temporary" ./cmd/zyn-engine
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
