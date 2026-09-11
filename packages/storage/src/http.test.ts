import { describe, expect, test } from "bun:test";
import { HttpShardTransport, NodeTransportError, type CapabilityRequest } from "./http";

describe("HTTP shard transport", () => {
  test("uses scoped grants and submits a signed PUT receipt", async () => {
    const capabilities: CapabilityRequest[] = [];
    const receipts: Array<{ nodeId: string; fileId: string; receipt: string }> = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const checksum = "a".repeat(64);
    const objectId = "file-id/shard/object-id";
    const transport = new HttpShardTransport({
      resolveEndpoint: () => "http://127.0.0.1:9443/",
      requestCapability: async (request) => {
        capabilities.push(request);
        return "signed-capability";
      },
      submitReceipt: async (receipt) => { receipts.push(receipt); },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ nodeId: "node-a", objectId, checksum, size: 3, receipt: "signed-receipt" }, { status: 201 });
      },
    });

    const stored = await transport.putShard("node-a", objectId, new Uint8Array([1, 2, 3]), { checksum });

    expect(stored).toEqual({ nodeId: "node-a", objectId, checksum, size: 3 });
    expect(capabilities).toEqual([{ nodeId: "node-a", fileId: "file-id", objectId, operation: "PUT", checksum, size: 3 }]);
    expect(receipts).toEqual([{ nodeId: "node-a", fileId: "file-id", receipt: "signed-receipt" }]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9443/objects/file-id/shard/object-id");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer signed-capability");
    expect(calls[0]?.init?.body).toBeInstanceOf(Uint8Array);
  });

  test("retrieves bytes with GET scope and preserves node errors", async () => {
    const operations: string[] = [];
    const transport = new HttpShardTransport({
      resolveEndpoint: () => "https://node.example",
      requestCapability: async (request) => {
        operations.push(request.operation);
        return "grant";
      },
      submitReceipt: async () => {},
      fetch: async (_url, init) => init?.method === "GET"
        ? new Response(new Uint8Array([4, 5, 6]))
        : Response.json({ error: { code: "node_busy", message: "Node is busy", retryable: true } }, { status: 503 }),
    });

    expect(await transport.getShard("node-a", "file-id/shard/object-id")).toEqual(new Uint8Array([4, 5, 6]));
    await expect(transport.deleteShard("node-a", "file-id/shard/object-id")).rejects.toEqual(
      new NodeTransportError("Node is busy", 503, "node_busy", true),
    );
    expect(operations).toEqual(["GET", "DELETE"]);
  });

  test("rejects insecure remote endpoints", async () => {
    const transport = new HttpShardTransport({
      resolveEndpoint: () => "http://node.example",
      requestCapability: async () => "grant",
      submitReceipt: async () => {},
      fetch: async () => new Response(),
    });
    expect(await transport.healthCheck("node-a")).toBeFalse();
  });
});
