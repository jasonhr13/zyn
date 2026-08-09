#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="${POLAR_BACKEND_SOURCE:-$PROJECT_DIR/../polar-backend-source}"
REQUESTED_ARCH="${1:-${ZYN_ARCH:-$(uname -m)}}"

if [[ ! -f "$SOURCE_DIR/go.mod" ]]; then
  echo "Missing polar-backend-source Go module: $SOURCE_DIR" >&2
  exit 1
fi

build_arch() {
  local zyn_arch="$1"
  local go_arch
  case "$zyn_arch" in
    arm64) go_arch="arm64" ;;
    x64|x86_64|amd64) zyn_arch="x64"; go_arch="amd64" ;;
    *) echo "Unsupported Zyn backend architecture: $zyn_arch" >&2; exit 1 ;;
  esac

  local output_dir="$PROJECT_DIR/native-backend/darwin-$zyn_arch"
  local output="$output_dir/backend"
  local temporary
  temporary="$(mktemp "/private/tmp/zyn-native-backend-$zyn_arch.XXXXXX")"
  trap 'rm -f "$temporary"' RETURN

  mkdir -p "$output_dir"
  (
    cd "$SOURCE_DIR"
    env GOOS=darwin GOARCH="$go_arch" CGO_ENABLED=0 \
      go build -tags zyn -trimpath -ldflags "-s -w" -o "$temporary" ./cmd/zyn-engine
  )
  chmod 0755 "$temporary"
  mv "$temporary" "$output"
  trap - RETURN

  local description
  description="$(file -b "$output")"
  if [[ "$go_arch" == "arm64" && "$description" != *"arm64"* ]]; then
    echo "Native backend architecture check failed: $description" >&2
    exit 1
  fi
  if [[ "$go_arch" == "amd64" && "$description" != *"x86_64"* ]]; then
    echo "Native backend architecture check failed: $description" >&2
    exit 1
  fi
  echo "$output"
}

install_dev_backend() {
  local host_arch
  case "$(uname -m)" in
    arm64) host_arch="arm64" ;;
    x86_64) host_arch="x64" ;;
    *) return ;;
  esac
  local source="$PROJECT_DIR/native-backend/darwin-$host_arch/backend"
  if [[ ! -x "$source" ]]; then return; fi
  local destination="$PROJECT_DIR/extracted/asar/backend/backend"
  mkdir -p "$(dirname "$destination")"
  cp "$source" "$destination"
  chmod 0755 "$destination"
}

if [[ "$REQUESTED_ARCH" == "all" ]]; then
  build_arch arm64
  build_arch x64
else
  build_arch "$REQUESTED_ARCH"
fi

install_dev_backend
