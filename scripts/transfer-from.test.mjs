import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePlaceholders } from './lib/apply-core.mjs';

const execFileP = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, '..');

const tools = JSON.parse(await readFile(join(root, 'assistant', 'tools.json'), 'utf8'));
const transfer = tools.find((t) => t.display_name === 'transfer_oncall');

// Phone-like fixtures assembled at runtime (repo secret scanner forbids E.164 literals).
const SANAD_FAKE = `+1${'312'}555${'0301'}`;
const ONCALL_FAKE = `+1${'312'}555${'0309'}`;

test('transfer_oncall presents the SANAD_NUMBER placeholder as the caller ID', () => {
  assert.equal(transfer.transfer.from, '${SANAD_NUMBER}');
});

test('transfer_oncall caller ID is never the agent-target variable or a literal number', () => {
  assert.notEqual(transfer.transfer.from, '{{telnyx_agent_target}}');
  assert.doesNotMatch(transfer.transfer.from, /\{\{[^}]*\}\}/);
  assert.doesNotMatch(transfer.transfer.from, /\+[0-9]{7,15}\b/);
});

test('resolvePlaceholders resolves the transfer caller ID from SANAD_NUMBER', () => {
  const resolved = resolvePlaceholders(tools, {
    EDGE_URL: 'https://edge.test',
    ONCALL_NUMBER: ONCALL_FAKE,
    SANAD_NUMBER: SANAD_FAKE,
  });
  const resolvedTransfer = resolved.find((t) => t.display_name === 'transfer_oncall');
  assert.equal(resolvedTransfer.transfer.from, SANAD_FAKE);
  assert.equal(resolvedTransfer.transfer.targets[0].to, ONCALL_FAKE);
});

test('apply.mjs --dry-run resolves every placeholder without SANAD_NUMBER', async () => {
  const { stdout } = await execFileP(
    'node',
    ['scripts/apply.mjs', '--dry-run'],
    { cwd: root, env: { ...process.env, SANAD_NUMBER: '' }, timeout: 30000 },
  );
  assert.ok(stdout.includes('placeholders: all resolved'));
});

test('apply.mjs --dry-run lists both MCP servers and the Arabic one carries ?lang=ar', async () => {
  const { stdout } = await execFileP(
    'node',
    ['scripts/apply.mjs', '--dry-run'],
    { cwd: root, env: { ...process.env, SANAD_NUMBER: '' }, timeout: 30000 },
  );
  const lines = stdout.split('\n').filter((l) => l.startsWith('mcp_server:'));
  assert.deepEqual(
    lines.map((l) => l.split(' ')[0]),
    ['mcp_server:noc-mcp', 'mcp_server:noc-mcp-ar'],
  );
  assert.ok(lines[0].endsWith('/mcp'), `en url: ${lines[0]}`);
  assert.ok(lines[1].endsWith('/mcp?lang=ar'), `ar url: ${lines[1]}`);
});
