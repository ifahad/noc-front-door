import type { KvNamespace } from "@telnyx/edge-runtime";

export interface KvPutOpts {
  expirationTtl?: number;
}

export interface KvPort {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: KvPutOpts): Promise<void>;
  delete(key: string): Promise<void>;
}

export function bindingKvPort(kv: KvNamespace): KvPort {
  return {
    get: (key: string) => kv.get(key),
    put: (key: string, value: string, opts?: KvPutOpts) =>
      kv.put(key, value, opts ?? {}),
    delete: (key: string) => kv.delete(key),
  };
}
