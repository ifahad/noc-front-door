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
