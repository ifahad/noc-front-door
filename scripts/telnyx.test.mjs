import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, telnyx } from './lib/telnyx.mjs';

const FAKE_KEY = ['a', 'b', 'c'].join('') + 'k'.repeat(29);

test('loadDotEnv parses KEY=VALUE, skips blanks/comments, strips quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
  const file = join(dir, '.env');
  writeFileSync(
    file,
    [
      '# comment',
      '',
      'PLAIN=hello',
      'QUOTED="with spaces"',
      'SINGLE=\'single value\'',
      'EMPTY=',
    ].join('\n') + '\n',
  );
  const saved = { ...process.env };
  try {
    loadDotEnv(file);
    assert.equal(process.env.PLAIN, 'hello');
    assert.equal(process.env.QUOTED, 'with spaces');
    assert.equal(process.env.SINGLE, 'single value');
    assert.equal(process.env.EMPTY, '');
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv does not override already-set variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'ONLY_IN_FILE=file-value\n');
  const saved = { ...process.env };
  try {
    process.env.ONLY_IN_FILE = 'already-set';
    loadDotEnv(file);
    assert.equal(process.env.ONLY_IN_FILE, 'already-set');
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telnyx error message never contains the api key', async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  try {
    process.env.TELNYX_API_KEY = FAKE_KEY;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
      return new Response(
        JSON.stringify({
          errors: [{ code: '40100', title: 'Unauthorized' }],
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    };
    await assert.rejects(
      () => telnyx('/v2/balance'),
      (err) => {
        assert.match(err.message, /^telnyx GET \/v2\/balance -> 401 40100 Unauthorized$/);
        assert.ok(!err.message.includes(FAKE_KEY));
        return true;
      },
    );
  } finally {
    process.env = saved;
    globalThis.fetch = realFetch;
  }
});

test('telnyx error message includes detail and source.pointer', async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  try {
    process.env.TELNYX_API_KEY = FAKE_KEY;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              code: '10026',
              title: 'Invalid parameter type',
              detail: 'Expected string type',
              source: { pointer: '/body/transcription/settings/keyterm' },
            },
          ],
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    await assert.rejects(
      () => telnyx('/v2/ai/assistants/x', { method: 'POST', body: {} }),
      (err) => {
        assert.equal(
          err.message,
          'telnyx POST /v2/ai/assistants/x -> 400 10026 Invalid parameter type: Expected string type (at /body/transcription/settings/keyterm)',
        );
        return true;
      },
    );
  } finally {
    process.env = saved;
    globalThis.fetch = realFetch;
  }
});

test('telnyx sends JSON body and parses success', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.body, JSON.stringify({ name: 'noc-kv' }));
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    };
    const body = await telnyx('/v2/thing', {
      method: 'POST',
      body: { name: 'noc-kv' },
    });
    assert.deepEqual(body, { data: { ok: true } });
  } finally {
    globalThis.fetch = realFetch;
  }
});
