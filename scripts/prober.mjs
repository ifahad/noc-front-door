#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { loadDotEnv } from './lib/telnyx.mjs';
import { createProber } from './lib/prober-core.mjs';

const DEFAULT_EDGE_URL = 'https://noc-edge-41d2a334-7.telnyxcompute.com';
const PROBE_TIMEOUT_MS = 8000;
const SUMMARY_MS = 60_000;

function parseArgs(argv) {
  const args = { once: false, interval: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') {
      args.once = true;
    } else if (arg === '--interval') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        console.error('error: --interval needs a value in seconds');
        process.exit(2);
      }
      args.interval = raw;
      i += 1;
    } else if (arg.startsWith('--interval=')) {
      args.interval = arg.slice('--interval='.length);
    } else {
      console.error(`error: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  args.interval = Number(args.interval);
  if (!Number.isFinite(args.interval) || args.interval <= 0) {
    console.error('error: --interval must be a positive number of seconds');
    process.exit(2);
  }
  return args;
}

function readConfig() {
  loadDotEnv();
  const edgeUrl = (process.env.EDGE_URL ?? DEFAULT_EDGE_URL).replace(/\/+$/, '');
  const opsToken = process.env.OPS_TOKEN;
  if (!opsToken) {
    console.error('error: OPS_TOKEN is missing; copy .env.example to .env and set it');
    process.exit(2);
  }
  return { edgeUrl, opsToken };
}

async function probe(edgeUrl, opsToken) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${edgeUrl}/ops/health/deep`, {
      method: 'GET',
      headers: { authorization: `Bearer ${opsToken}` },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const ok = res.ok && body?.ok === true;
    const degraded = body?.degraded === true;
    const slow = Array.isArray(body?.slow) ? body.slow.map(String) : [];
    const detail = ok ? null : `http ${res.status}${body?.ok === false ? ' (ok:false)' : ''}`;
    return { ok, ms: Date.now() - started, degraded, slow, detail };
  } catch (err) {
    const detail = controller.signal.aborted
      ? `timeout after ${PROBE_TIMEOUT_MS} ms`
      : String(err?.cause?.message ?? err?.message ?? err);
    return { ok: false, ms: Date.now() - started, degraded: false, slow: [], detail };
  } finally {
    clearTimeout(timer);
  }
}

function notify(title, body) {
  execFile('notify-send', [title, body], () => {});
}

function banner(edgeUrl, threshold, result) {
  const rule = '='.repeat(66);
  console.log(rule);
  console.log(` ALERT ${new Date().toISOString()} — noc-edge DOWN`);
  console.log(` ${threshold} consecutive failed probes of GET ${edgeUrl}/ops/health/deep`);
  console.log(` last failure: ${result.detail ?? 'unknown'}`);
  console.log(rule);
  notify('NOC Front Door: noc-edge DOWN', `deep health failing: ${result.detail ?? 'unknown'}`);
}

async function once(edgeUrl, opsToken) {
  const result = await probe(edgeUrl, opsToken);
  const prober = createProber({ failThreshold: 1 });
  const { state } = prober.observe(result);
  const slow = result.slow.length ? ` slow=[${result.slow.join(',')}]` : '';
  const degraded = result.degraded ? ' degraded' : '';
  console.log(`probe ok=${result.ok}${degraded} ms=${result.ms}${slow}${result.detail ? ` detail=${result.detail}` : ''}`);
  process.exit(state === 'down' ? 1 : 0);
}

async function loop(edgeUrl, opsToken, intervalSec) {
  const threshold = 2;
  const prober = createProber({ failThreshold: threshold });
  const intervalMs = intervalSec * 1000;
  console.log(
    `prober: GET ${edgeUrl}/ops/health/deep every ${intervalSec}s (timeout ${PROBE_TIMEOUT_MS / 1000}s, alert after ${threshold} consecutive failures)`,
  );
  let lastResult = null;
  let lastSummaryAt = Date.now();
  const window = { probes: 0, ok: 0, degraded: 0, failed: 0, slowSeen: new Set() };

  const summarize = () => {
    const slow = window.slowSeen.size > 0 ? ` slow=[${[...window.slowSeen].join(',')}]` : '';
    console.log(
      `[summary ${new Date().toISOString()}] probes=${window.probes} ok=${window.ok} degraded=${window.degraded} failed=${window.failed}${slow} state=${prober.state} last_ms=${lastResult?.ms ?? '-'} last=${lastResult?.ok ? 'ok' : 'fail'}`,
    );
    window.probes = 0;
    window.ok = 0;
    window.degraded = 0;
    window.failed = 0;
    window.slowSeen.clear();
    lastSummaryAt = Date.now();
  };

  const tick = async () => {
    const result = await probe(edgeUrl, opsToken);
    lastResult = result;
    const { alert } = prober.observe(result);
    window.probes += 1;
    if (result.ok && result.degraded) {
      window.degraded += 1;
      for (const s of result.slow) window.slowSeen.add(s);
    } else if (result.ok) {
      window.ok += 1;
    } else {
      window.failed += 1;
    }
    if (alert === 'down') {
      banner(edgeUrl, threshold, result);
    } else if (alert === 'recovered') {
      console.log(`[recovered ${new Date().toISOString()}] deep health is answering again`);
    }
    if (Date.now() - lastSummaryAt >= SUMMARY_MS) summarize();
  };

  let running = false;
  const guardedTick = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  };

  await guardedTick();
  setInterval(guardedTick, intervalMs);
}

const args = parseArgs(process.argv.slice(2));
const { edgeUrl, opsToken } = readConfig();
if (args.once) {
  await once(edgeUrl, opsToken);
} else {
  await loop(edgeUrl, opsToken, args.interval);
}
