import type { ActorStorage, ListOptions } from "@telnyx/edge-runtime";

export type PrefixedStorage = Pick<
  ActorStorage,
  "get" | "put" | "delete" | "list" | "deleteAll" | "getAlarm" | "setAlarm" | "deleteAlarm"
>;

const PAGE = 1000;

async function listInner<T>(
  storage: ActorStorage,
  innerPrefix: string,
): Promise<Array<[string, T]>> {
  const out: Array<[string, T]> = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({ prefix: innerPrefix, limit: PAGE, startAfter });
    for (const [key, value] of page) out.push([key, value]);
    if (page.size < PAGE) break;
    startAfter = [...page.keys()][page.size - 1];
  }
  return out;
}

async function listScoped<T>(
  storage: ActorStorage,
  prefix: string,
  options?: ListOptions,
): Promise<Map<string, T>> {
  const rows = await listInner<T>(storage, prefix + (options?.prefix ?? ""));
  let stripped = rows.map(
    ([key, value]) => [key.slice(prefix.length), value] as [string, T],
  );
  if (options?.start !== undefined) {
    const start = options.start;
    stripped = stripped.filter(([key]) => key >= start);
  }
  if (options?.startAfter !== undefined) {
    const startAfter = options.startAfter;
    stripped = stripped.filter(([key]) => key > startAfter);
  }
  if (options?.end !== undefined) {
    const end = options.end;
    stripped = stripped.filter(([key]) => key < end);
  }
  if (options?.reverse === true) stripped.reverse();
  if (options?.limit !== undefined) stripped = stripped.slice(0, options.limit);
  return new Map(stripped);
}

async function deleteScoped(storage: ActorStorage, prefix: string): Promise<void> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list({ prefix, limit: PAGE, startAfter });
    for (const key of page.keys()) await storage.delete(key);
    if (page.size < PAGE) break;
    startAfter = [...page.keys()][page.size - 1];
  }
}

export function prefixedStorage(storage: ActorStorage, prefix: string): PrefixedStorage {
  return {
    get: <T,>(key: string) => storage.get<T>(prefix + key),
    put: <T,>(key: string, value: T) => storage.put(prefix + key, value),
    delete: (key: string) => storage.delete(prefix + key),
    list: <T,>(options?: ListOptions) => listScoped<T>(storage, prefix, options),
    deleteAll: () => deleteScoped(storage, prefix),
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
}
