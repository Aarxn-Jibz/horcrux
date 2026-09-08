import { describe, expect, test } from "bun:test";
import { MemoryShardTransport } from "./memory";

describe("mock storage network", () => {
  test("stores independent copies and simulates failures", async () => {
    const storage = new MemoryShardTransport(["a", "b"]); const bytes = new Uint8Array([1, 2, 3]);
    await storage.putShard("a", "object", bytes); bytes[0] = 9;
    expect(await storage.getShard("a", "object")).toEqual(new Uint8Array([1, 2, 3]));
    storage.setNodeAvailable("a", false);
    expect(await storage.healthCheck("a")).toBeFalse();
    await expect(storage.getShard("a", "object")).rejects.toThrow("unavailable");
  });
});
