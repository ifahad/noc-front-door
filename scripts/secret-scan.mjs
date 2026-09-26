import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY_BODY_RE = '[A-Za-z0-9_]{20,}';
const PATTERNS = [
  ['telnyx-key', new RegExp(`\\bKEY${KEY_BODY_RE}\\b`, 'g')],
  ['bearer', /\bBearer[ \t]+[A-Za-z0-9._-]{12,}/g],
  ['e164', /\+[0-9]{7,15}\b/g],
];

function findingsForLine(line, lineNo, envSecrets, findings) {
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(line)) {
      findings.push({ line: lineNo, kind });
    }
  }
  for (const secret of envSecrets) {
    if (line.includes(secret)) {
      findings.push({ line: lineNo, kind: 'env-secret' });
      break;
    }
  }
}

export function scanText(text, { envSecrets = [] } = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    findingsForLine(lines[i], i + 1, envSecrets, findings);
  }
  return findings;
}

function loadEnvSecrets(envPath) {
  if (!existsSync(envPath)) return [];
  const secrets = [];
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!value || value.startsWith('{env:')) continue;
    if (value.length < 8) continue;
    secrets.push(value);
  }
  return secrets;
}

function stagedFiles() {
  const out = execSync('git diff --cached --name-only -z', {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function main() {
  const envSecrets = loadEnvSecrets('.env');
  let failed = false;
  for (const file of stagedFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!isText(text)) continue;
    for (const finding of scanText(text, { envSecrets })) {
      failed = true;
      console.log(`${file}:${finding.line}:${finding.kind}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

function isText(text) {
  return !text.includes('\0');
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  main();
}
