import type { ReportBucket } from "../../src/services/reports";

interface Stored {
  body: string;
  size: number;
  uploaded: Date;
  contentType: string | undefined;
}

// In-memory stand-in for the Cloud Storage bucket binding. The map is the
// bucket; failures/delays are injected so tests can exercise the deadline and
// fail-open paths without any network.
export class FakeBucket implements ReportBucket {
  private map = new Map<string, Stored>();
  private putFailures: Error[] = [];
  private getFailures: Error[] = [];
  private listFailures: Error[] = [];
  nowMs = Date.UTC(2026, 8, 27, 7, 0, 0);
  putDelayMs = 0;
  getDelayMs = 0;
  listDelayMs = 0;

  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  failNextPut(count: number, message = "injected_bucket_error"): void {
    for (let i = 0; i < count; i++) this.putFailures.push(new Error(message));
  }

  failNextGet(count: number, message = "injected_bucket_error"): void {
    for (let i = 0; i < count; i++) this.getFailures.push(new Error(message));
  }

  failNextList(count: number, message = "injected_bucket_error"): void {
    for (let i = 0; i < count; i++) this.listFailures.push(new Error(message));
  }

  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async put(
    key: string,
    body: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    await this.wait(this.putDelayMs);
    const failure = this.putFailures.shift();
    if (failure !== undefined) throw failure;
    this.map.set(key, {
      body,
      size: new TextEncoder().encode(body).length,
      uploaded: new Date(this.nowMs),
      contentType: options?.httpMetadata?.contentType,
    });
    return { key, etag: `etag-${key}`, size: this.map.get(key)!.size };
  }

  async get(key: string): Promise<{
    key: string;
    size: number;
    uploaded: Date;
    json(): Promise<unknown>;
    text(): Promise<string>;
  } | null> {
    await this.wait(this.getDelayMs);
    const failure = this.getFailures.shift();
    if (failure !== undefined) throw failure;
    const entry = this.map.get(key);
    if (entry === undefined) return null;
    return {
      key,
      size: entry.size,
      uploaded: entry.uploaded,
      json: async () => JSON.parse(entry.body) as unknown,
      text: async () => entry.body,
    };
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{
    objects: { key: string; size?: number; uploaded?: Date }[];
  }> {
    await this.wait(this.listDelayMs);
    const failure = this.listFailures.shift();
    if (failure !== undefined) throw failure;
    const prefix = options?.prefix ?? "";
    const objects = [...this.map.keys()]
      .sort()
      .filter((key) => key.startsWith(prefix))
      .slice(0, options?.limit ?? Infinity)
      .map((key) => {
        const entry = this.map.get(key)!;
        return { key, size: entry.size, uploaded: entry.uploaded };
      });
    return { objects };
  }

  raw(key: string): string | null {
    return this.map.get(key)?.body ?? null;
  }

  contentTypeOf(key: string): string | undefined {
    return this.map.get(key)?.contentType;
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}
