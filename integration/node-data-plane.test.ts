import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpShardTransport, type CapabilityRequest } from "../packages/storage/src";
import { sha256 } from "../packages/core/src";
import { encodeBase64Url, storageReceiptSchema, verifyEnvelope, type StorageCapability } from "../packages/protocol/src";
import { issueCapability, receiptMatchesCapability } from "../apps/api/src/lib/node-crypto";
import { nodeBinary } from "./node-binary";

type IdentityFile = { nodeId: string; publicKey: string };

describe("local browser-control-node data path", () => {
  let dataDirectory = "";
  let endpoint = "";
  let nodeProcess: ReturnType<typeof Bun.spawn> | undefined;
  let capabilityPrivateKey = "";
  let nodeIdentity: IdentityFile;

  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "horcrux-node-integration-"));
    const port = await reservePort();
    endpoint = `http://127.0.0.1:${port}`;
    const controlKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    capabilityPrivateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", controlKeys.privateKey)));
    const capabilityPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", controlKeys.publicKey)));
    const binary = await nodeBinary();
    nodeProcess = Bun.spawn([
      binary,
      "--data-dir", dataDirectory,
      "--listen", `127.0.0.1:${port}`,
      "--control-plane-public-key", capabilityPublicKey,
      "--web-origin", "http://localhost:5173",
    ], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, GOCACHE: "/tmp/horcrux-go-cache", GOMODCACHE: "/tmp/horcrux-go-mod" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForNode(endpoint, nodeProcess);
    nodeIdentity = JSON.parse(await readFile(join(dataDirectory, "identity.json"), "utf8")) as IdentityFile;
  }, 30_000);

  afterAll(async () => {
    nodeProcess?.kill();
    if (nodeProcess) await nodeProcess.exited;
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  });

  test("stores, confirms, retrieves, and deletes one opaque object", async () => {
    const fileId = crypto.randomUUID();
    const objectId = `${fileId}/shard/${crypto.randomUUID()}`;
    const bytes = crypto.getRandomValues(new Uint8Array(16 * 1024));
    const checksum = await sha256(bytes);
    let receiptAccepted = false;
    const issued = new Map<string, StorageCapability>();
    const transport = new HttpShardTransport({
      resolveEndpoint: () => endpoint,
      requestCapability: async (request) => {
        const capability = makeCapability(request, nodeIdentity.nodeId);
        issued.set(capability.jti, capability);
        return issueCapability(capability, capabilityPrivateKey);
      },
      submitReceipt: async ({ receipt }) => {
        const verified = await verifyEnvelope(receipt, nodeIdentity.publicKey, storageReceiptSchema);
        const capability = issued.get(verified.requestId);
        expect(capability).toBeDefined();
        expect(receiptMatchesCapability(verified, capability!)).toBeTrue();
        receiptAccepted = true;
      },
    });

    const stored = await transport.putShard(nodeIdentity.nodeId, objectId, bytes, { checksum });
    expect(stored).toMatchObject({ nodeId: nodeIdentity.nodeId, objectId, checksum, size: bytes.byteLength });
    expect(receiptAccepted).toBeTrue();
    expect(await transport.getShard(nodeIdentity.nodeId, objectId)).toEqual(bytes);

    const unauthorized = await fetch(`${endpoint}/objects/${objectId}`);
    expect(unauthorized.status).toBe(401);

    await transport.deleteShard(nodeIdentity.nodeId, objectId);
    await expect(transport.getShard(nodeIdentity.nodeId, objectId)).rejects.toMatchObject({ status: 404, code: "object_not_found" });
  }, 30_000);
});

function makeCapability(request: CapabilityRequest, nodeId: string): StorageCapability {
  const now = Math.floor(Date.now() / 1_000);
  return {
    version: "1",
    issuer: "horcrux-control-plane",
    nodeId,
    objectId: request.objectId,
    operation: request.operation,
    issuedAt: now,
    expiresAt: now + 60,
    jti: crypto.randomUUID(),
    ...(request.checksum ? { checksum: request.checksum } : {}),
    ...(request.size !== undefined ? { size: request.size } : {}),
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an integration-test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForNode(endpoint: string, process: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      const error = await new Response(process.stderr).text();
      throw new Error(`Go node exited before startup: ${error}`);
    }
    if (await fetch(`${endpoint}/health`).then((response) => response.ok).catch(() => false)) return;
    await Bun.sleep(100);
  }
  process.kill();
  const exit = await process.exited;
  const [output, error] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
  throw new Error(`Go node did not become healthy (exit ${exit}): ${output}${error}`);
}
