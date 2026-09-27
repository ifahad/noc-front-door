import type { KvNamespace } from "@telnyx/edge-runtime";

export interface KvPutOpts {
  expirationTtl?: number;
}

export interface KvPort {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: KvPutOpts): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export function bindingKvPort(kv: KvNamespace): KvPort {
  return {
    get: (key: string) => kv.get(key),
    put: (key: string, value: string, opts?: KvPutOpts) =>
      kv.put(key, value, opts ?? {}),
    delete: (key: string) => kv.delete(key),
    list: async (prefix: string) => {
      const names: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await kv.list(
          cursor === undefined ? { prefix } : { prefix, cursor },
        );
        for (const entry of page.keys) names.push(entry.name);
        if (page.list_complete) break;
        cursor = page.cursor;
      }
      return names;
    },
  };
}
