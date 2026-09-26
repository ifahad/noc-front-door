import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve('scripts/setup-edge.sh');
const text = readFileSync(SCRIPT, 'utf8');

test('setup-edge.sh passes bash syntax check', () => {
  execFileSync('bash', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
});

test('setup-edge.sh does not enable tracing', () => {
  assert.doesNotMatch(text, /^\s*set\s+-x\b/m);
  assert.doesNotMatch(text, /\bset\s+-euo\s+pipefail\s+-x\b/);
  assert.ok(!/\bset\s+-x\b/.test(text.replace(/set -euo pipefail/g, '')));
});

test('setup-edge.sh never echoes secret variables', () => {
  const secrets = [
    'MCP_TOKEN',
    'OPS_TOKEN',
    'PIN_PEPPER',
    'TELNYX_API_KEY',
    'NOC_OPS_TOKEN',
    'TELNYX_PUBLIC_KEY',
  ];
  for (const name of secrets) {
    assert.ok(
      !text.includes(`echo "$${name}"`),
      `script echoes ${name}`,
    );
    assert.ok(
      !text.includes(`echo "\${${name}}"`),
      `script echoes ${name}`,
    );
    assert.ok(
      !text.includes(`echo "${name}=$${name}"`),
      `script echoes ${name}`,
    );
  }
});
