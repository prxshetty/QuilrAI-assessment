#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT=${PORT:-3030}
PRIMARY_PORT=${PRIMARY_PORT:-4020}
SECONDARY_PORT=${SECONDARY_PORT:-4021}
WORKDIR=$(mktemp -d)
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

MOCK_PORT=$PRIMARY_PORT MOCK_STATUS=500 \
MOCK_BODY='{"error":{"message":"primary exploded","stack":"Error: boom at secret.js:1","secret":"sk-live-DEMO"}}' \
npx tsx src/mock-upstream.ts >/dev/null 2>&1 &
PIDS+=($!)

MOCK_PORT=$SECONDARY_PORT MOCK_STATUS=200 \
MOCK_BODY='{"choices":[{"message":{"content":"hello from the secondary"}}]}' \
npx tsx src/mock-upstream.ts >/dev/null 2>&1 &
PIDS+=($!)

PORT=$PORT DB_PATH="$WORKDIR/usage.sqlite" \
PRIMARY_URL="http://127.0.0.1:$PRIMARY_PORT/v1/chat/completions" \
SECONDARY_URL="http://127.0.0.1:$SECONDARY_PORT/v1/chat/completions" \
npx tsx src/index.ts >/dev/null 2>&1 &
PIDS+=($!)

sleep 2

request() {
  local label=$1
  local max_tokens=$2

  echo "== $label =="
  curl -sS -i "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H 'authorization: Bearer demo-key' \
    -H 'content-type: application/json' \
    --data "{\"prompt\":\"hello\",\"max_tokens\":$max_tokens}" |
    awk 'BEGIN { IGNORECASE = 1 }
      /^HTTP\// { print; next }
      /^retry-after:/ { print; next }
      /^x-request-id:/ { print "x-request-id: <request-id>"; next }
      /^\{/ { print; next }
      /^\r?$/ { next }'
  echo
}

request "failover to secondary" 100
request "first large reservation" 30000
request "second large reservation (rate limited)" 30000