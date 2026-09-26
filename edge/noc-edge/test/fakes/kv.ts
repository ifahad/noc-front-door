import type { KvPort } from "../../src/services/kvPort";

export interface KvCall {
  op: "get" | "put" | "delete";
  key: string;
}

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class FakeKv implements KvPort {
  private map = new Map<string, Entry>();
  private failures: Error[] = [];
  nowMs = 0;
  readonly calls: KvCall[] = [];

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  failNext(count: number, message = "injected_kv_error"): void {
    for (let i = 0; i < count; i++) {
      this.failures.push(new Error(message));
    }
  }

  private check(op: KvCall["op"], key: string): void {
    this.calls.push({ op, key });
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
  }

  async get(key: string): Promise<string | null> {
    this.check("get", key);
    const entry = this.map.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && this.nowMs >= entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.check("put", key);
    const ttl = opts?.expirationTtl;
    this.map.set(key, {
      value,
      expiresAt:
        typeof ttl === "number" && ttl > 0 ? this.nowMs + ttl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.check("delete", key);
    this.map.delete(key);
  }

  has(key: string): boolean {
    const entry = this.map.get(key);
    return (
      entry !== undefined &&
      (entry.expiresAt === null || this.nowMs < entry.expiresAt)
    );
  }

  raw(key: string): string | null {
    const entry = this.map.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && this.nowMs >= entry.expiresAt) return null;
    return entry.value;
  }

  ttlSecondsLeft(key: string): number | null {
    const entry = this.map.get(key);
    if (entry === undefined || entry.expiresAt === null) return null;
    return Math.round((entry.expiresAt - this.nowMs) / 1000);
  }

  puts(key: string): number {
    return this.calls.filter((c) => c.op === "put" && c.key === key).length;
  }
}
