const TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolvePlaceholders(value, vars) {
  if (typeof value === 'string') {
    return value.replace(TOKEN_RE, (token, name) => {
      if (vars[name] === undefined) {
        throw new Error(`unresolved placeholder ${token}`);
      }
      return String(vars[name]);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, vars));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = resolvePlaceholders(value[key], vars);
    }
    return out;
  }
  return value;
}

export function unwrap(res) {
  if (res !== null && typeof res === 'object' && 'data' in res) {
    return res.data;
  }
  return res;
}

export function findByName(list, field, name) {
  if (!Array.isArray(list)) return undefined;
  return list.find((item) => item?.[field] === name);
}

export async function listAll(path, fetchJson) {
  const items = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchJson(`${path}${sep}page[size]=100&page[number]=${page}`);
    const list = Array.isArray(res?.data) ? res.data : [];
    items.push(...list);
    const totalPages = res?.meta?.total_pages;
    if (!Number.isInteger(totalPages) || page >= totalPages) break;
    page += 1;
  }
  return items;
}

export function normaliseToolReadback(got) {
  if (
    got !== null &&
    typeof got === 'object' &&
    !Array.isArray(got) &&
    typeof got.type === 'string' &&
    got.tool_definition !== null &&
    typeof got.tool_definition === 'object' &&
    !Array.isArray(got.tool_definition)
  ) {
    return { ...got, [got.type]: got.tool_definition };
  }
  return got;
}

export function normaliseAssistantReadback(got) {
  if (
    got !== null &&
    typeof got === 'object' &&
    !Array.isArray(got) &&
    Array.isArray(got.tools)
  ) {
    return { ...got, tool_ids: got.tools.map((t) => t?.tool_id) };
  }
  return got;
}

const E164_RE = /\+[0-9]{7,15}\b/g;

export function maskSecrets(text) {
  return text.replace(E164_RE, (m) =>
    m.length <= 8 ? `${m.slice(0, 5)}****` : `${m.slice(0, 5)}****${m.slice(-3)}`,
  );
}

export function subsetDiff(sent, got, path = '') {
  const diffs = [];
  const child = (key) => (path ? `${path}.${key}` : String(key));
  if (Array.isArray(sent)) {
    if (!Array.isArray(got)) {
      return [{ path, sent, got }];
    }
    sent.forEach((item, index) => {
      diffs.push(...subsetDiff(item, got[index], `${path}.${index}`));
    });
    return diffs;
  }
  if (sent !== null && typeof sent === 'object') {
    if (got === null || typeof got !== 'object' || Array.isArray(got)) {
      return [{ path, sent, got }];
    }
    for (const key of Object.keys(sent)) {
      if (!(key in got)) {
        diffs.push({ path: child(key), sent: sent[key], got: undefined });
        continue;
      }
      diffs.push(...subsetDiff(sent[key], got[key], child(key)));
    }
    return diffs;
  }
  if (sent !== got) {
    diffs.push({ path, sent, got });
  }
  return diffs;
}
