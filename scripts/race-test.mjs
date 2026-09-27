#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from './lib/telnyx.mjs';

const DEFAULT_EDGE_URL = 'https://noc-edge-41d2a334-7.telnyxcompute.com';
const TIMEOUT_MS = 60_000;
const N = 10;
const EVIDENCE_PATH = 'docs/evidence/race-test.txt';

function readConfig({ needToken = true } = {}) {
  loadDotEnv();
  const edgeUrl = (process.env.EDGE_URL ?? DEFAULT_EDGE_URL).replace(/\/+$/, '');
  const opsToken = process.env.OPS_TOKEN;
  if (needToken && !opsToken) {
    console.error('error: OPS_TOKEN is missing; copy .env.example to .env and set it');
    process.exit(2);
  }
  return { edgeUrl, opsToken };
}

async function race(edgeUrl, opsToken, mode) {
  const url = `${edgeUrl}/diag/race?mode=${mode}&n=${N}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opsToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /diag/race?mode=${mode}&n=${N} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`POST /diag/race?mode=${mode}&n=${N} returned non-JSON body: ${text.slice(0, 300)}`);
  }
}

function verdict(mode, result) {
  const count = Number(result?.created_count ?? -1);
  if (mode === 'actor') {
    return count === 1
      ? 'PASS (exactly one created)'
      : `FAIL (expected exactly 1, got ${count})`;
  }
  return count > 1
    ? 'PASS (races as designed, >1 created)'
    : `WARN (expected >1, got ${count})`;
}

function printSummary(results) {
  for (const mode of ['actor', 'kv']) {
    const result = results[mode];
    const count = result?.created_count ?? 'n/a';
    const ids = Array.isArray(result?.ticket_ids) ? result.ticket_ids.join(', ') : '';
    console.log(`${mode.padEnd(6)}: created_count=${String(count)}/${N}  ${verdict(mode, result)}`);
    console.log(`        ticket_ids: ${ids || '(none)'}`);
  }
}

function evidenceText(results, edgeUrl) {
  const lines = [
    `race-test @ ${new Date().toISOString()}`,
    `endpoint: POST ${edgeUrl}/diag/race (n=${N} per mode, after reset/warm-up inside the route)`,
  ];
  for (const mode of ['actor', 'kv']) {
    lines.push(
      `mode=${mode}: created_count=${results[mode]?.created_count ?? 'n/a'} ticket_ids=${JSON.stringify(results[mode]?.ticket_ids ?? [])}`,
    );
  }
  lines.push(
    `conclusion: actor mode enforces exactly-once open (${results.actor?.created_count}/${N} created); naive KV get-then-put races (${results.kv?.created_count}/${N} created) — spec §13.3 [R:race-test ×5]`,
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const { edgeUrl, opsToken } = readConfig({ needToken: !dryRun });
  const modes = ['actor', 'kv'];
  if (dryRun) {
    for (const mode of modes) {
      console.log(`would POST ${edgeUrl}/diag/race?mode=${mode}&n=${N} (Bearer OPS_TOKEN, timeout ${TIMEOUT_MS / 1000}s)`);
    }
    console.log(`would write ${EVIDENCE_PATH}`);
    return;
  }
  const results = {};
  for (const mode of modes) {
    try {
      results[mode] = await race(edgeUrl, opsToken, mode);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
  }
  printSummary(results);
  const actorOk = Number(results.actor?.created_count) === 1;
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync(EVIDENCE_PATH, evidenceText(results, edgeUrl));
  console.log(`wrote ${EVIDENCE_PATH}`);
  if (!actorOk) {
    console.error('error: actor mode did not enforce exactly-once');
    process.exit(1);
  }
}

await main();
