import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProber, planPaging } from './lib/prober-core.mjs';

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

const PAGE_A = { id: 'INC-1001:1', region: 'riyadh-north', level: 1, created_local: '9:52 AM' };
const PAGE_B = { id: 'INC-1002:2', region: 'jeddah', level: 2, created_local: '9:58 AM' };

test('planPaging claims every pending page when nothing was claimed', () => {
  assert.deepEqual(planPaging([PAGE_A, PAGE_B], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1' },
    { region: 'jeddah', pageId: 'INC-1002:2' },
  ]);
});

test('planPaging returns nothing without pending pages', () => {
  assert.deepEqual(planPaging([], []), []);
  assert.deepEqual(planPaging(null, []), []);
  assert.deepEqual(planPaging(undefined, undefined), []);
});

test('planPaging skips pages already claimed this run', () => {
  assert.deepEqual(planPaging([PAGE_A, PAGE_B], new Set(['INC-1001:1'])), [
    { region: 'jeddah', pageId: 'INC-1002:2' },
  ]);
});

test('planPaging claims each id once even when the id repeats', () => {
  assert.deepEqual(planPaging([PAGE_A, { ...PAGE_A, level: 1 }, PAGE_B], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1' },
    { region: 'jeddah', pageId: 'INC-1002:2' },
  ]);
});

test('planPaging ignores malformed entries', () => {
  assert.deepEqual(planPaging([null, {}, { id: 'x' }, { id: '', region: 'r' }, { id: 'y', region: '' }, PAGE_A], []), [
    { region: 'riyadh-north', pageId: 'INC-1001:1' },
  ]);
});

test('planPaging accepts claimed ids as an array or set and preserves order', () => {
  assert.deepEqual(planPaging([PAGE_B, PAGE_A], ['INC-1002:2']), [
    { region: 'riyadh-north', pageId: 'INC-1001:1' },
  ]);
});
