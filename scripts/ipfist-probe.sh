#!/bin/bash
# Local IPFist residential probe. Does not save the key.
# Usage:
#   IPFIST_API_KEY='ak_…' ./scripts/ipfist-probe.sh
#   ./scripts/ipfist-probe.sh 'ak_…'

set -euo pipefail

KEY="${IPFIST_API_KEY:-${1:-}}"
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]' | sed -E 's/^Bearer//I')"
if [[ ! "$KEY" =~ ^ak_ ]]; then
  echo "Pass a residential key: IPFIST_API_KEY='ak_…' $0" >&2
  exit 1
fi

BASE="${IPFIST_API_BASE:-https://ipfist.com}"

call() {
  local label="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"
  echo
  echo "======== $label ========"
  echo "$method $path"
  if [[ -n "$body" ]]; then
    curl -sS -D /tmp/ipfist-probe-headers.txt \
      -X "$method" \
      -H "Authorization: Bearer $KEY" \
      -H "Accept: application/json, text/plain" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$BASE$path" | python3 -c 'import sys; raw=sys.stdin.read();
try:
  import json; print(json.dumps(json.loads(raw), indent=2, ensure_ascii=False))
except Exception:
  print(raw)'
  else
    curl -sS -D /tmp/ipfist-probe-headers.txt \
      -X "$method" \
      -H "Authorization: Bearer $KEY" \
      -H "Accept: application/json, text/plain" \
      "$BASE$path" | python3 -c 'import sys; raw=sys.stdin.read();
try:
  import json; print(json.dumps(json.loads(raw), indent=2, ensure_ascii=False))
except Exception:
  print(raw)'
  fi
  echo
  echo "-- headers --"
  awk 'BEGIN{IGNORECASE=1} /^(HTTP\/|content-type:|www-authenticate:)/ {print}' /tmp/ipfist-probe-headers.txt
}

call "bandwidth" GET "/api/ProxyLogic/BandwidthAnalysis"
call "config basic" GET "/api/ProxyLogic/GetProxyConfig?mealType=basic&pool=0"
call "config premium" GET "/api/ProxyLogic/GetProxyConfig?mealType=premium&pool=0"
call "plan basic" GET "/api/DynamicPlan/GetPlanByMealType?mealType=basic"
call "plan premium" GET "/api/DynamicPlan/GetPlanByMealType?mealType=premium"
