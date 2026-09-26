import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './secret-scan.mjs';

const envSecret = 'abc123' + 'SECRETvalue';
const keyFixture = 'KEY' + '01234567890' + 'ABCDEFGHIJ' + '_abcdef';
const bearerFixture = 'Bea' + 'rer ' + '3f9a8b7c' + '6d5e4f3a2b1c';
const ksauPhone = '+96' + '6501234567';
const usPhone = '+1' + '312' + '5550199';
const maskedPhone = '+1312' + '****' + '309';

test('flags a line containing the literal value of an env secret', () => {
  const findings = scanText(`token = ${envSecret}\n`, {
    envSecrets: [envSecret],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'env-secret');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].file, undefined);
});

test('flags a Telnyx-style key literal with a 20+ character body', () => {
  const findings = scanText(`key = ${keyFixture}\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'telnyx-key');
  assert.equal(findings[0].line, 1);
});

test('flags a bearer credential on an authorization header line', () => {
  const findings = scanText(`Authorization: ${bearerFixture}\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'bearer');
  assert.equal(findings[0].line, 1);
});

test('flags E.164 phone numbers on their own lines', () => {
  const text = `mobile ${ksauPhone}\ndesk ${usPhone}\n`;
  const findings = scanText(text);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['e164', 'e164'],
  );
  assert.deepEqual(
    findings.map((f) => f.line),
    [1, 2],
  );
});

test('passes a masked phone number through without a finding', () => {
  assert.deepEqual(scanText(`mask ${maskedPhone}\n`), []);
});

test('returns no findings for a clean file', () => {
  assert.deepEqual(
    scanText('hello world\nnothing to see here\n'),
    [],
  );
});

test('allows env substitution syntax without a finding', () => {
  const text = `token = {env:NOC_OPS_TOKEN}\nAuthorization: Bearer {env:X}\n`;
  assert.deepEqual(scanText(text), []);
});

test('reports findings with line and kind only, never the matched value', () => {
  const findings = scanText(`Authorization: ${bearerFixture}\n`);
  assert.deepEqual(Object.keys(findings[0]).sort(), ['kind', 'line']);
});
