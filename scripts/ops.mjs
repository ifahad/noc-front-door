#!/usr/bin/env node
// ops.mjs <METHOD> <path> [json] — one-off /ops/* helper for the runbook.
// Reads .env itself; the OPS_TOKEN only goes into the Authorization header and
// is never printed, logged or echoed (the output is scrubbed before printing).
import { loadDotEnv } from './lib/telnyx.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULT_EDGE_URL = 'https://noc-edge-41d2a334-7.telnyxcompute.com';
const TIMEOUT_MS = 30_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function parseArgs(argv) {
  if (argv.length < 2) {
    return { error: 'usage: scripts/ops.mjs <METHOD> <path> [json]' };
  }
  const [methodRaw, pathRaw, bodyRaw] = argv;
  const method = String(methodRaw).toUpperCase();
  if (!METHODS.has(method)) {
    return { error: `error: METHOD must be one of ${[...METHODS].join(', ')} (got ${methodRaw})` };
  }
  const path = String(pathRaw);
  if (!path.startsWith('/')) {
    return { error: 'error: path must start with / (e.g. /ops/health/deep)' };
  }
  let body;
  if (bodyRaw !== undefined) {
    try {
      body = JSON.parse(bodyRaw);
    } catch (err) {
      return { error: `error: [json] is not valid JSON: ${err.message}` };
    }
    if (body === null || typeof body !== 'object') {
      return { error: 'error: [json] must be a JSON object or array' };
    }
    if (method === 'GET') {
      return { error: 'error: GET takes no [json] body' };
    }
  }
  return body === undefined ? { method, path } : { method, path, body };
}

export function edgeUrl(env) {
  return String(env.EDGE_URL ?? DEFAULT_EDGE_URL).replace(/\/+$/, '');
}

export function formatOutput(status, text, secrets = []) {
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    body = text;
  }
  let out = `HTTP ${status}\n${body}`;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }
  loadDotEnv();
  const opsToken = process.env.OPS_TOKEN;
  if (!opsToken) {
    console.error('error: OPS_TOKEN is missing; copy .env.example to .env and set it');
    process.exit(2);
  }
  const base = edgeUrl(process.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}${parsed.path}`, {
      method: parsed.method,
      headers: {
        authorization: `Bearer ${opsToken}`,
        ...(parsed.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: parsed.body === undefined ? undefined : JSON.stringify(parsed.body),
      signal: controller.signal,
    });
  } catch (err) {
    const detail = controller.signal.aborted
      ? `timeout after ${TIMEOUT_MS} ms`
      : String(err?.cause?.message ?? err?.message ?? err);
    console.error(`error: ${parsed.method} ${parsed.path} failed: ${detail}`);
    process.exit(1);
    return;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  console.log(formatOutput(res.status, text, [opsToken]));
  process.exit(res.ok ? 0 : 1);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await main();
}
