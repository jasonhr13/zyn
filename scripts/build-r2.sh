#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

export HOPE_REACT18_BASE_APP="${HOPE_REACT18_BASE_APP:-$PROJECT_DIR/dist/Hope-Electron43.app}"
export HOPE_REACT18_OUTPUT_APP="${HOPE_REACT18_OUTPUT_APP:-$PROJECT_DIR/dist/Hope-ControlPlane-R2.app}"
export HOPE_CONTROL_PLANE_RELEASE=R2

exec "$PROJECT_DIR/scripts/build-react18-canary.sh"
