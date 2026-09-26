import { readFileSync } from 'node:fs';

const API_BASE = 'https://api.telnyx.com';

export async function telnyx(path, { method = 'GET', body } = {}) {
  const init = {
    method,
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let code = 'unknown';
    let title = res.statusText || 'request failed';
    try {
      const parsed = await res.json();
      const err = parsed?.errors?.[0];
      if (err?.code) code = String(err.code);
      if (err?.title) title = String(err.title);
    } catch {
      // non-JSON error body: keep defaults
    }
    throw new Error(`telnyx ${method} ${path} -> ${res.status} ${code} ${title}`);
  }
  return res.json();
}

export function loadDotEnv(path = '.env') {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.length >= 2 &&
        value.startsWith('"') &&
        value.endsWith('"')) ||
      (value.length >= 2 &&
        value.startsWith("'") &&
        value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
