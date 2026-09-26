#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, telnyx } from './lib/telnyx.mjs';
import {
  findByName,
  resolvePlaceholders,
  subsetDiff,
  unwrap,
} from './lib/apply-core.mjs';
import { validateFlow } from './lib/flow-validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const SECRET_IDENTIFIER = 'noc_mcp_token';
const MCP_NAME = 'noc-mcp-probe';
const ASSISTANT_NAME = 'sanad-noc';
const DRY_VARS = {
  TOOL_probe_capture: 'DRYRUN_probe_capture',
  TOOL_probe_echo: 'DRYRUN_probe_echo',
  TOOL_probe_hangup: 'DRYRUN_probe_hangup',
  MCP_ID: 'DRYRUN_noc-mcp-probe',
};

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

function printDrift(resource, diffs) {
  for (const d of diffs) {
    const sent = JSON.stringify(d.sent);
    const got = JSON.stringify(d.got ?? null);
    console.log(`DRIFT ${resource} ${d.path} sent=${sent} got=${got}`);
  }
}

function reportFailure(resource, err) {
  const m = /-> (\d+) (\S+) (.+)$/.exec(err?.message ?? '');
  if (m) {
    console.log(`FAILED ${resource} ${m[1]}/${m[2]}/${m[3]}`);
  } else {
    console.log(`FAILED ${resource} ${err?.message ?? 'unknown error'}`);
  }
}

async function main() {
  loadDotEnv();
  if (!process.env.PROBE_URL) {
    console.error('PROBE_URL is required');
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.TELNYX_API_KEY) {
    console.error('TELNYX_API_KEY is required');
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.MCP_TOKEN) {
    console.error('MCP_TOKEN is required');
    process.exit(1);
  }

  const tools = await readJson('assistant/probe/tools.json');
  const mcp = await readJson('assistant/probe/mcp.json');
  const assistant = await readJson('assistant/probe/assistant.json');

  const flowErrors = validateFlow(assistant.conversation_flow);
  if (flowErrors.length > 0) {
    for (const e of flowErrors) console.log(`FAILED flow ${e}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`validateFlow: []`);
    const vars = { PROBE_URL: process.env.PROBE_URL, ...DRY_VARS };
    for (const tool of resolvePlaceholders(tools, vars)) {
      console.log(`tool:${tool.display_name} ${JSON.stringify(tool)}`);
    }
    const mcpResolved = resolvePlaceholders(mcp.server, vars);
    console.log(`mcp_server:${mcpResolved.name} ${JSON.stringify(mcpResolved)}`);
    const secretResolved = { identifier: SECRET_IDENTIFIER, type: mcp.integration_secret.type };
    console.log(`integration_secret:${SECRET_IDENTIFIER} ${JSON.stringify(secretResolved)}`);
    const assistantResolved = resolvePlaceholders(assistant, vars);
    console.log(`assistant:${assistantResolved.name} ${JSON.stringify(assistantResolved)}`);
    return;
  }

  const vars = { PROBE_URL: process.env.PROBE_URL, ...DRY_VARS };
  const state = {};
  let exitCode = 0;

  // integration secret (identifier is the name; token is never printed)
  try {
    const list = unwrap(await telnyx('/v2/integration_secrets'));
    const existing = findByName(list, 'identifier', SECRET_IDENTIFIER);
    const sentSubset = {
      identifier: SECRET_IDENTIFIER,
      type: mcp.integration_secret.type,
    };
    if (existing) {
      console.log(`exists integration_secret ${SECRET_IDENTIFIER}`);
    } else {
      await telnyx('/v2/integration_secrets', {
        method: 'POST',
        body: { ...sentSubset, token: process.env.MCP_TOKEN },
      });
      console.log(`created integration_secret ${SECRET_IDENTIFIER}`);
    }
    const after = unwrap(await telnyx('/v2/integration_secrets'));
    const got = findByName(after, 'identifier', SECRET_IDENTIFIER);
    printDrift('integration_secret', subsetDiff(sentSubset, got ?? undefined));
    state.integration_secret = SECRET_IDENTIFIER;
  } catch (err) {
    reportFailure('integration_secret', err);
    exitCode = 1;
  }

  // mcp server
  try {
    const resolved = resolvePlaceholders(mcp.server, vars);
    const list = unwrap(await telnyx('/v2/ai/mcp_servers'));
    const existing = findByName(list, 'name', MCP_NAME);
    let saved;
    if (existing) {
      console.log(`exists mcp_server ${existing.id}`);
      saved = unwrap(
        await telnyx(`/v2/ai/mcp_servers/${existing.id}`, {
          method: 'PUT',
          body: resolved,
        }),
      );
    } else {
      saved = unwrap(await telnyx('/v2/ai/mcp_servers', { method: 'POST', body: resolved }));
      console.log(`created mcp_server ${saved?.id ?? ''}`);
    }
    if (saved?.id) {
      const got = unwrap(await telnyx(`/v2/ai/mcp_servers/${saved.id}`));
      printDrift('mcp_server', subsetDiff(resolved, got));
      state.mcp_server = saved.id;
      vars.MCP_ID = saved.id;
    }
  } catch (err) {
    reportFailure('mcp_server', err);
    exitCode = 1;
  }

  // shared tools
  state.tools = {};
  for (const tool of tools) {
    try {
      const resolved = resolvePlaceholders(tool, vars);
      const name = tool.display_name;
      const list = unwrap(await telnyx('/v2/ai/tools'));
      const existing = findByName(list, 'display_name', name);
      let saved;
      if (existing) {
        console.log(`exists tool:${name} ${existing.id}`);
        saved = unwrap(
          await telnyx(`/v2/ai/tools/${existing.id}`, {
            method: 'PATCH',
            body: resolved,
          }),
        );
      } else {
        saved = unwrap(await telnyx('/v2/ai/tools', { method: 'POST', body: resolved }));
        console.log(`created tool ${saved?.id ?? ''}`);
      }
      if (saved?.id) {
        const got = unwrap(await telnyx(`/v2/ai/tools/${saved.id}`));
        printDrift(`tool:${name}`, subsetDiff(resolved, got));
        state.tools[name] = saved.id;
        vars[`TOOL_${name}`] = saved.id;
      }
    } catch (err) {
      reportFailure(`tool:${tool.display_name}`, err);
      exitCode = 1;
    }
  }

  // assistant
  try {
    const resolved = resolvePlaceholders(assistant, vars);
    const list = unwrap(await telnyx('/v2/ai/assistants'));
    const existing = findByName(list, 'name', ASSISTANT_NAME);
    let saved;
    if (existing) {
      console.log(`exists assistant ${existing.id}`);
      saved = unwrap(
        await telnyx(`/v2/ai/assistants/${existing.id}`, {
          method: 'POST',
          body: resolved,
        }),
      );
    } else {
      saved = unwrap(await telnyx('/v2/ai/assistants', { method: 'POST', body: resolved }));
      console.log(`created assistant ${saved?.id ?? ''}`);
    }
    if (saved?.id) {
      const got = unwrap(await telnyx(`/v2/ai/assistants/${saved.id}`));
      printDrift('assistant', subsetDiff(resolved, got));
      state.assistant = saved.id;
    }
  } catch (err) {
    reportFailure('assistant', err);
    exitCode = 1;
  }

  mkdirSync(join(ROOT, '.state'), { recursive: true });
  writeFileSync(
    join(ROOT, '.state', 'probe.json'),
    JSON.stringify(state, null, 2) + '\n',
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
