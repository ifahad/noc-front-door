import type { ActorContext, ActorStorage, Env, ListOptions } from "@telnyx/edge-runtime";
import { SiteState } from "../../src/SiteState";

export class FakeStorage {
  private map = new Map<string, unknown>();
  private alarm: number | null = null;
  readonly calls: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async list<T>(options?: ListOptions): Promise<Map<string, T>> {
    const keys = [...this.map.keys()].sort();
    const result = new Map<string, T>();
    for (const key of keys) {
      if (options?.prefix !== undefined && !key.startsWith(options.prefix)) continue;
      if (options?.start !== undefined && key < options.start) continue;
      if (options?.startAfter !== undefined && key <= options.startAfter) continue;
      if (options?.end !== undefined && key >= options.end) continue;
      const value = structuredClone(this.map.get(key)) as T;
      result.set(key, value);
    }
    if (options?.reverse) {
      const entries = [...result.entries()].reverse();
      result.clear();
      for (const [key, value] of entries) result.set(key, value);
    }
    if (options?.limit !== undefined) {
      const entries = [...result.entries()].slice(0, options.limit);
      result.clear();
      for (const [key, value] of entries) result.set(key, value);
    }
    return result;
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(when: number): Promise<void> {
    this.alarm = when;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
    this.calls.push("deleteAlarm");
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }

  raw(key: string): unknown {
    return structuredClone(this.map.get(key));
  }
}

const fakeStorageToActorStorage = (storage: FakeStorage): ActorStorage =>
  storage as unknown as ActorStorage;

export interface ActorHarness {
  actor: SiteState;
  storage: FakeStorage;
  name: string;
}

export function makeSiteState(name: string): ActorHarness {
  const storage = new FakeStorage();
  const ctx: ActorContext = {
    id: name,
    storage: fakeStorageToActorStorage(storage),
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    setAlarm: (when: number) => storage.setAlarm(when),
    count: () => 0,
    broadcast: () => 0,
    sockets: () => [],
  };
  return { actor: new SiteState(ctx, {} as Env), storage, name };
}
