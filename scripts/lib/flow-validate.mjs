const EXPRESSION_TYPES = new Set([
  'comparison',
  'bool_op',
  'variable',
  'string_literal',
  'number_literal',
  'bool_literal',
]);

function walkExpression(edgeId, node, errors) {
  if (node === null || typeof node !== 'object') {
    errors.push(`edge "${edgeId}" expression: missing expression`);
    return;
  }
  if (!EXPRESSION_TYPES.has(node.type)) {
    errors.push(
      `edge "${edgeId}" expression: not allowed node type "${node.type ?? 'undefined'}"`,
    );
    return;
  }
  if (node.type === 'comparison') {
    walkExpression(edgeId, node.left, errors);
    walkExpression(edgeId, node.right, errors);
  }
  if (node.type === 'bool_op') {
    if (Array.isArray(node.operands)) {
      for (const operand of node.operands) {
        walkExpression(edgeId, operand, errors);
      }
    }
  }
}

export function validateFlow(flow) {
  const errors = [];
  if (flow === null || typeof flow !== 'object') {
    errors.push('flow: not an object');
    return errors;
  }
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow.edges) ? flow.edges : [];
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!node?.id) {
      errors.push('nodes: node without id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of edges) {
    if (!edge?.id) {
      errors.push('edges: edge without id');
      continue;
    }
    if (edgeIds.has(edge.id)) {
      errors.push(`duplicate edge id "${edge.id}"`);
    }
    edgeIds.add(edge.id);
  }
  if (flow.start_node_id && !nodeIds.has(flow.start_node_id)) {
    errors.push(`start_node_id "${flow.start_node_id}" not found in nodes`);
  }
  for (const edge of edges) {
    if (!edge?.id) continue;
    if (!edge.start_node_id) {
      errors.push(`edge "${edge.id}": start_node_id missing`);
    } else if (!nodeIds.has(edge.start_node_id)) {
      errors.push(
        `edge "${edge.id}" references unknown start node "${edge.start_node_id}"`,
      );
    }
    if (
      edge.target?.type === 'node' &&
      !nodeIds.has(edge.target?.node_id)
    ) {
      errors.push(
        `edge "${edge.id}" references unknown target node "${edge.target?.node_id}"`,
      );
    }
    if (edge.condition?.type === 'expression') {
      walkExpression(edge.id, edge.condition.expression, errors);
    }
  }
  const defaultsByNode = new Map();
  for (const edge of edges) {
    if (edge?.start_node_id && edge.condition?.type === 'default') {
      defaultsByNode.set(
        edge.start_node_id,
        (defaultsByNode.get(edge.start_node_id) ?? 0) + 1,
      );
    }
  }
  const hasOutgoing = new Set();
  for (const edge of edges) {
    if (edge?.start_node_id) hasOutgoing.add(edge.start_node_id);
  }
  for (const node of nodes) {
    if (!node?.id || !nodeIds.has(node.id) || !hasOutgoing.has(node.id)) {
      continue;
    }
    const defaults = defaultsByNode.get(node.id) ?? 0;
    if ((node.type === 'speak' || node.type === 'tool') && defaults !== 1) {
      errors.push(
        `${node.type} node "${node.id}" with outgoing edges needs exactly one default edge (found ${defaults})`,
      );
    }
    if (node.type === 'prompt' && defaults !== 0) {
      errors.push(`prompt node "${node.id}" must not have a default edge`);
    }
    if (node.type === 'prompt') {
      if (!node.instructions_mode) {
        errors.push(`prompt node "${node.id}" missing instructions_mode`);
      }
      if (node.shared_tool_ids !== null && !node.tools_mode) {
        errors.push(`prompt node "${node.id}" missing tools_mode`);
      }
    }
  }
  return errors;
}
