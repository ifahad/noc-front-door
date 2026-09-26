import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateFlow } from './lib/flow-validate.mjs';

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

test('prompt node with shared_tool_ids null may omit tools_mode', () => {
  assert.deepEqual(validateFlow(validFlow()), []);
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
