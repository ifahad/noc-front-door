import assert from 'node:assert/strict';
import { test } from 'node:test';
import { edgeUrl, formatOutput, parseArgs } from './ops.mjs';

test('parseArgs accepts METHOD and path and uppercases the method', () => {
  const parsed = parseArgs(['get', '/ops/health/deep']);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.path, '/ops/health/deep');
  assert.equal('body' in parsed, false);
});

test('parseArgs parses a JSON object body for non-GET methods', () => {
  const parsed = parseArgs(['post', '/ops/pages/claim', '{"region":"jeddah","pageId":"INC-1004:p1"}']);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.path, '/ops/pages/claim');
  assert.deepEqual(parsed.body, { region: 'jeddah', pageId: 'INC-1004:p1' });
});

test('parseArgs rejects too few arguments, bad methods and paths without a slash', () => {
  assert.match(parseArgs([]).error, /usage/);
  assert.match(parseArgs(['fetch', '/x']).error, /METHOD must be one of/);
  assert.match(parseArgs(['GET', 'ops/status']).error, /path must start with \//);
});

test('parseArgs rejects invalid JSON and GET with a body', () => {
  assert.match(parseArgs(['POST', '/ops/ack', '{not json']).error, /not valid JSON/);
  assert.match(parseArgs(['GET', '/ops/status', '{}']).error, /GET takes no/);
  assert.match(parseArgs(['POST', '/ops/ack', '42']).error, /JSON object or array/);
});

test('parseArgs accepts query strings so routes like unlock work as written', () => {
  const parsed = parseArgs(['POST', '/ops/unlock?site=RUH-114']);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.path, '/ops/unlock?site=RUH-114');
  assert.equal(parsed.body, undefined);
});

test('edgeUrl falls back to the deployed edge and trims trailing slashes', () => {
  assert.equal(edgeUrl({}), 'https://noc-edge-41d2a334-7.telnyxcompute.com');
  assert.equal(edgeUrl({ EDGE_URL: 'https://example.invalid///' }), 'https://example.invalid');
});

test('formatOutput prints the status and a pretty body', () => {
  const out = formatOutput(200, '{"mode":"mux"}');
  assert.equal(out, 'HTTP 200\n{\n  "mode": "mux"\n}');
});

test('formatOutput keeps non-JSON bodies verbatim after the status line', () => {
  assert.equal(formatOutput(403, 'unauthorized'), 'HTTP 403\nunauthorized');
});

test('formatOutput never echoes the token, even when a body contains it', () => {
  const token = 'ops-' + 'TOKENVALUE';
  const out = formatOutput(200, JSON.stringify({ echo: token }), [token]);
  assert.equal(out.includes(token), false);
  assert.match(out, /\[redacted\]/);
});
