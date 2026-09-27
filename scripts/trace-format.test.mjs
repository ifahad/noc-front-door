import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTrace, formatTrace, parseLogInput } from './lib/trace-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'test', 'fixtures', 'trace-logs.json');

const records = JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('extractTrace keeps only runtime records with the trace id, sorted by ts', () => {
  const entries = extractTrace(records, 't-fix-1');
  assert.deepEqual(
    entries.map((e) => e.evt),
    [
      'kv.op',
      'dv.request',
      'mcp.request',
      'tool.open_ticket',
      'actor.call',
      'dv.late',
    ],
  );
});

test('extractTrace carries hop, outcome, total_ms and key extras', () => {
  const entries = extractTrace(records, 't-fix-1');
  const tool = entries.find((e) => e.evt === 'tool.open_ticket');
  assert.equal(tool.hop, 'tool');
  assert.equal(tool.outcome, 'ok');
  assert.equal(tool.total_ms, 95);
  assert.equal(tool.extras.tool, 'open_ticket');
  assert.equal(tool.extras.status, 200);
  const actor = entries.find((e) => e.evt === 'actor.call');
  assert.equal(actor.extras.site, 'TST-001');
  const late = entries.find((e) => e.evt === 'dv.late');
  assert.equal(late.extras.route_hint, 'site_down');
  assert.equal(late.extras.fault_injected, true);
  assert.equal(late.outcome, 'fallback');
});

test('extractTrace surfaces kv_ms and actor_ms where the lines carry them', () => {
  const entries = extractTrace(records, 't-fix-1');
  const kv = entries.find((e) => e.evt === 'kv.op');
  assert.equal(kv.kv_ms, 1400);
  assert.equal(kv.actor_ms, null);
  const actor = entries.find((e) => e.evt === 'actor.call');
  assert.equal(actor.kv_ms, null);
  assert.equal(actor.actor_ms, 210);
  const tool = entries.find((e) => e.evt === 'tool.open_ticket');
  assert.equal(tool.kv_ms, null);
  assert.equal(tool.actor_ms, null);
});

test('extractTrace misses for an unknown trace id', () => {
  assert.deepEqual(extractTrace(records, 't-absent'), []);
});

test('parseLogInput accepts JSONL as well as a JSON array', () => {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  const parsed = parseLogInput(text);
  assert.equal(parsed.length, records.length);
  assert.deepEqual(
    extractTrace(parsed, 't-fix-1').map((e) => e.evt),
    extractTrace(records, 't-fix-1').map((e) => e.evt),
  );
});

test('formatTrace prints aligned columns, the hop chain and the span', () => {
  const out = formatTrace(extractTrace(records, 't-fix-1'));
  const lines = out.split('\n');
  assert.match(
    lines[0],
    /^ts\s+hop\s+evt\s+outcome\s+total_ms\s+kv_ms\s+actor_ms\s+extras\s*$/,
  );
  const rows = lines.slice(1, -2);
  assert.equal(rows.length, 6);
  for (const row of rows) {
    const cols = row.trim().split(/\s{2,}/);
    assert.ok(cols.length >= 7, `row not aligned: ${row}`);
  }
  assert.ok(rows[0].includes('kv.op'));
  assert.ok(rows[0].includes('1400'));
  const last = rows[rows.length - 1];
  assert.ok(last.includes('dv.late'));
  assert.ok(last.includes('fallback'));
  assert.match(lines.at(-2), /^hops: kv → dv → mcp → tool → actor$/);
  assert.match(lines.at(-1), /^span: 895 ms/);
});

test('formatTrace shows kv and actor ms in their own columns, dash when absent', () => {
  const out = formatTrace(extractTrace(records, 't-fix-1'));
  const lines = out.split('\n');
  const kvRow = lines.find((l) => l.includes('kv.op'));
  const actorRow = lines.find((l) => l.includes('actor.call'));
  const toolRow = lines.find((l) => l.includes('tool.open_ticket'));
  const colsOf = (row) => row.trim().split(/\s{2,}/);
  assert.equal(colsOf(kvRow)[5], '1400');
  assert.equal(colsOf(kvRow)[6], '-');
  assert.equal(colsOf(actorRow)[5], '-');
  assert.equal(colsOf(actorRow)[6], '210');
  assert.equal(colsOf(toolRow)[5], '-');
  assert.equal(colsOf(toolRow)[6], '-');
});

test('CLI pipes stdin into the same output', () => {
  const res = spawnSync(
    process.execPath,
    [join(HERE, 'lib', 'trace-format.mjs'), 't-fix-1'],
    { input: JSON.stringify(records), encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^hops: kv → dv → mcp → tool → actor$/m);
  assert.match(res.stdout, /^span: 895 ms/m);
});

test('CLI exits 1 when no records match the trace id', () => {
  const res = spawnSync(
    process.execPath,
    [join(HERE, 'lib', 'trace-format.mjs'), 't-absent'],
    { input: JSON.stringify(records), encoding: 'utf8' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no records matched/i);
});
