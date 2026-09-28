import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findByName,
  listAll,
  maskSecrets,
  normaliseAssistantReadback,
  normaliseToolReadback,
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

test('resolvePlaceholders resolves ASSISTANT_AR_ID inside edge targets', () => {
  assert.deepEqual(
    resolvePlaceholders(
      {
        edges: [{ target: { type: 'assistant', assistant_id: '${ASSISTANT_AR_ID}' } }],
      },
      { ASSISTANT_AR_ID: 'asst-ar-1' },
    ),
    { edges: [{ target: { type: 'assistant', assistant_id: 'asst-ar-1' } }] },
  );
});

test('resolvePlaceholders throws when ASSISTANT_AR_ID is missing', () => {
  assert.throws(
    () => resolvePlaceholders({ t: '${ASSISTANT_AR_ID}' }, { OTHER: 'y' }),
    (err) =>
      err instanceof Error &&
      err.message === 'unresolved placeholder ${ASSISTANT_AR_ID}',
  );
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

const pageRes = (data, totalPages) => ({ data, meta: { total_pages: totalPages } });

test('listAll follows total_pages and finds an item on page 2', async () => {
  const seen = [];
  const fetchJson = async (path) => {
    seen.push(path);
    const page = Number(/page\[number\]=(\d+)/.exec(path)?.[1] ?? '1');
    if (page === 1) return pageRes([{ id: 'a' }], 2);
    return pageRes([{ id: 'b' }], 2);
  };
  const items = await listAll('/v2/ai/tools', fetchJson);
  assert.deepEqual(items, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(seen, [
    '/v2/ai/tools?page[size]=100&page[number]=1',
    '/v2/ai/tools?page[size]=100&page[number]=2',
  ]);
});

test('listAll appends to an existing query string', async () => {
  const seen = [];
  const fetchJson = async (path) => {
    seen.push(path);
    return pageRes([{ id: 'x' }], undefined);
  };
  const items = await listAll('/v2/ai/tools?type=webhook', fetchJson);
  assert.deepEqual(items, [{ id: 'x' }]);
  assert.deepEqual(seen, ['/v2/ai/tools?type=webhook&page[size]=100&page[number]=1']);
});

test('listAll stops when meta has no total_pages', async () => {
  let calls = 0;
  const fetchJson = async () => {
    calls += 1;
    return { data: [{ id: 'a' }, { id: 'b' }] };
  };
  const items = await listAll('/v2/ai/assistants', fetchJson);
  assert.deepEqual(items, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(calls, 1);
});

test('listAll tolerates a response without data', async () => {
  const items = await listAll('/v2/ai/tools', async () => ({}));
  assert.deepEqual(items, []);
});

test('listAll keeps paging through three pages', async () => {
  const fetchJson = async (path) => {
    const page = Number(/page\[number\]=(\d+)/.exec(path)?.[1] ?? '1');
    return pageRes(
      [{ id: `p${page}` }],
      page < 3 ? 3 : 3,
    );
  };
  const items = await listAll('/v2/ai/tools', fetchJson);
  assert.deepEqual(items.map((i) => i.id), ['p1', 'p2', 'p3']);
});

const sentWebhookTool = {
  type: 'webhook',
  display_name: 'verify_site',
  timeout_ms: 5000,
  webhook: {
    name: 'verify_site',
    description: 'Verify site identity and PIN.',
    url: 'https://x.test/tools/verify-site',
    method: 'POST',
    preset_body_fields: { site_id: 'RUH-114' },
    headers: [{ name: 'content-type', value: 'application/json' }],
    store_fields_as_variables: [{ name: 'verify_result', value_path: 'result' }],
  },
};

const gotToolLikeApi = (toolDefinition, displayName = 'verify_site') => ({
  id: 'tool-id-1',
  type: 'webhook',
  display_name: displayName,
  tool_definition: toolDefinition,
  timeout_ms: 5000,
  created_at: '2026-01-01',
});

test('normaliseToolReadback lifts tool_definition into the webhook key so a real GET shape has zero DRIFT', () => {
  const got = normaliseToolReadback(gotToolLikeApi(sentWebhookTool.webhook));
  assert.deepEqual(subsetDiff(sentWebhookTool, got), []);
});

test('normaliseToolReadback zero-drifts a real hangup GET shape', () => {
  const sent = {
    type: 'hangup',
    display_name: 'end_call',
    timeout_ms: 5000,
    hangup: { description: 'End the call after the goodbye.' },
  };
  const got = normaliseToolReadback({
    id: 'tool-id-2',
    type: 'hangup',
    display_name: 'end_call',
    tool_definition: { description: 'End the call after the goodbye.' },
    timeout_ms: 5000,
    created_at: '2026-01-01',
  });
  assert.deepEqual(subsetDiff(sent, got), []);
});

test('normaliseToolReadback still reports a real mismatch under tool_definition', () => {
  const def = { ...sentWebhookTool.webhook, url: 'https://x.test/other' };
  const got = normaliseToolReadback(gotToolLikeApi(def));
  const diffs = subsetDiff(sentWebhookTool, got);
  assert.deepEqual(diffs, [
    {
      path: 'webhook.url',
      sent: 'https://x.test/tools/verify-site',
      got: 'https://x.test/other',
    },
  ]);
});

test('normaliseToolReadback passes through a shape without tool_definition', () => {
  const raw = { id: 'x', display_name: 'verify_site' };
  assert.deepEqual(normaliseToolReadback(raw), raw);
  assert.equal(subsetDiff(sentWebhookTool, normaliseToolReadback(raw)).length, 3);
});

test('normaliseToolReadback lifts a flat update_dynamic_variables tool_definition', () => {
  const sent = {
    type: 'update_dynamic_variables',
    display_name: 'probe_capture',
    update_dynamic_variables: { name: 'probe_capture', updatable_variables: [] },
  };
  const got = normaliseToolReadback({
    id: 'tool-id-3',
    type: 'update_dynamic_variables',
    display_name: 'probe_capture',
    tool_definition: { name: 'probe_capture', updatable_variables: [] },
    created_at: '2026-01-01',
  });
  assert.deepEqual(subsetDiff(sent, got), []);
});

const sentAssistant = {
  name: 'sanad-noc',
  tool_ids: ['capture-tool-id'],
  conversation_flow: { start_node_id: 's1', nodes: [{ id: 's1' }] },
};

test('normaliseAssistantReadback maps tools[].tool_id to tool_ids with zero DRIFT', () => {
  const got = normaliseAssistantReadback({
    id: 'asst-1',
    name: 'sanad-noc',
    tools: [{ tool_id: 'capture-tool-id' }],
    conversation_flow: sentAssistant.conversation_flow,
    created_at: '2026-01-01',
  });
  assert.deepEqual(subsetDiff(sentAssistant, got), []);
});

test('normaliseAssistantReadback reports a wrong tool in tools[]', () => {
  const got = normaliseAssistantReadback({
    name: 'sanad-noc',
    tools: [{ tool_id: 'other-tool' }],
    conversation_flow: sentAssistant.conversation_flow,
  });
  assert.deepEqual(subsetDiff(sentAssistant, got), [
    { path: 'tool_ids.0', sent: 'capture-tool-id', got: 'other-tool' },
  ]);
});

test('normaliseAssistantReadback passes through a shape without tools[]', () => {
  const raw = { name: 'x' };
  assert.deepEqual(normaliseAssistantReadback(raw), raw);
});

const PHONE = `+1${'312'}555${'0309'}`;

test('maskSecrets masks E.164 numbers with the documented format', () => {
  assert.equal(maskSecrets(`target ${PHONE} end`), 'target +1312****309 end');
  assert.equal(maskSecrets('no number here'), 'no number here');
  assert.equal(
    maskSecrets(`+${'966'}${'500000000'}`),
    '+9665****000',
  );
});

test('maskSecrets masks numbers nested in printed drift values', () => {
  assert.equal(maskSecrets(`{"to":"${PHONE}"}`), '{"to":"+1312****309"}');
});
