#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, telnyx } from './lib/telnyx.mjs';
import {
  findByName,
  listAll,
  maskSecrets,
  normaliseAssistantReadback,
  normaliseToolReadback,
  resolvePlaceholders,
  subsetDiff,
  unwrap,
} from './lib/apply-core.mjs';
import { validateAssistant, validateFlow } from './lib/flow-validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE_PROBE = process.argv.includes('--prune-probe');
const ASSISTANT_NAME = 'sanad-noc';
const MCP_NAME = 'noc-mcp';
const SECRET_IDENTIFIER = 'noc_mcp_token';
const MCP_TOOLS = [
  'find_site',
  'get_site_status',
  'check_known_incidents',
  'get_ticket_status',
  'add_ticket_note',
];
const PROBE_TOOL_PREFIX = 'probe_';
const PROBE_MCP_NAME = 'noc-mcp-probe';
const DEFAULT_EDGE_URL = 'https://noc-edge-41d2a334-7.telnyxcompute.com';

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

async function readText(rel) {
  return readFile(join(ROOT, rel), 'utf8');
}

function printDrift(resource, diffs) {
  for (const d of diffs) {
    const sent = maskSecrets(JSON.stringify(d.sent));
    const got = maskSecrets(JSON.stringify(d.got ?? null));
    console.log(`DRIFT ${resource} ${d.path} sent=${sent} got=${got}`);
  }
}

function reportFailure(resource, err) {
  const m = /-> (\d+) (\S+) (.+)$/.exec(err?.message ?? '');
  if (m) {
    console.log(`FAILED ${resource} ${m[1]}/${m[2]}/${maskSecrets(m[3])}`);
  } else {
    console.log(`FAILED ${resource} ${maskSecrets(err?.message ?? 'unknown error')}`);
  }
}

async function main() {
  loadDotEnv();
  const EDGE_URL = process.env.EDGE_URL ?? DEFAULT_EDGE_URL;
  if (!DRY_RUN && !process.env.TELNYX_API_KEY) {
    console.error('TELNYX_API_KEY is required');
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.ONCALL_NUMBER) {
    console.error('ONCALL_NUMBER is required');
    process.exit(1);
  }

  const tools = await readJson('assistant/tools.json');
  const mcp = await readJson('assistant/mcp.json');
  const assistant = await readJson('assistant/assistant.json');
  assistant.instructions = await readText('assistant/instructions.md');

  const toolNames = tools.map((t) => t.display_name);
  const dryVars = {
    EDGE_URL,
    ONCALL_NUMBER: process.env.ONCALL_NUMBER ?? 'DRYRUN_ONCALL_NUMBER',
    MCP_ID: 'DRYRUN_noc-mcp',
  };
  for (const name of toolNames) {
    dryVars[`TOOL_${name}`] = `DRYRUN_${name}`;
  }

  const flowErrors = validateFlow(assistant.conversation_flow, {
    requireHumanExits: true,
  });
  const assistantErrors = validateAssistant(assistant);
  if (flowErrors.length > 0 || assistantErrors.length > 0) {
    for (const e of flowErrors) console.log(`FAILED flow ${e}`);
    for (const e of assistantErrors) console.log(`FAILED assistant ${e}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(`validateFlow: []`);
    console.log(`validateAssistant: []`);
    for (const tool of resolvePlaceholders(tools, dryVars)) {
      const url = tool.webhook?.url ?? '';
      console.log(`tool:${tool.display_name} type=${tool.type} ${url}`);
    }
    const mcpResolved = resolvePlaceholders(mcp.server, dryVars);
    console.log(`mcp_server:${mcpResolved.name} ${mcpResolved.url}`);
    console.log(`integration_secret:${SECRET_IDENTIFIER} skip-if-exists`);
    const flow = assistant.conversation_flow;
    console.log(
      `assistant:${assistant.name} nodes=${flow.nodes.length} edges=${flow.edges.length} start=${flow.start_node_id} tool_ids=1 mcp_servers=1`,
    );
    console.log('placeholders: all resolved');
    return;
  }

  const vars = { EDGE_URL, ONCALL_NUMBER: process.env.ONCALL_NUMBER };
  const state = {};
  let exitCode = 0;

  // integration secret (identifier is the name; token is never printed)
  try {
    const list = await listAll('/v2/integration_secrets', telnyx);
    const existing = findByName(list, 'identifier', SECRET_IDENTIFIER);
    const sentSubset = {
      identifier: SECRET_IDENTIFIER,
      type: mcp.integration_secret.type,
    };
    if (existing) {
      console.log(`exists integration_secret ${SECRET_IDENTIFIER}`);
    } else if (process.env.MCP_TOKEN) {
      await telnyx('/v2/integration_secrets', {
        method: 'POST',
        body: { ...sentSubset, token: process.env.MCP_TOKEN },
      });
      console.log(`created integration_secret ${SECRET_IDENTIFIER}`);
    } else {
      throw new Error(
        'integration secret noc_mcp_token missing; set MCP_TOKEN to create it',
      );
    }
    const after = await listAll('/v2/integration_secrets', telnyx);
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
    const list = await listAll('/v2/ai/mcp_servers', telnyx);
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
      saved = unwrap(
        await telnyx('/v2/ai/mcp_servers', { method: 'POST', body: resolved }),
      );
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
      const list = await listAll('/v2/ai/tools', telnyx);
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
        const got = normaliseToolReadback(unwrap(await telnyx(`/v2/ai/tools/${saved.id}`)));
        printDrift(`tool:${name}`, subsetDiff(resolved, got));
        state.tools[name] = saved.id;
        vars[`TOOL_${name}`] = saved.id;
      }
    } catch (err) {
      reportFailure(`tool:${tool.display_name}`, err);
      exitCode = 1;
    }
  }

  // assistant (update in place; never create a second, never delete)
  let assistantOk = false;
  try {
    const resolved = resolvePlaceholders(assistant, vars);
    const list = await listAll('/v2/ai/assistants', telnyx);
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
      saved = unwrap(
        await telnyx('/v2/ai/assistants', { method: 'POST', body: resolved }),
      );
      console.log(`created assistant ${saved?.id ?? ''}`);
    }
    if (saved?.id) {
      const got = normaliseAssistantReadback(unwrap(await telnyx(`/v2/ai/assistants/${saved.id}`)));
      printDrift('assistant', subsetDiff(resolved, got));
      const nameById = new Map(
        Object.entries(state.tools).map(([name, id]) => [id, name]),
      );
      const readbackErrors = validateAssistant(got, {
        toolName: (id) => nameById.get(String(id)) ?? null,
      });
      if (readbackErrors.length > 0) {
        for (const e of readbackErrors) {
          console.log(`FAILED assistant-readback ${e}`);
        }
        exitCode = 1;
      } else {
        console.log('assistant-readback: validateAssistant []');
      }
      state.assistant = saved.id;
      assistantOk = true;
    }
  } catch (err) {
    reportFailure('assistant', err);
    exitCode = 1;
  }

  // prune the probe leftovers only after the assistant update succeeded
  if (PRUNE_PROBE && assistantOk) {
    try {
      const list = await listAll('/v2/ai/tools', telnyx);
      for (const item of list) {
        if (
          typeof item?.display_name === 'string' &&
          item.display_name.startsWith(PROBE_TOOL_PREFIX)
        ) {
          await telnyx(`/v2/ai/tools/${item.id}`, { method: 'DELETE' });
          console.log(`pruned tool:${item.display_name} ${item.id}`);
        }
      }
      const mcpList = await listAll('/v2/ai/mcp_servers', telnyx);
      const probeMcp = findByName(mcpList, 'name', PROBE_MCP_NAME);
      if (probeMcp) {
        await telnyx(`/v2/ai/mcp_servers/${probeMcp.id}`, { method: 'DELETE' });
        console.log(`pruned mcp_server ${probeMcp.name} ${probeMcp.id}`);
      }
    } catch (err) {
      reportFailure('prune-probe', err);
      exitCode = 1;
    }
  }

  mkdirSync(join(ROOT, '.state'), { recursive: true });
  writeFileSync(
    join(ROOT, '.state', 'assistant.json'),
    JSON.stringify(state, null, 2) + '\n',
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(maskSecrets(err?.message ?? String(err)));
  process.exit(1);
});
