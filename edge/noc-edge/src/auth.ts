import { constantTimeEqual } from "../../shared/src/ids";

export function parseBearer(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const parts = header.split(" ");
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  const token = parts[1].trim();
  if (token.length === 0) return null;
  return token;
}

export function bearerOk(
  header: string | null | undefined,
  expected: string,
): boolean {
  const token = parseBearer(header);
  if (token === null) return false;
  return constantTimeEqual(token, expected);
}

export type SecretGetter = () => Promise<string | null>;

export function makeTokenCache(get: SecretGetter): SecretGetter {
  let cached: string | null = null;
  let resolved = false;
  return async (): Promise<string | null> => {
    if (resolved) return cached;
    const value = await get();
    if (typeof value === "string" && value.length > 0) {
      cached = value;
      resolved = true;
    }
    return value;
  };
}
