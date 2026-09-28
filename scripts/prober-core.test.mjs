import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiErrorMessage,
  classifyProbe,
  createPagingHealth,
  createProber,
  planPaging,
} from './lib/prober-core.mjs';

const OK = { ok: true, ms: 1200, at: 0 };
const FAIL = { ok: false, ms: 1200, at: 0 };
const TIMEOUT = { ok: true, ms: 8001, at: 0 };

test('starts ok with no alert', () => {
  const prober = createProber();
  assert.equal(prober.state, 'ok');
  const r = prober.observe(OK);
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, null);
});

test('one failure stays ok below the threshold', () => {
  const prober = createProber();
  const r = prober.observe(FAIL);
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, null);
});

test('two consecutive failures raise the down alert exactly once', () => {
  const prober = createProber();
  prober.observe(FAIL);
  const r = prober.observe(FAIL);
  assert.equal(r.state, 'down');
  assert.equal(r.alert, 'down');
  const again = prober.observe(FAIL);
  assert.equal(again.state, 'down');
  assert.equal(again.alert, null);
});

test('first success after down alerts recovered once', () => {
  const prober = createProber();
  prober.observe(FAIL);
  prober.observe(FAIL);
  const r = prober.observe(OK);
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, 'recovered');
  const after = prober.observe(OK);
  assert.equal(after.state, 'ok');
  assert.equal(after.alert, null);
});

test('a single failure does not survive an interleaved success', () => {
  const prober = createProber();
  prober.observe(FAIL);
  prober.observe(OK);
  const r = prober.observe(FAIL);
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, null);
});

test('custom threshold: down only on the third failure', () => {
  const prober = createProber({ failThreshold: 3 });
  prober.observe(FAIL);
  prober.observe(FAIL);
  const notYet = prober.observe(FAIL);
  assert.equal(notYet.state, 'down');
  assert.equal(notYet.alert, 'down');
});

test('re-probe after recovery re-arms the down alert', () => {
  const prober = createProber();
  prober.observe(FAIL);
  prober.observe(FAIL);
  prober.observe(OK);
  prober.observe(FAIL);
  const r = prober.observe(FAIL);
  assert.equal(r.state, 'down');
  assert.equal(r.alert, 'down');
});

test('probe slower than 8000 ms counts as a failure even when ok', () => {
  const prober = createProber();
  prober.observe(TIMEOUT);
  const r = prober.observe(TIMEOUT);
  assert.equal(r.state, 'down');
  assert.equal(r.alert, 'down');
});

test('exactly 8000 ms is not a failure', () => {
  const prober = createProber();
  const r = prober.observe({ ok: true, ms: 8000, at: 0 });
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, null);
});

test('degraded is not a failure and shows as degraded state', () => {
  const prober = createProber();
  const r = prober.observe({ ok: true, ms: 2000, at: 0, degraded: true });
  assert.equal(r.state, 'degraded');
  assert.equal(r.alert, null);
});

test('degraded clears the failure streak', () => {
  const prober = createProber();
  prober.observe(FAIL);
  prober.observe({ ok: true, ms: 2000, at: 0, degraded: true });
  const r = prober.observe(FAIL);
  assert.equal(r.state, 'degraded');
  assert.equal(r.alert, null);
});

test('recovered from down into degraded', () => {
  const prober = createProber();
  prober.observe(FAIL);
  prober.observe(FAIL);
  const r = prober.observe({ ok: true, ms: 2000, at: 0, degraded: true });
  assert.equal(r.state, 'degraded');
  assert.equal(r.alert, 'recovered');
});

test('plain ok clears degraded', () => {
  const prober = createProber();
  prober.observe({ ok: true, ms: 2000, at: 0, degraded: true });
  const r = prober.observe(OK);
  assert.equal(r.state, 'ok');
  assert.equal(r.alert, null);
});

const HUNG_BODY = {
  ok: true,
  degraded: true,
  slow: ['actor'],
  timed_out: ['actor'],
};

test('classifyProbe passes a clean health body through', () => {
  assert.deepEqual(classifyProbe(true, { ok: true, degraded: false, slow: [], timed_out: [] }), {
    ok: true,
    degraded: false,
    slow: [],
    detail: null,
  });
});

test('classifyProbe fails a body whose ok is not true', () => {
  const r = classifyProbe(true, { ok: false, degraded: false, slow: [], timed_out: [] });
  assert.equal(r.ok, false);
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
});

test('classifyProbe fails a body without ok at all', () => {
  const r = classifyProbe(true, {});
  assert.equal(r.ok, false);
});

test('classifyProbe treats an actor timeout as a failed probe', () => {
  const r = classifyProbe(true, HUNG_BODY);
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'actor timed out');
});

test('classifyProbe treats a sync timeout as a failed probe', () => {
  const r = classifyProbe(true, { ...HUNG_BODY, slow: ['sync'], timed_out: ['sync'] });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'actor timed out');
});

test('classifyProbe treats a kv-only timeout as ok but degraded', () => {
  const r = classifyProbe(true, { ...HUNG_BODY, slow: ['kv'], timed_out: ['kv'] });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  assert.equal(r.detail, null);
});

test('classifyProbe fails when the http response was not ok', () => {
  const r = classifyProbe(false, null);
  assert.equal(r.ok, false);
  assert.ok(r.detail);
  assert.notEqual(r.detail, 'actor timed out');
});

test('two consecutive hung probes raise the existing down alert', () => {
  const prober = createProber();
  const hung = classifyProbe(true, HUNG_BODY);
  prober.observe({ ...hung, ms: 1500 });
  const r = prober.observe({ ...hung, ms: 1500 });
  assert.equal(r.state, 'down');
  assert.equal(r.alert, 'down');
});

const PAGE_A = { id: 'INC-1001:1', region: 'riyadh-north', level: 1, created_local: '9:52 AM' };
const PAGE_B = { id: 'INC-1002:2', region: 'jeddah', level: 2, created_local: '9:58 AM' };

test('planPaging claims every pending page when nothing was claimed', () => {
  assert.deepEqual(planPaging([PAGE_A, PAGE_B], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1', retry: false },
    { region: 'jeddah', pageId: 'INC-1002:2', retry: false },
  ]);
});

test('planPaging returns nothing without pending pages', () => {
  assert.deepEqual(planPaging([], []), []);
  assert.deepEqual(planPaging(null, []), []);
  assert.deepEqual(planPaging(undefined, undefined), []);
});

test('planPaging skips pages already claimed this run', () => {
  assert.deepEqual(planPaging([PAGE_A, PAGE_B], new Set(['INC-1001:1'])), [
    { region: 'jeddah', pageId: 'INC-1002:2', retry: false },
  ]);
});

test('planPaging claims each id once even when the id repeats', () => {
  assert.deepEqual(planPaging([PAGE_A, { ...PAGE_A, level: 1 }, PAGE_B], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1', retry: false },
    { region: 'jeddah', pageId: 'INC-1002:2', retry: false },
  ]);
});

test('planPaging ignores malformed entries', () => {
  assert.deepEqual(planPaging([null, {}, { id: 'x' }, { id: '', region: 'r' }, { id: 'y', region: '' }, PAGE_A], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1', retry: false },
  ]);
});

test('planPaging accepts claimed ids as an array or set and preserves order', () => {
  assert.deepEqual(planPaging([PAGE_B, PAGE_A], ['INC-1002:2']), [
    { region: 'riyadh-north', pageId: 'INC-1001:1', retry: false },
  ]);
});

test('planPaging items carry the retry flag: false without a retry set', () => {
  assert.deepEqual(planPaging([PAGE_A], []), [{ region: 'riyadh-north', pageId: 'INC-1001:1', retry: false }]);
});

test('planPaging replans a claimed page whose sent-mark failed (retry set wins)', () => {
  const plan = planPaging([PAGE_A, PAGE_B], new Set(['INC-1001:1', 'INC-1002:2']), new Set(['INC-1001:1']));
  assert.deepEqual(plan, [
    { region: 'riyadh-north', pageId: 'INC-1001:1', retry: true },
  ]);
});

test('planPaging does not replan a claimed page that is not in the retry set', () => {
  const plan = planPaging([PAGE_A, PAGE_B], new Set(['INC-1001:1']), new Set([]));
  assert.deepEqual(plan, [{ region: 'jeddah', pageId: 'INC-1002:2', retry: false }]);
});

test('planPaging plans a retry page once even when it repeats', () => {
  const plan = planPaging([PAGE_A, PAGE_A], new Set(['INC-1001:1']), new Set(['INC-1001:1']));
  assert.deepEqual(plan, [{ region: 'riyadh-north', pageId: 'INC-1001:1', retry: true }]);
});

test('apiErrorMessage names the method, path and status and nothing else', () => {
  assert.equal(apiErrorMessage('POST', '/ops/pages/sent', 500), 'POST /ops/pages/sent -> 500');
  assert.equal(apiErrorMessage('GET', '/ops/pages/pending', 401), 'GET /ops/pages/pending -> 401');
});

test('apiErrorMessage carries no token or headers even when the path has a query', () => {
  const msg = apiErrorMessage('POST', '/ops/unlock?site=RUH-114', 403);
  assert.equal(msg, 'POST /ops/unlock?site=RUH-114 -> 403');
  assert.equal(/token|authorization|bearer/i.test(msg), false);
});

test('paging streak stays silent below the stall threshold', () => {
  const paging = createPagingHealth();
  assert.deepEqual(paging.record(true), { stalled: false, streak: 1 });
  assert.deepEqual(paging.record(true), { stalled: false, streak: 2 });
});

test('paging.stalled fires once after 3 consecutive failed cycles', () => {
  const paging = createPagingHealth();
  paging.record(true);
  paging.record(true);
  const r = paging.record(true);
  assert.equal(r.stalled, true);
  assert.equal(r.streak, 3);
  const again = paging.record(true);
  assert.equal(again.stalled, false);
  assert.equal(again.streak, 4);
});

test('a clean cycle resets the paging streak', () => {
  const paging = createPagingHealth();
  paging.record(true);
  paging.record(true);
  paging.record(false);
  const r = paging.record(true);
  assert.equal(r.stalled, false);
  assert.equal(r.streak, 1);
});

test('paging health is customisable and validates its input', () => {
  const paging = createPagingHealth({ stallAfter: 1 });
  assert.equal(paging.record(true).stalled, true);
  assert.throws(() => createPagingHealth({ stallAfter: 0 }), /positive integer/);
});
