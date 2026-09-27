#!/usr/bin/env bash
set -euo pipefail

TRACE_ID="${1:-}"
if [ -z "$TRACE_ID" ]; then
  echo "usage: scripts/trace.sh <trace_id>   (SINCE=30m overrides the window)" >&2
  exit 2
fi
SINCE="${SINCE:-30m}"
cd "$(dirname "$0")/.."
telnyx-edge logs noc-edge --since "$SINCE" -n 250 --json < /dev/null \
  | node scripts/lib/trace-format.mjs "$TRACE_ID"
