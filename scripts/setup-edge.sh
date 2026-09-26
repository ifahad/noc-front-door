#!/usr/bin/env bash
# Idempotent Edge Compute setup for NOC Front Door (plan 0, task 3).
# Creates/verifies the noc-kv namespace, fills generated .env values,
# and pushes Edge secrets. Secret values are never echoed or logged.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    echo "error: .env not found and no .env.example to copy" >&2
    exit 1
  fi
fi

# Read a value from .env without ever printing it (stdout only via caller).
env_get() {
  node -e '
const fs = require("fs");
const key = process.argv[1];
let value = "";
for (const raw of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line.startsWith(key + "=")) continue;
  value = line.slice(key.length + 1).trim();
  const dq = value.length >= 2 && value.startsWith(String.fromCharCode(34)) && value.endsWith(String.fromCharCode(34));
  const sq = value.length >= 2 && value.startsWith(String.fromCharCode(39)) && value.endsWith(String.fromCharCode(39));
  if (dq || sq) value = value.slice(1, -1);
}
process.stdout.write(value);
' "$1"
}

TELNYX_API_KEY="$(env_get TELNYX_API_KEY)"
if [ -z "$TELNYX_API_KEY" ]; then
  echo "error: TELNYX_API_KEY is empty in .env; paste your Telnyx API key first" >&2
  exit 1
fi

# --- KV namespace -----------------------------------------------------------
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
KV_ID="$(telnyx-edge storage kv list 2>/dev/null | grep 'noc-kv' | grep -oE "$UUID_RE" | head -n 1 || true)"
if [ -z "$KV_ID" ]; then
  echo "creating KV namespace noc-kv"
  telnyx-edge storage kv create --name noc-kv >/dev/null
  KV_ID="$(telnyx-edge storage kv list 2>/dev/null | grep 'noc-kv' | grep -oE "$UUID_RE" | head -n 1 || true)"
fi
if [ -z "$KV_ID" ]; then
  echo "error: noc-kv namespace not found after create" >&2
  exit 1
fi

# Poll readiness: any output containing "pending" means not ready yet.
READY=0
for _ in $(seq 1 20); do
  get_out="$(telnyx-edge storage kv get "$KV_ID" 2>/dev/null || true)"
  if ! grep -qi 'pending' <<<"$get_out"; then
    READY=1
    break
  fi
  sleep 3
done
if [ "$READY" -ne 1 ]; then
  echo "error: noc-kv still pending after 60s" >&2
  exit 1
fi
echo "KV namespace noc-kv ready"

# --- Generated values in .env ------------------------------------------------
MCP_TOKEN="$(env_get MCP_TOKEN)"
if [ -z "$MCP_TOKEN" ]; then
  MCP_TOKEN="$(openssl rand -hex 32)"
fi
OPS_TOKEN="$(env_get OPS_TOKEN)"
if [ -z "$OPS_TOKEN" ]; then
  OPS_TOKEN="$(openssl rand -hex 32)"
fi
PIN_PEPPER="$(env_get PIN_PEPPER)"
if [ -z "$PIN_PEPPER" ]; then
  PIN_PEPPER="$(openssl rand -hex 32)"
fi

TELNYX_PUBLIC_KEY="$(env_get TELNYX_PUBLIC_KEY)"
if [ -z "$TELNYX_PUBLIC_KEY" ]; then
  rc=0
  PK_JSON="$(curl -fsS -H "Authorization: Bearer ${TELNYX_API_KEY}" https://api.telnyx.com/v2/public_key 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "error: failed to fetch Telnyx public key (curl exit $rc)" >&2
    exit 1
  fi
  # Store the PEM single-line with literal \n escapes.
  TELNYX_PUBLIC_KEY="$(node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  const pem = String(parsed?.data?.public ?? "");
  if (!pem) process.exit(1);
  process.stdout.write(pem.split("\n").join("\\n"));
});
' <<<"$PK_JSON")"
fi

# Rewrite .env in place via temp file; values flow through environment only.
MCP_TOKEN="$MCP_TOKEN" \
OPS_TOKEN="$OPS_TOKEN" \
PIN_PEPPER="$PIN_PEPPER" \
NOC_OPS_TOKEN="$OPS_TOKEN" \
TELNYX_PUBLIC_KEY="$TELNYX_PUBLIC_KEY" \
node -e '
const fs = require("fs");
const keys = ["MCP_TOKEN", "OPS_TOKEN", "PIN_PEPPER", "NOC_OPS_TOKEN", "TELNYX_PUBLIC_KEY"];
const text = fs.readFileSync(".env", "utf8");
let out = text;
for (const key of keys) {
  const value = process.env[key];
  if (value === undefined) continue;
  const line = key + "=" + value;
  const re = new RegExp("^" + key + "=.*$", "m");
  if (re.test(out)) out = out.replace(re, line);
  else out = out.replace(/\n*$/, "\n") + line + "\n";
}
fs.writeFileSync(".env.tmp", out);
fs.renameSync(".env.tmp", ".env");
'

# --- Edge secrets -------------------------------------------------------------
for name in TELNYX_PUBLIC_KEY MCP_TOKEN OPS_TOKEN PIN_PEPPER; do
  eval "value=\${$name}"
  rc=0
  add_out="$(telnyx-edge secrets add "$name" "$value" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "error: failed to add secret $name (exit $rc)" >&2
    exit 1
  fi
done

echo "secrets:"
telnyx-edge secrets list
echo "KV_NAMESPACE_ID=$KV_ID"
