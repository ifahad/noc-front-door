import { describe, expect, it } from "vitest";
import type { KvNamespace } from "@telnyx/edge-runtime";
import { bindingKvPort } from "../../src/services/kvPort";

function binding(): KvNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  } as unknown as KvNamespace;
}

describe("bindingKvPort", () => {
  it("returns the identical port for the same binding", () => {
    const kv = binding();
    expect(bindingKvPort(kv)).toBe(bindingKvPort(kv));
  });

  it("returns a different port for a different binding", () => {
    expect(bindingKvPort(binding())).not.toBe(bindingKvPort(binding()));
  });
});
