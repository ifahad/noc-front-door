#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { loadDotEnv, telnyx } from './lib/telnyx.mjs';

const ASSISTANT_NAME = 'sanad-noc';

function edgeAuthStatus() {
  let out = '';
  try {
    out = execFileSync('telnyx-edge', ['auth', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const text = out.toLowerCase();
  if (text.includes('authenticated')) return 'Authenticated';
  if (text.includes('expired')) return 'Expired';
  return 'Unknown';
}

function assistantsOf(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.assistants)) return body.data.assistants;
  if (Array.isArray(body?.assistants)) return body.assistants;
  return [];
}

let balanceOk = null;
let anyError = false;

loadDotEnv();
if (!process.env.TELNYX_API_KEY) {
  console.error('error: TELNYX_API_KEY is missing; copy .env.example to .env and paste your Telnyx API key');
  process.exit(1);
}

try {
  const bal = await telnyx('/v2/balance');
  const amount = Number(bal?.data?.balance);
  const currency = bal?.data?.currency ?? 'unknown';
  const creditLimit = bal?.data?.credit_limit;
  const suffix = creditLimit !== undefined && creditLimit !== null ? ` (credit_limit ${creditLimit})` : '';
  console.log(`balance: ${bal?.data?.balance} ${currency}${suffix}`);
  balanceOk = Number.isFinite(amount) ? amount : null;
  if (balanceOk === null) anyError = true;
} catch (err) {
  console.log(`balance: error (${err.message})`);
  anyError = true;
}

try {
  const models = await telnyx('/v2/ai/openai/models');
  const ids = (Array.isArray(models?.data) ? models.data : [])
    .map((m) => m?.id)
    .filter(Boolean);
  console.log(`chat models: ${ids.length}`);
  for (const id of ids) console.log(`  ${id}`);
} catch (err) {
  console.log(`chat models: error (${err.message})`);
  anyError = true;
}

try {
  const res = await telnyx('/v2/ai/assistants');
  const present = assistantsOf(res).some((a) => a?.name === ASSISTANT_NAME);
  console.log(`assistant ${ASSISTANT_NAME}: ${present ? 'present' : 'absent'}`);
} catch (err) {
  console.log(`assistant ${ASSISTANT_NAME}: error (${err.message})`);
  anyError = true;
}

console.log(`edge auth: ${edgeAuthStatus()}`);

if (balanceOk !== null && balanceOk < 2.0) {
  console.error('error: balance is below 2.00; top up the trial account');
  process.exit(2);
}
if (anyError) process.exit(1);
