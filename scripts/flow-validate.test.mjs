import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFlow, validateAssistant } from './lib/flow-validate.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

const var_ = (name) => ({ type: 'variable', name });
const num_ = (value) => ({ type: 'number_literal', value });
const str_ = (value) => ({ type: 'string_literal', value });
const cmp = (op, left, right) => ({ type: 'comparison', op, left, right });
const or_ = (...operands) => ({ type: 'bool_op', op: 'or', operands });
const default_ = () => ({ type: 'default' });
const llm_ = (prompt) => ({ type: 'llm', prompt });
const edge = (id, from, condition, to) => ({
  id,
  start_node_id: from,
  target: { type: 'node', node_id: to },
  condition,
});

const validFlow = () => ({
  start_node_id: 's1',
  nodes: [
    { id: 's1', type: 'speak', name: 'greet', message: 'hi' },
    {
      id: 'n1',
      type: 'prompt',
      name: 'ask',
      instructions: 'ask',
      instructions_mode: 'append',
      shared_tool_ids: [],
      tools_mode: 'replace',
    },
    { id: 't1', type: 'tool', name: 'tool', shared_tool_id: 'tool_x' },
    {
      id: 'n2',
      type: 'prompt',
      name: 'mcp',
      instructions: 'mcp',
      instructions_mode: 'append',
      shared_tool_ids: null,
    },
  ],
  edges: [
    edge('e1', 's1', { type: 'expression', expression: cmp('==', var_('a'), str_('b')) }, 't1'),
    edge('e2', 't1', default_(), 's1'),
    edge('e3', 's1', default_(), 'n1'),
    edge('e4', 'n1', llm_('done'), 'n2'),
  ],
});

test('valid mini-flow passes with no errors', () => {
  assert.deepEqual(validateFlow(validFlow()), []);
});

test('duplicate node ids are rejected', () => {
  const flow = validFlow();
  flow.nodes.push({ id: 's1', type: 'speak', name: 'again', message: 'x' });
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('duplicate node id')));
});

test('duplicate edge ids are rejected', () => {
  const flow = validFlow();
  flow.edges.push(edge('e1', 's1', default_(), 'n2'));
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('duplicate edge id')));
});

test('start_node_id must exist', () => {
  const flow = validFlow();
  flow.start_node_id = 'nope';
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('start_node_id') && e.includes('nope')));
});

test('edge with unknown start node is rejected', () => {
  const flow = validFlow();
  flow.edges[3] = edge('e4', 'ghost', llm_('x'), 'n2');
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('e4') && e.includes('start node')));
});

test('edge with unknown target node is rejected', () => {
  const flow = validFlow();
  flow.edges[3] = edge('e4', 'n1', llm_('x'), 'ghost');
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('e4') && e.includes('target node')));
});

test('speak node with outgoing edges and zero default edge is rejected', () => {
  const flow = validFlow();
  flow.edges = flow.edges.filter((e) => e.id !== 'e3');
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('s1') && e.includes('default')));
});

test('tool node with two default edges is rejected', () => {
  const flow = validFlow();
  flow.edges.push(edge('e5', 't1', default_(), 'n2'));
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('t1') && e.includes('exactly one default')));
});

test('prompt node with a default edge is rejected', () => {
  const flow = validFlow();
  flow.edges.push(edge('e5', 'n1', default_(), 'n2'));
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('must not have a default edge')));
});

test('prompt node missing instructions_mode is rejected', () => {
  const flow = validFlow();
  delete flow.nodes[1].instructions_mode;
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('instructions_mode')));
});

test('prompt node with shared_tool_ids array missing tools_mode is rejected', () => {
  const flow = validFlow();
  delete flow.nodes[1].tools_mode;
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('tools_mode')));
});

test('prompt node with shared_tool_ids null must still set tools_mode', () => {
  const flow = validFlow();
  flow.nodes.push(promptNode('n3'));
  flow.edges.push(edge('e5', 'n2', llm_('done'), 'n3'));
  delete flow.nodes[3].tools_mode;
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n2') && e.includes('tools_mode')));
});

test('expression edge with disallowed node type is rejected', () => {
  const flow = validFlow();
  flow.edges[0].condition.expression = { type: 'fuzzy_match', left: var_('a') };
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('e1') && e.includes('fuzzy_match')));
});

test('expression edge with disallowed nested node type is rejected', () => {
  const flow = validFlow();
  flow.edges[0].condition.expression = or_(
    cmp('==', var_('a'), str_('b')),
    { type: 'template', value: 'x' },
  );
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('e1') && e.includes('template')));
});

test('validateFlow accepts the real probe assistant flow unchanged', async () => {
  const raw = await readFile(join(dir, '..', 'assistant', 'probe', 'assistant.json'), 'utf8');
  const assistant = JSON.parse(raw);
  assert.deepEqual(validateFlow(assistant.conversation_flow), []);
});

const promptNode = (id, extra = {}) => ({
  id,
  type: 'prompt',
  name: id,
  instructions: 'ask',
  instructions_mode: 'append',
  shared_tool_ids: [],
  tools_mode: 'replace',
  ...extra,
});

const promptFlow = (nodes, edges) => ({
  start_node_id: nodes[0].id,
  nodes,
  edges,
});

const HUMAN_EDGE = edge('eh', 'n1', llm_('The caller asked to speak to a human engineer.'), 'n2');

test('requireHumanExits passes a prompt node with a human-engineer llm edge', () => {
  const flow = promptFlow(
    [promptNode('n1'), promptNode('n2')],
    [HUMAN_EDGE, edge('e1', 'n1', llm_('other'), 'n2')],
  );
  assert.deepEqual(validateFlow(flow, { requireHumanExits: true }), []);
});

test('requireHumanExits passes a prompt node with an a-person llm edge', () => {
  const flow = promptFlow(
    [promptNode('n1'), promptNode('n2')],
    [edge('e1', 'n1', llm_('The caller asked for a person.'), 'n2')],
  );
  assert.deepEqual(validateFlow(flow, { requireHumanExits: true }), []);
});

test('requireHumanExits rejects a prompt node without a human-request exit', () => {
  const flow = promptFlow(
    [promptNode('n1'), promptNode('n2')],
    [edge('e1', 'n1', llm_('The caller said go on.'), 'n2')],
  );
  const errs = validateFlow(flow, { requireHumanExits: true });
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('human')));
});

test('requireHumanExits exempts the given node ids', () => {
  const flow = promptFlow(
    [promptNode('n_wrapup'), promptNode('n2')],
    [edge('e1', 'n_wrapup', llm_('The caller said there is nothing else.'), 'n2')],
  );
  assert.deepEqual(
    validateFlow(flow, { requireHumanExits: true, humanExitExemptions: ['n_wrapup'] }),
    [],
  );
});

test('requireHumanExits rejects an expression-only prompt node', () => {
  const flow = promptFlow(
    [promptNode('n1'), promptNode('n2')],
    [edge('e1', 'n1', { type: 'expression', expression: cmp('==', var_('a'), str_('b')) }, 'n2')],
  );
  const errs = validateFlow(flow, { requireHumanExits: true });
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('human')));
});

test('probe flow stays valid without the human-exit rule', async () => {
  const raw = await readFile(join(dir, '..', 'assistant', 'probe', 'assistant.json'), 'utf8');
  const assistant = JSON.parse(raw);
  assert.deepEqual(validateFlow(assistant.conversation_flow), []);
});

const realAssistant = async () => {
  const dirAssist = join(dir, '..', 'assistant');
  const assistant = JSON.parse(
    await readFile(join(dirAssist, 'assistant.json'), 'utf8'),
  );
  assistant.instructions = await readFile(join(dirAssist, 'instructions.md'), 'utf8');
  return assistant;
};

test('validateFlow with human exits accepts the real 37-node assistant flow', async () => {
  const assistant = await realAssistant();
  assert.equal(assistant.conversation_flow.nodes.length, 37);
  assert.equal(assistant.conversation_flow.edges.length, 93);
  assert.deepEqual(
    validateFlow(assistant.conversation_flow, { requireHumanExits: true }),
    [],
  );
});

test('validateFlow rejects a prompt node listing end_call in shared_tool_ids', () => {
  const flow = validFlow();
  flow.nodes[1].shared_tool_ids = ['${TOOL_end_call}'];
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('end_call')));
});

test('validateFlow rejects a prompt node listing transfer_oncall in shared_tool_ids', () => {
  const flow = validFlow();
  flow.nodes[1].shared_tool_ids = ['${TOOL_transfer_oncall}'];
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('transfer_oncall')));
});

test('validateFlow accepts prompt nodes whose shared tools are non-mandatory', () => {
  const flow = validFlow();
  flow.nodes[1].shared_tool_ids = ['${TOOL_verify_site}'];
  assert.deepEqual(validateFlow(flow), []);
});

test('validateFlow rejects a prompt node calling capture_details without exposing it', () => {
  const flow = validFlow();
  flow.nodes[1].instructions = 'Call capture_details to save the answer.';
  flow.nodes[1].shared_tool_ids = [];
  flow.nodes[1].tools_mode = 'replace';
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('n1') && e.includes('capture_details')));
});

test('validateFlow accepts capture_details via the shared_tool_ids list', () => {
  const flow = validFlow();
  flow.nodes[1].instructions = 'Call capture_details to save the answer.';
  flow.nodes[1].shared_tool_ids = ['${TOOL_capture_details}'];
  flow.nodes[1].tools_mode = 'replace';
  assert.deepEqual(validateFlow(flow), []);
});

test('validateFlow accepts capture_details via null shared_tool_ids', () => {
  const flow = validFlow();
  flow.nodes[3].instructions = 'Call capture_details to save the answer.';
  flow.nodes[3].instructions_mode = 'replace';
  flow.nodes[3].tools_mode = 'append';
  assert.deepEqual(validateFlow(flow), []);
});

test('validateFlow rejects voice_settings on a speak node', () => {
  const flow = validFlow();
  flow.nodes[0].voice_settings = { voice: 'Telnyx.Bayan.Reem' };
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('s1') && e.includes('voice_settings')));
});

test('validateFlow rejects transcription on a tool node', () => {
  const flow = validFlow();
  flow.nodes[2].transcription = { model: 'soniox/stt-rt-v5' };
  const errs = validateFlow(flow);
  assert.ok(errs.some((e) => e.includes('t1') && e.includes('transcription')));
});

test('validateFlow accepts voice_settings and transcription on prompt nodes', () => {
  const flow = validFlow();
  flow.nodes[1].voice_settings = { voice: 'Telnyx.Bayan.Reem' };
  flow.nodes[1].transcription = { model: 'soniox/stt-rt-v5' };
  assert.deepEqual(validateFlow(flow), []);
});

test('human-exit rule exempts the Arabic handover and goodbye nodes by default', () => {
  const flow = promptFlow(
    [promptNode('n_ar_handover'), promptNode('n_ar_goodbye')],
    [
      edge(
        'e1',
        'n_ar_handover',
        { type: 'expression', expression: cmp('!=', var_('callback_note'), str_('none')) },
        'n_ar_goodbye',
      ),
      edge('e2', 'n_ar_goodbye', llm_('The caller said goodbye.'), 'n_ar_handover'),
    ],
  );
  assert.deepEqual(validateFlow(flow, { requireHumanExits: true }), []);
});

const realTools = async () => {
  const raw = await readFile(join(dir, '..', 'assistant', 'tools.json'), 'utf8');
  return JSON.parse(raw).map((t) => t.display_name);
};

test('validateAssistant resolves every flow tool placeholder through tools.json', async () => {
  const assistant = await realAssistant();
  assert.deepEqual(validateAssistant(assistant, { toolNames: await realTools() }), []);
});

test('validateAssistant rejects an unknown tool placeholder in the flow', async () => {
  const assistant = await realAssistant();
  assistant.conversation_flow.nodes.find((n) => n.id === 't_verify').shared_tool_id =
    '${TOOL_ghost_tool}';
  const errs = validateAssistant(assistant, { toolNames: await realTools() });
  assert.ok(errs.some((e) => e.includes('ghost_tool')));
});

test('validateAssistant ignores flow tool placeholders without toolNames', async () => {
  const assistant = await realAssistant();
  assistant.conversation_flow.nodes.find((n) => n.id === 't_verify').shared_tool_id =
    '${TOOL_ghost_tool}';
  assert.deepEqual(validateAssistant(assistant), []);
});

test('validateAssistant passes the real assistant', async () => {
  const assistant = await realAssistant();
  assert.deepEqual(validateAssistant(assistant), []);
});

test('validateAssistant rejects tool_ids other than capture_details', async () => {
  const assistant = await realAssistant();
  assistant.tool_ids = ['${TOOL_verify_site}'];
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('tool_ids') && e.includes('capture_details')));
});

test('validateAssistant rejects an empty tool_ids', async () => {
  const assistant = await realAssistant();
  assistant.tool_ids = [];
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('tool_ids')));
});

test('validateAssistant rejects an undeclared mustache in a speak message', async () => {
  const assistant = await realAssistant();
  assistant.conversation_flow.nodes.find((n) => n.id === 's_confirm').message =
    'Ticket {{bogus_var}} opened.';
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('bogus_var') && e.includes('s_confirm')));
});

test('validateAssistant rejects an undeclared mustache in node instructions', async () => {
  const assistant = await realAssistant();
  assistant.conversation_flow.nodes.find((n) => n.id === 'n_triage').instructions =
    'Mention {{ghost_var}} to the caller.';
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('ghost_var') && e.includes('n_triage')));
});

test('validateAssistant rejects an undeclared mustache in global instructions', async () => {
  const assistant = await realAssistant();
  assistant.instructions = 'Greet {{ghost_global}} politely.';
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('ghost_global')));
});

test('validateAssistant accepts a known system variable mustache', async () => {
  const assistant = await realAssistant();
  assistant.conversation_flow.nodes.find((n) => n.id === 's_confirm').message =
    'Call reference {{telnyx_conversation_id}}.';
  assert.deepEqual(validateAssistant(assistant), []);
});

test('validateAssistant rejects a keyterm array', async () => {
  const assistant = await realAssistant();
  assistant.transcription = { settings: { keyterm: ['RUH', 'JED'] } };
  const errs = validateAssistant(assistant);
  assert.ok(errs.some((e) => e.includes('keyterm') && e.includes('string')));
});

test('validateAssistant accepts a comma-separated keyterm string', async () => {
  const assistant = await realAssistant();
  assistant.transcription = {
    settings: { keyterm: ['RUH', 'JED', 'DMM', 'Najd', 'Yasmin', 'Malqa', 'Hittin', 'Arabic'].join(',') },
  };
  assert.deepEqual(validateAssistant(assistant), []);
});

test('validateAssistant resolves real tool ids through a custom toolName map', async () => {
  const assistant = await realAssistant();
  assistant.tool_ids = ['abc-123'];
  const errs = validateAssistant(assistant, {
    toolName: (id) => (id === 'abc-123' ? 'capture_details' : null),
  });
  assert.deepEqual(errs, []);
});
