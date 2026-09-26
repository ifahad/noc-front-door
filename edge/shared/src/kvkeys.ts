const DISALLOWED = /[^-/_=.a-zA-Z0-9]/g;
const SLASH_RUN = /\/{2,}/g;

export function kvKey(...parts: string[]): string {
  const joined = parts.join("/");
  const stripped = joined.replace(DISALLOWED, "");
  const collapsed = stripped.replace(SLASH_RUN, "/");
  const trimmed = collapsed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") throw new Error("empty_kv_key");
  return trimmed;
}
