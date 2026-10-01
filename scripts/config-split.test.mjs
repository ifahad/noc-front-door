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
  'The caller explicitly asked to continue the call in Arabic (for example "Arabic please" or "can we speak Arabic"). Spelled site codes such as R U H, J E D or D M M are English letters, not Arabic.';
const ARABIC_SCRIPT_RE = /[\u0600-\u06FF]/;
const AR_REPLY_RULE =
  'ردّ دائماً بالعربي فقط، حتى لو تكلّم المتصل بالإنجليزي أو كان سجل المحادثة بالإنجليزي.';
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
const mcp = JSON.parse(await readFile(join(assistantDir, 'mcp.json'), 'utf8'));

test('the English flow has no Arabic nodes or Arabic-start edges left', () => {
  assert.equal(
    en.conversation_flow.nodes.filter((n) => /^(n_ar_|t_ar_|s_ar_)/.test(n.id)).length,
    0,
  );
  assert.equal(
    en.conversation_flow.edges.filter((e) => /^(n_ar_|t_ar_|s_ar_)/.test(e.start_node_id))
      .length,
    0,
  );
});

test('only e_sopen_ar and e_stoar_1 hand off to the Arabic assistant, both voice_mode distinct', () => {
  const handoffs = en.conversation_flow.edges.filter((e) => e.target?.type === 'assistant');
  assert.deepEqual(
    handoffs.map((e) => e.id).sort(),
    ['e_sopen_ar', 'e_stoar_1'],
  );
  for (const e of handoffs) {
    assert.equal(e.target.assistant_id, '${ASSISTANT_AR_ID}');
    assert.equal(e.target.voice_mode, 'distinct');
  }
  assert.equal(en.conversation_flow.edges.length, 61);
  assert.equal(en.conversation_flow.nodes.length, 25);
  assert.deepEqual(
    validateFlow(en.conversation_flow, { requireHumanExits: true, requireArabicExits: true }),
    [],
  );
  assert.deepEqual(validateAssistant(en, { toolNames }), []);
});

test('s_to_ar speaks the bridge line and hands off with exactly one default edge', () => {
  const node = en.conversation_flow.nodes.find((n) => n.id === 's_to_ar');
  assert.ok(node, 's_to_ar is missing');
  assert.equal(node.type, 'speak');
  assert.equal(node.name, 'to arabic');
  assert.equal(node.message, 'Sure, switching you to Arabic now. One moment, please.');
  const outgoing = en.conversation_flow.edges.filter((e) => e.start_node_id === 's_to_ar');
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].id, 'e_stoar_1');
  assert.deepEqual(outgoing[0].condition, { type: 'default' });
  assert.equal(outgoing[0].target.type, 'assistant');
  assert.equal(outgoing[0].target.assistant_id, '${ASSISTANT_AR_ID}');
  assert.equal(outgoing[0].target.voice_mode, 'distinct');
});

test('exactly the 8 llm bridge edges target s_to_ar with the canonical Arabic-switch prompt', () => {
  const bridged = en.conversation_flow.edges.filter(
    (e) => e.target?.type === 'node' && e.target.node_id === 's_to_ar',
  );
  assert.equal(bridged.length, 8);
  assert.deepEqual(
    bridged.map((e) => e.id).sort(),
    [
      'e_naf_ar',
      'e_ncoll_ar',
      'e_nstat_ar',
      'e_ntake_ar',
      'e_ntf_ar',
      'e_ntri_ar',
      'e_nverify_ar',
      'e_nwrap_ar',
    ],
  );
  for (const e of bridged) {
    assert.equal(e.condition.type, 'llm');
    assert.equal(e.condition.prompt, AR_HANDOFF_PROMPT);
    assert.equal(
      e.condition.prompt.includes('just spoke in Arabic'),
      false,
      'bridge edge still says "just spoke in Arabic"',
    );
  }
  const eSopenAr = en.conversation_flow.edges.find((e) => e.id === 'e_sopen_ar');
  assert.equal(eSopenAr.start_node_id, 's_open');
  assert.deepEqual(eSopenAr.condition, {
    type: 'expression',
    expression: {
      type: 'comparison',
      op: '==',
      left: { type: 'variable', name: 'route_hint' },
      right: { type: 'string_literal', value: 'arabic' },
    },
  });
  assert.equal(eSopenAr.target.type, 'assistant');
  assert.equal(eSopenAr.target.assistant_id, '${ASSISTANT_AR_ID}');
  assert.equal(eSopenAr.target.voice_mode, 'distinct');
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

test('instructions.md switches to Arabic only on an explicit Arabic request', () => {
  assert.ok(
    enInstructions.includes(
      'take the transition whose description mentions Arabic immediately and say nothing yourself; the system speaks the hand-off line.',
    ),
  );
  assert.equal(enInstructions.includes('Sure, switching you to Arabic now.'), false);
  assert.equal(enInstructions.includes('Please go ahead in Arabic'), false);
  assert.equal(enInstructions.includes('or speaks Arabic'), false);
  assert.ok(enInstructions.includes('the transition whose description mentions Arabic'));
});

test('instructions.md keeps the caller spelling until the ID is complete', () => {
  assert.ok(
    enInstructions.includes(
      'While the caller is still spelling, reply only "Go ahead." Once you have three letters and three digits, read the ID back once, spelled, and ask for the 4-digit PIN.',
    ),
  );
  assert.equal(enInstructions.includes('until you have three letters and three digits'), false);
});

test('both assistants share the calmer turn-taking interruption settings', () => {
  assert.deepEqual(en.interruption_settings, INTERRUPTION_SETTINGS);
  assert.deepEqual(ar.interruption_settings, INTERRUPTION_SETTINGS);
});

test('the Arabic flow starts at s_ar_open and has only Arabic nodes', () => {
  const flow = ar.conversation_flow;
  assert.equal(flow.start_node_id, 's_ar_open');
  assert.equal(flow.nodes.length, 16);
  for (const n of flow.nodes) {
    assert.ok(/^(n_ar_|t_ar_|s_ar_)/.test(n.id), `unexpected node id ${n.id}`);
  }
  assert.equal(flow.edges.length, 37);
});

test('the Arabic opening speaks first and discloses the AI assistant and the recording', () => {
  const node = ar.conversation_flow.nodes[0];
  assert.equal(node.id, 's_ar_open');
  assert.equal(node.type, 'speak');
  assert.equal(node.name, 'arabic opening');
  assert.equal(
    node.message,
    'حيّاك الله، معك سند، المساعد الذكي من نجد نتووركس. للعلم، المكالمة مسجّلة.',
  );
  assert.ok(
    node.message.includes('المساعد الذكي'),
    's_ar_open must name Sanad as the AI assistant',
  );
  assert.ok(node.message.includes('مسجّلة'), 's_ar_open must disclose the recording');
});

const cmp = (op, name, value) => ({
  type: 'comparison',
  op,
  left: { type: 'variable', name },
  right: { type: 'string_literal', value },
});

test('s_ar_open routes by the carried state with exactly one default, first in edges', () => {
  const flow = ar.conversation_flow;
  const edges = flow.edges.filter((e) => e.start_node_id === 's_ar_open');
  assert.deepEqual(
    edges.map((e) => e.id),
    ['e_saro_1', 'e_saro_2', 'e_saro_3', 'e_saro_4'],
  );
  assert.deepEqual(
    flow.edges.slice(0, 4).map((e) => e.id),
    ['e_saro_1', 'e_saro_2', 'e_saro_3', 'e_saro_4'],
  );
  assert.equal(edges[0].target.node_id, 'n_ar_confirm');
  assert.equal(edges[1].target.node_id, 'n_ar_advisory');
  assert.equal(edges[2].target.node_id, 'n_ar_triage');
  assert.equal(edges[3].target.node_id, 'n_ar_intake');
  assert.equal(edges.filter((e) => e.condition?.type === 'default').length, 1);
  assert.deepEqual(edges[3].condition, { type: 'default' });
  assert.deepEqual(edges[0].condition.expression, {
    type: 'bool_op',
    op: 'and',
    operands: [
      {
        type: 'bool_op',
        op: 'or',
        operands: [cmp('==', 'route_hint', 'verified'), cmp('==', 'route_hint', 'known_incident')],
      },
      cmp('!=', 'ticket_id', 'none'),
    ],
  });
  assert.deepEqual(edges[1].condition.expression, {
    type: 'bool_op',
    op: 'and',
    operands: [cmp('==', 'route_hint', 'known_incident'), cmp('==', 'ticket_id', 'none')],
  });
  assert.deepEqual(edges[2].condition.expression, {
    type: 'bool_op',
    op: 'and',
    operands: [cmp('==', 'route_hint', 'verified'), cmp('==', 'ticket_id', 'none')],
  });
});

const INTAKE_TASK =
  'المهمة: اطلب من المتصل رقم الموقع ورقم السر المكوّن من 4 أرقام. حالما تحصل عليهما اطلب capture_details مع site_id وpin. أرقام المواقع بالشكل RUH-114؛ حوّل الحروف والأرقام المنطوقة بالعربي أو الإنجليزي إلى هذا الشكل.';

const SPELL_CODE_SUFFIX =
  'التفريغ الصوتي قد يكتب رقم الموقع بشكل غريب، مثل "Are you H114" أو "Are you Edge 114" أو "R U H 114". إذا كان كلام المتصل فيه ثلاثة أرقام، فهذا رقم الموقع: اطلب capture_details مع site_id بالضبط كما سمعته (مثل H114 أو 114) والنظام يتعرّف عليه، ولا تعامله كسؤال أبداً. وتقدر تقبل اسم الفرع: الياسمين يعني RUH-114، والملقا يعني RUH-121، وحطين يعني RUH-133. ركّز في هذه الخطوة على رقم الموقع ورقم السر فقط.';

test('n_ar_intake keeps its preamble and asks only for the site id and PIN', () => {
  const intake = ar.conversation_flow.nodes.find((n) => n.id === 'n_ar_intake');
  const idx = intake.instructions.indexOf('المهمة:');
  assert.ok(idx > 0);
  assert.equal(intake.instructions.slice(idx), `${INTAKE_TASK} ${SPELL_CODE_SUFFIX}`);
});

test('n_ar_intake and n_ar_pin_retry end with the spelled site-code rule', () => {
  for (const id of ['n_ar_intake', 'n_ar_pin_retry']) {
    const node = ar.conversation_flow.nodes.find((n) => n.id === id);
    assert.ok(node, `${id} is missing`);
    assert.ok(
      node.instructions.endsWith(` ${SPELL_CODE_SUFFIX}`),
      `${id} does not end with the spelled site-code rule`,
    );
  }
});

const TRIAGE_APPEND =
  ' إذا كانت قيمة {{ticket_id}} تساوي none فالمتصل متحقَّق منه لفرع {{site_label}} ({{site_id}})، فلا تطلب منه رقم الموقع ولا رقم السر أبداً، ولا تعيد السؤال عن {{symptom}} أو {{impact}} أو {{service_affecting}} إذا كانت قيمتها معروفة (ليست none ولا unknown)؛ اسأل فقط عن الناقص.';

test('n_ar_triage tells the model a carried verified caller needs no re-verification', () => {
  const triage = ar.conversation_flow.nodes.find((n) => n.id === 'n_ar_triage');
  assert.ok(triage.instructions.endsWith(TRIAGE_APPEND));
});

test('the Arabic assistant has no MCP servers while the English one keeps noc-mcp', () => {
  const allowedTools = [
    'find_site',
    'get_site_status',
    'check_known_incidents',
    'get_ticket_status',
    'add_ticket_note',
  ];
  assert.deepEqual(ar.mcp_servers, []);
  assert.deepEqual(en.mcp_servers, [
    { id: '${MCP_ID}', allowed_tools: allowedTools },
  ]);
  assert.equal(mcp.server.name, 'noc-mcp');
  assert.equal(mcp.server.url, '${EDGE_URL}/mcp');
  assert.equal(mcp.server_ar.name, 'noc-mcp-ar');
  assert.equal(mcp.server_ar.url, '${EDGE_URL}/mcp?lang=ar');
  assert.equal(mcp.server_ar.api_key_ref, mcp.server.api_key_ref);
  assert.deepEqual(mcp.server_ar.allowed_tools, mcp.server.allowed_tools);
});

test('s_ar_goodbye hands off to the Arabic end_call tool node', () => {
  const flow = ar.conversation_flow;
  const goodbyeEdge = flow.edges.find((e) => e.start_node_id === 's_ar_goodbye');
  assert.ok(goodbyeEdge, 's_ar_goodbye has no outgoing edge');
  const hangup = flow.nodes.find(
    (n) => n.id === goodbyeEdge.target?.node_id,
  );
  assert.equal(hangup?.type, 'tool');
  assert.equal(hangup?.shared_tool_id, '${TOOL_end_call}');
});

test('the Arabic mandatory lines are fixed speak nodes with one default edge each', () => {
  const flow = ar.conversation_flow;
  const expected = [
    [
      's_ar_handover',
      'arabic handover',
      'أبشر، بحوّلك الحين على المهندس المناوب، خلك معي على الخط.',
      'e_narh_1',
      't_ar_transfer',
    ],
    [
      's_ar_goodbye',
      'arabic goodbye',
      'شكراً لاتصالك بنجد نتووركس، في أمان الله.',
      'e_narg_1',
      't_ar_hangup',
    ],
    [
      's_ar_verify_unavailable',
      'arabic verify unavailable',
      'ما قدرت أتحقق من بياناتك الحين، بحوّلك على المهندس المناوب.',
      'e_sarvu_1',
      't_ar_transfer',
    ],
  ];
  for (const [id, name, message, edgeId, target] of expected) {
    const node = flow.nodes.find((n) => n.id === id);
    assert.ok(node, `${id} is missing`);
    assert.equal(node.type, 'speak');
    assert.equal(node.name, name);
    assert.equal(node.message, message);
    const outgoing = flow.edges.filter((e) => e.start_node_id === id);
    assert.equal(outgoing.length, 1, `${id} must have exactly one outgoing edge`);
    assert.equal(outgoing[0].id, edgeId);
    assert.deepEqual(outgoing[0].condition, { type: 'default' });
    assert.equal(outgoing[0].target.node_id, target);
  }
});

test('the old Arabic handover and goodbye prompt ids are gone', () => {
  const flow = ar.conversation_flow;
  for (const id of ['n_ar_handover', 'n_ar_goodbye']) {
    assert.equal(
      flow.nodes.some((n) => n.id === id),
      false,
      `${id} still exists as a node`,
    );
  }
  for (const e of flow.edges) {
    assert.notEqual(e.start_node_id, 'n_ar_handover');
    assert.notEqual(e.start_node_id, 'n_ar_goodbye');
    if (e.target?.type === 'node') {
      assert.notEqual(e.target.node_id, 'n_ar_handover');
      assert.notEqual(e.target.node_id, 'n_ar_goodbye');
    }
  }
});

test('t_ar_verify falls back to the fixed verify-unavailable speak node', () => {
  const flow = ar.conversation_flow;
  const edges = flow.edges.filter((e) => e.start_node_id === 't_ar_verify');
  assert.equal(edges.length, 5);
  const def = edges.find((e) => e.condition?.type === 'default');
  assert.equal(def.id, 'e_tarv_5');
  assert.equal(def.target.node_id, 's_ar_verify_unavailable');
  assert.deepEqual(
    edges
      .filter((e) => e.condition?.type !== 'default')
      .map((e) => e.id)
      .sort(),
    ['e_tarv_1', 'e_tarv_2', 'e_tarv_3', 'e_tarv_4'],
  );
});

const AR_TOOLS_RULE =
  'استخدم أدوات البحث والتذاكر فقط بعد ما يتحقق المتصل، وما تضيف ملاحظة على تذكرة إلا إذا طلب المتصل.';

test('every Arabic prompt node replies in Arabic only, right before its task', () => {
  const prompts = ar.conversation_flow.nodes.filter((n) => n.type === 'prompt');
  assert.equal(prompts.length, 6);
  for (const n of prompts) {
    const count = n.instructions.split(AR_REPLY_RULE).length - 1;
    assert.equal(count, 1, `node ${n.id} carries the reply-in-Arabic rule ${count} times`);
    assert.ok(
      n.instructions.includes(`${AR_REPLY_RULE} المهمة:`),
      `node ${n.id} does not place the reply-in-Arabic rule directly before المهمة:`,
    );
  }
});

test('no Arabic node or instructions-ar.md mentions the search-and-ticket tools rule', () => {
  for (const n of ar.conversation_flow.nodes) {
    assert.equal(
      typeof n.instructions === 'string' && n.instructions.includes(AR_TOOLS_RULE),
      false,
      `node ${n.id} unexpectedly carries the tools rule`,
    );
  }
  assert.equal(
    ar.instructions.includes(AR_TOOLS_RULE),
    false,
    'instructions-ar.md still carries the tools rule',
  );
});

test('every Arabic edge stays inside the Arabic flow (one-way handoff)', () => {
  const isArabic = (id) => /^(n_ar_|t_ar_|s_ar_)/.test(id);
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

test('the Arabic assistant config carries the Arabic voice and STT', () => {
  assert.equal(ar.name, 'sanad-noc-ar');
  assert.deepEqual(ar.voice_settings, { voice: 'Telnyx.Bayan.Reem' });
  assert.deepEqual(ar.transcription, { model: 'soniox/stt-rt-v5' });
});

test('the Arabic widget settings equal the English ones (the widget keeps one settings store per page)', () => {
  assert.deepEqual(ar.widget_settings, en.widget_settings);
  assert.deepEqual(Object.keys(ar.widget_settings), Object.keys(en.widget_settings));
});

test('the Arabic assistant shares the English assistant settings unchanged', () => {
  assert.equal(ar.model, en.model);
  assert.equal(ar.greeting, en.greeting);
  assert.deepEqual(ar.interruption_settings, en.interruption_settings);
  assert.deepEqual(ar.telephony_settings, en.telephony_settings);
  assert.equal(ar.dynamic_variables_webhook_url, en.dynamic_variables_webhook_url);
  assert.equal(en.dynamic_variables_webhook_timeout_ms, 4500);
  assert.equal(
    ar.dynamic_variables_webhook_timeout_ms,
    en.dynamic_variables_webhook_timeout_ms,
  );
  assert.deepEqual(ar.dynamic_variables, en.dynamic_variables);
  assert.deepEqual(ar.tool_ids, en.tool_ids);
});

test('instructions-ar.md is exactly the n_ar_intake rules preamble', () => {
  const intake = ar.conversation_flow.nodes.find((n) => n.id === 'n_ar_intake');
  const idx = intake.instructions.indexOf('المهمة:');
  assert.ok(idx > 0);
  const preamble = intake.instructions.slice(0, idx).trim();
  assert.equal(ar.instructions, `${preamble}\n`);
});
