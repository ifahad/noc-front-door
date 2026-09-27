import { readFileSync } from 'node:fs';

const EXTRA_KEYS = ['route_hint', 'tool', 'site', 'status', 'fault_injected'];
const DASH = '-';

export function parseLogInput(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // fall through to JSONL
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // skip lines that are not JSON objects
    }
  }
  return records;
}

function parsedMessage(record) {
  const message = record?.message;
  if (typeof message !== 'string') return null;
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function tsValue(ts) {
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(String(ts));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function msColumn(value) {
  return Number.isFinite(value) ? value : null;
}

export function extractTrace(records, traceId) {
  const entries = [];
  for (const record of records) {
    const message = parsedMessage(record);
    if (message === null || message.trace_id !== traceId) continue;
    const extras = {};
    for (const key of EXTRA_KEYS) {
      if (message[key] !== undefined && message[key] !== null) {
        extras[key] = message[key];
      }
    }
    entries.push({
      ts: message.ts ?? record.ts,
      hop: typeof message.hop === 'string' ? message.hop : DASH,
      evt: typeof message.evt === 'string' ? message.evt : DASH,
      outcome: typeof message.outcome === 'string' ? message.outcome : DASH,
      total_ms: Number.isFinite(message.total_ms) ? message.total_ms : null,
      kv_ms: msColumn(message.kv_ms),
      actor_ms: msColumn(message.actor_ms),
      extras,
    });
  }
  entries.sort((a, b) => {
    const at = tsValue(a.ts);
    const bt = tsValue(b.ts);
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    return at - bt;
  });
  return entries;
}

function pad(column, width) {
  return column.padEnd(width);
}

export function formatTrace(entries) {
  const rows = entries.map((e) => {
    const extras = Object.entries(e.extras)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    return {
      ts: String(e.ts ?? DASH),
      hop: e.hop,
      evt: e.evt,
      outcome: e.outcome,
      total_ms: e.total_ms === null ? DASH : String(e.total_ms),
      kv_ms: e.kv_ms === null || e.kv_ms === undefined ? DASH : String(e.kv_ms),
      actor_ms: e.actor_ms === null || e.actor_ms === undefined ? DASH : String(e.actor_ms),
      extras,
    };
  });
  const header = {
    ts: 'ts',
    hop: 'hop',
    evt: 'evt',
    outcome: 'outcome',
    total_ms: 'total_ms',
    kv_ms: 'kv_ms',
    actor_ms: 'actor_ms',
    extras: 'extras',
  };
  const widths = {};
  for (const key of Object.keys(header)) {
    widths[key] = Math.max(header[key].length, ...rows.map((r) => r[key].length));
  }
  const line = (cells) =>
    Object.keys(header)
      .map((key) => pad(cells[key], widths[key]))
      .join('  ')
      .trimEnd();
  const parts = [line(header), ...rows.map(line)];
  parts.push(`hops: ${hopChain(entries)}`);
  parts.push(`span: ${spanMs(entries)}`);
  return parts.join('\n');
}

function hopChain(entries) {
  const seen = new Set();
  const chain = [];
  for (const entry of entries) {
    if (entry.hop === DASH || seen.has(entry.hop)) continue;
    seen.add(entry.hop);
    chain.push(entry.hop);
  }
  return chain.join(' → ');
}

function spanMs(entries) {
  if (entries.length < 2) return '0 ms';
  const first = tsValue(entries[0].ts);
  const last = tsValue(entries[entries.length - 1].ts);
  if (Number.isNaN(first) || Number.isNaN(last)) return 'unknown';
  return `${Math.max(0, last - first)} ms`;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

async function main() {
  const traceId = process.argv[2];
  if (!traceId) {
    console.error('usage: node scripts/lib/trace-format.mjs <trace_id> [logfile]');
    process.exit(2);
  }
  const file = process.argv[3];
  const text = file ? readFileSync(file, 'utf8') : readStdin();
  let records;
  try {
    records = parseLogInput(text);
  } catch (err) {
    console.error(`error: cannot parse input (${err.message})`);
    process.exit(2);
  }
  const entries = extractTrace(records, traceId);
  if (entries.length === 0) {
    console.error(`no records matched trace_id ${traceId}`);
    process.exit(1);
  }
  console.log(formatTrace(entries));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
