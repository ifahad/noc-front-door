import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findByName,
  resolvePlaceholders,
  subsetDiff,
  unwrap,
} from './lib/apply-core.mjs';

test('resolvePlaceholders replaces tokens deep inside objects and arrays', () => {
  const vars = { PROBE_URL: 'https://x.test', ID_A: 'aaa', ID_B: 'bbb' };
  const out = resolvePlaceholders(
    {
      url: '${PROBE_URL}/dv',
      nested: { list: ['${ID_A}', 'plain'] },
      arr: [{ id: '${ID_B}' }],
    },
    vars,
  );
  assert.deepEqual(out, {
    url: 'https://x.test/dv',
    nested: { list: ['aaa', 'plain'] },
    arr: [{ id: 'bbb' }],
  });
});

test('resolvePlaceholders replaces tokens inside longer strings', () => {
  assert.equal(
    resolvePlaceholders('url=${PROBE_URL}&x=1', { PROBE_URL: 'https://x.test' }),
    'url=https://x.test&x=1',
  );
});

test('resolvePlaceholders leaves mustache templates untouched', () => {
  assert.deepEqual(
    resolvePlaceholders(
      { v: '{{trace_id}}', mix: '{{trace_id}} and ${PROBE_URL}' },
      { PROBE_URL: 'https://x.test' },
    ),
    { v: '{{trace_id}}', mix: '{{trace_id}} and https://x.test' },
  );
});

test('resolvePlaceholders throws on a token with no value', () => {
  assert.throws(
    () => resolvePlaceholders({ u: '${MISSING}/x' }, { OTHER: 'y' }),
    (err) =>
      err instanceof Error &&
      err.message === 'unresolved placeholder ${MISSING}',
  );
});

test('resolvePlaceholders keeps non-strings and allows full-value replacement', () => {
  assert.deepEqual(resolvePlaceholders({ n: 5, b: true, s: '${A}' }, { A: 'z' }), {
    n: 5,
    b: true,
    s: 'z',
  });
});

test('unwrap returns .data when present, else the object itself', () => {
  assert.deepEqual(unwrap({ data: { id: '1' } }), { id: '1' });
  assert.deepEqual(unwrap({ id: '2' }), { id: '2' });
  assert.deepEqual(unwrap(null), null);
  assert.deepEqual(unwrap({ data: [1, 2] }), [1, 2]);
});

test('findByName matches first element on the given field', () => {
  const list = [
    { id: '1', display_name: 'dup' },
    { id: '2', display_name: 'dup' },
    { id: '3', display_name: 'other' },
  ];
  assert.deepEqual(findByName(list, 'display_name', 'dup'), list[0]);
  assert.equal(findByName(list, 'display_name', 'nope'), undefined);
  assert.equal(findByName(undefined, 'name', 'x'), undefined);
});

test('subsetDiff reports missing key, type mismatch and numeric-string mismatch', () => {
  const diffs = subsetDiff(
    { a: 1, b: { c: 'x' }, d: [1, 2] },
    { a: '1', d: [1] },
  );
  assert.deepEqual(diffs, [
    { path: 'a', sent: 1, got: '1' },
    { path: 'b', sent: { c: 'x' }, got: undefined },
    { path: 'd.1', sent: 2, got: undefined },
  ]);
});

test('subsetDiff ignores keys not present in sent', () => {
  const diffs = subsetDiff(
    { name: 'x' },
    { name: 'x', created_at: '2026-01-01', extra: { deep: true } },
  );
  assert.deepEqual(diffs, []);
});

test('subsetDiff recurses into nested objects and arrays by index', () => {
  const diffs = subsetDiff(
    { flow: { nodes: [{ id: 'a' }, { id: 'b' }] }, n: { m: { k: 3 } } },
    { flow: { nodes: [{ id: 'a' }, { id: 'z' }] }, n: { m: { k: 4 } } },
  );
  assert.deepEqual(diffs, [
    { path: 'flow.nodes.1.id', sent: 'b', got: 'z' },
    { path: 'n.m.k', sent: 3, got: 4 },
  ]);
});

test('subsetDiff flags sent object against non-object got', () => {
  const diffs = subsetDiff({ a: { b: 1 } }, { a: 'nope' });
  assert.deepEqual(diffs, [{ path: 'a', sent: { b: 1 }, got: 'nope' }]);
});

test('subsetDiff ignores extra elements beyond sent array length', () => {
  const diffs = subsetDiff({ ids: ['a'] }, { ids: ['a', 'b', 'c'] });
  assert.deepEqual(diffs, []);
});
