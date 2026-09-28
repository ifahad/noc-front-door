import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFlow, validateAssistant } from './lib/flow-validate.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const assistantDir = join(dir, '..', 'assistant');

const en = JSON.parse(await readFile(join(assistantDir, 'assistant.json'), 'utf8'));
const ar = JSON.parse(await readFile(join(assistantDir, 'assistant-ar.json'), 'utf8'));
ar.instructions = await readFile(join(assistantDir, 'instructions-ar.md'), 'utf8');
const enInstructions = await readFile(join(assistantDir, 'instructions.md'), 'utf8');

const AR_HANDOFF_PROMPT =
  'The caller just asked to switch to Arabic or just spoke in Arabic.';
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF]/;
const INTERRUPTION_SETTINGS = {
  disable_greeting_interruption: true,
  start_speaking_plan: {
    wait_seconds: 0.6,
    transcription_endpointing_plan: {
      on_punctuation_seconds: 0.3,
      on_no_punctuation_seconds: 2.0,
      on_number_seconds: 1.0,
    },
  },
};

const toolNames = JSON.parse(await readFile(join(assistantDir, 'tools.json'), 'utf8')).map(
  (t) => t.display_name,
);

test('the English flow has no Arabic nodes or Arabic-start edges left', () => {
  assert.equal(
    en.conversation_flow.nodes.filter((n) => /^(n_ar_|t_ar_)/.test(n.id)).length,
    0,
  );
  assert.equal(
    en.conversation_flow.edges.filter((e) => /^(n_ar_|t_ar_)/.test(e.start_node_id))
      .length,
    0,
  );
});

test('exactly the 9 entry edges hand off to the Arabic assistant with voice_mode distinct', () => {
  const handoffs = en.conversation_flow.edges.filter((e) => e.target?.type === 'assistant');
  assert.deepEqual(
    handoffs.map((e) => e.id).sort(),
    [
      'e_naf_ar',
      'e_ncoll_ar',
      'e_nstat_ar',
      'e_ntake_ar',
      'e_ntf_ar',
      'e_ntri_ar',
      'e_nverify_ar',
      'e_nwrap_ar',
      'e_sopen_ar',
    ],
  );
  for (const e of handoffs) {
    assert.equal(e.target.assistant_id, '${ASSISTANT_AR_ID}');
    assert.equal(e.target.voice_mode, 'distinct');
  }
  assert.equal(en.conversation_flow.edges.length, 60);
  assert.equal(en.conversation_flow.nodes.length, 24);
  assert.deepEqual(
    validateFlow(en.conversation_flow, { requireHumanExits: true, requireArabicExits: true }),
    [],
  );
  assert.deepEqual(validateAssistant(en, { toolNames }), []);
});

test('every llm Arabic handoff edge carries the canonical Arabic-switch prompt', () => {
  const llmHandoffs = en.conversation_flow.edges.filter(
    (e) => e.target?.type === 'assistant' && e.condition?.type === 'llm',
  );
  assert.equal(llmHandoffs.length, 8);
  for (const e of llmHandoffs) {
    assert.equal(e.condition.prompt, AR_HANDOFF_PROMPT);
  }
  assert.equal(
    en.conversation_flow.edges.find((e) => e.id === 'e_sopen_ar').condition.type,
    'expression',
  );
});

test('the English assistant config and instructions contain no Arabic script', () => {
  assert.equal(
    ARABIC_SCRIPT_RE.test(enInstructions),
    false,
    'instructions.md contains Arabic script',
  );
  assert.equal(
    ARABIC_SCRIPT_RE.test(JSON.stringify(en)),
    false,
    'assistant.json contains Arabic script',
  );
});

test('instructions.md points the caller to the Arabic handoff instead of switching', () => {
  assert.equal(enInstructions.includes('continue in Arabic'), false);
  assert.ok(enInstructions.includes('Sure. Please go ahead in Arabic.'));
  assert.ok(enInstructions.includes('the transition whose description mentions Arabic'));
});

test('both assistants share the calmer turn-taking interruption settings', () => {
  assert.deepEqual(en.interruption_settings, INTERRUPTION_SETTINGS);
  assert.deepEqual(ar.interruption_settings, INTERRUPTION_SETTINGS);
});

test('the Arabic flow starts at n_ar_intake and has only Arabic nodes', () => {
  const flow = ar.conversation_flow;
  assert.equal(flow.start_node_id, 'n_ar_intake');
  assert.equal(flow.nodes.length, 14);
  for (const n of flow.nodes) {
    assert.ok(/^(n_ar_|t_ar_)/.test(n.id), `unexpected node id ${n.id}`);
  }
  assert.equal(flow.edges.length, 32);
});

test('n_ar_goodbye hands off to the Arabic end_call tool node', () => {
  const flow = ar.conversation_flow;
  const goodbyeEdge = flow.edges.find((e) => e.start_node_id === 'n_ar_goodbye');
  assert.ok(goodbyeEdge, 'n_ar_goodbye has no outgoing edge');
  const hangup = flow.nodes.find(
    (n) => n.id === goodbyeEdge.target?.node_id,
  );
  assert.equal(hangup?.type, 'tool');
  assert.equal(hangup?.shared_tool_id, '${TOOL_end_call}');
});

test('every Arabic edge stays inside the Arabic flow (one-way handoff)', () => {
  const isArabic = (id) => /^(n_ar_|t_ar_)/.test(id);
  for (const e of ar.conversation_flow.edges) {
    assert.notEqual(e.target?.type, 'assistant', `edge ${e.id} is an assistant target`);
    if (e.target?.type === 'node') {
      assert.ok(
        isArabic(e.target.node_id),
        `edge ${e.id} targets English node ${e.target.node_id}`,
      );
    }
  }
});

test('the Arabic flow passes validateFlow with assistant targets forbidden', () => {
  const errors = validateFlow(ar.conversation_flow, {
    requireHumanExits: true,
    allowAssistantTargets: false,
  });
  assert.deepEqual(errors, []);
});

test('the Arabic assistant passes validateAssistant', () => {
  assert.deepEqual(validateAssistant(ar, { toolNames }), []);
});

test('no Arabic node carries per-node voice or transcription overrides', () => {
  for (const n of ar.conversation_flow.nodes) {
    assert.equal(n.voice_settings, undefined, `node ${n.id} carries voice_settings`);
    assert.equal(n.transcription, undefined, `node ${n.id} carries transcription`);
  }
});

test('the Arabic assistant config carries the Arabic voice and STT and no widget', () => {
  assert.equal(ar.name, 'sanad-noc-ar');
  assert.deepEqual(ar.voice_settings, { voice: 'Telnyx.Bayan.Reem' });
  assert.deepEqual(ar.transcription, { model: 'soniox/stt-rt-v5' });
  assert.equal('widget_settings' in ar, false);
});

test('the Arabic assistant shares the English assistant settings unchanged', () => {
  assert.equal(ar.model, en.model);
  assert.equal(ar.greeting, en.greeting);
  assert.deepEqual(ar.interruption_settings, en.interruption_settings);
  assert.deepEqual(ar.telephony_settings, en.telephony_settings);
  assert.equal(ar.dynamic_variables_webhook_url, en.dynamic_variables_webhook_url);
  assert.equal(
    ar.dynamic_variables_webhook_timeout_ms,
    en.dynamic_variables_webhook_timeout_ms,
  );
  assert.deepEqual(ar.dynamic_variables, en.dynamic_variables);
  assert.deepEqual(ar.tool_ids, en.tool_ids);
  assert.deepEqual(ar.mcp_servers, en.mcp_servers);
});

test('instructions-ar.md is exactly the n_ar_intake rules preamble', () => {
  const intake = ar.conversation_flow.nodes.find((n) => n.id === 'n_ar_intake');
  const idx = intake.instructions.indexOf('المهمة:');
  assert.ok(idx > 0);
  const preamble = intake.instructions.slice(0, idx).trim();
  assert.equal(ar.instructions, `${preamble}\n`);
});
