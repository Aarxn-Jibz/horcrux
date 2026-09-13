import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditedShamirProvider, BrowserFilePipeline, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, sha256 } from "../packages/core/src";
import { HttpShardTransport, type CapabilityRequest } from "../packages/storage/src";
import { DEFAULT_PIPELINE, type FileManifest } from "../packages/shared/src";
import { encodeBase64Url } from "../packages/protocol/src";

type Node = { endpoint: string; directory: string; process: ReturnType<typeof Bun.spawn>; id?: string; publicKey?: string };
type Session = { accessToken: string };

describe("five real Go nodes through the HTTP control plane", () => {
  let root = "";
  let apiProcess: ReturnType<typeof Bun.spawn> | undefined;
  let nodes: Node[] = [];
  let apiUrl = "";
  let session: Session;
  let original: Uint8Array;
  let originalHash = "";
  let manifest: FileManifest;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "horcrux-five-node-"));
    const apiPort = await reservePort();
    apiUrl = `http://127.0.0.1:${apiPort}`;
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)));
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const environmentFile = join(root, "api.env");
    await Bun.write(environmentFile, `JWT_SECRET=cluster-test-secret-${crypto.randomUUID()}\nWEB_ORIGIN=http://localhost:5173\nCAPABILITY_PRIVATE_KEY=${privateKey}\nCAPABILITY_PUBLIC_KEY=${publicKey}\n`);
    const persistence = join(root, "d1");
    await run(["./node_modules/.bin/wrangler", "d1", "migrations", "apply", "horcrux-file-system", "--local", "--persist-to", persistence], "apps/api");
    apiProcess = Bun.spawn([
      "./node_modules/.bin/wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(apiPort),
      "--persist-to", persistence, "--env-file", environmentFile, "--log-level", "error",
    ], { cwd: "apps/api", stdout: "pipe", stderr: "pipe" });
    await waitFor(() => fetch(`${apiUrl}/health`).then((response) => response.ok).catch(() => false), "control plane");
    session = await request<Session>("/auth/register", { method: "POST", body: JSON.stringify({ email: `cluster-${crypto.randomUUID()}@example.com`, password: "cluster-test-correct-horse" }) }, false);

    const binary = join(root, "horcrux-node");
    await run(["go", "build", "-o", binary, "./cmd/horcrux-node"], "apps/node");
    const ports = await Promise.all(Array.from({ length: 5 }, reservePort));
    nodes = await Promise.all(ports.map(async (port, index) => {
      const challenge = await request<{ challengeId: string; token: string }>("/devices/enrollment-challenges", { method: "POST" });
      const directory = join(root, `node-${index + 1}`);
      const child = Bun.spawn([
        binary,
        "--data-dir", directory,
        "--listen", `127.0.0.1:${port}`,
        "--advertise-url", `http://127.0.0.1:${port}`,
        "--control-plane-public-key", publicKey,
        "--control-plane-url", apiUrl,
        "--enrollment-challenge", challenge.challengeId,
        "--node-name", `cluster-node-${index + 1}`,
        "--web-origin", "http://localhost:5173",
      ], { env: { ...globalThis.process.env, HORCRUX_ENROLLMENT_TOKEN: challenge.token }, stdout: "pipe", stderr: "pipe" });
      const endpoint = `http://127.0.0.1:${port}`;
      await waitFor(() => fetch(`${endpoint}/health`).then((response) => response.ok).catch(() => false), `node ${index + 1}`);
      const identity = await Bun.file(join(directory, "identity.json")).json() as { publicKey: string };
      return { endpoint, directory, process: child, publicKey: identity.publicKey };
    }));
    await waitFor(async () => {
      const devices = await request<{ devices: Array<{ id: string; endpoint?: string; status: string; health: string; kind: string }> }>("/devices");
      const real = devices.devices.filter((device) => device.kind === "laptop" && device.status === "online" && device.health === "healthy");
      if (real.length !== 5 || new Set(real.map((device) => device.id)).size !== 5 || new Set(real.map((device) => device.endpoint)).size !== 5) return false;
      for (const node of nodes) node.id = real.find((device) => device.endpoint === node.endpoint)?.id;
      return nodes.every((node) => node.id);
    }, "five enrolled, healthy nodes", 45_000);
  }, 120_000);

  afterAll(async () => {
    for (const node of nodes) node.process.kill();
    await Promise.all(nodes.map((node) => node.process.exited.catch(() => 0)));
    apiProcess?.kill();
    if (apiProcess) await apiProcess.exited.catch(() => 0);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("enrolls five identities, uploads ten opaque objects, and reconstructs with all nodes", async () => {
    expect(new Set(nodes.map((node) => node.id)).size).toBe(5);
    expect(new Set(nodes.map((node) => node.publicKey)).size).toBe(5);
    console.log(`Five-node cluster: ${nodes.map((node) => `${node.id}=${node.endpoint}`).join(", ")}`);
    original = deterministicBytes(1_048_576);
    originalHash = await sha256(original);
    const fileId = crypto.randomUUID();
    const initialized = await request<{ nodes: Array<{ id: string; endpoint: string }> }>("/files/init", {
      method: "POST",
      body: JSON.stringify({ fileId, originalName: "cluster.bin", mimeType: "application/octet-stream", originalSize: original.byteLength, plaintextHash: originalHash, dataShards: 3, parityShards: 2, keyShareThreshold: 3, keyShareCount: 5, storageMode: "http" }),
    });
    expect(initialized.nodes).toHaveLength(5);
    expect(new Set(initialized.nodes.map((node) => node.id)).size).toBe(5);
    await request(`/files/${fileId}/state`, { method: "POST", body: JSON.stringify({ status: "distributing" }) });
    const endpoints = new Map(initialized.nodes.map((node) => [node.id, node.endpoint]));
    const pipeline = makePipeline(endpoints);
    manifest = await pipeline.upload({ fileId, name: "cluster.bin", mimeType: "application/octet-stream", bytes: original, plaintextHash: originalHash }, DEFAULT_PIPELINE, initialized.nodes.map((node) => node.id));
    await request(`/files/${fileId}/complete`, { method: "POST", body: JSON.stringify(commitBody(manifest)) });

    const authorized = await request<FileManifest>(`/files/${fileId}/download-manifest`);
    expect(authorized.objects).toHaveLength(10);
    for (let index = 0; index < 5; index += 1) {
      const shard = authorized.objects.find((object) => object.kind === "shard" && object.index === index);
      const share = authorized.objects.find((object) => object.kind === "key-share" && object.index === index);
      expect(shard?.nodeId).toBe(share?.nodeId);
      expect(shard?.endpoint).toBe(share?.endpoint);
      expect(shard?.endpoint).toBe(nodes.find((node) => node.id === shard?.nodeId)?.endpoint);
    }
    verifyOpaqueNodeStorage(authorized, nodes, original);
    const restored = await makePipeline(new Map(authorized.objects.map((object) => [object.nodeId, object.endpoint!]))) .download(authorized);
    expect(restored).toEqual(original);
    expect(await sha256(restored)).toBe(originalHash);
  }, 120_000);

  test("reconstructs after two real node processes are terminated", async () => {
    for (const index of [1, 3]) {
      nodes[index]!.process.kill();
      await nodes[index]!.process.exited;
      await expect(fetch(`${nodes[index]!.endpoint}/health`)).rejects.toThrow();
    }
    const authorized = await request<FileManifest>(`/files/${manifest.fileId}/download-manifest`);
    const restored = await makePipeline(new Map(authorized.objects.map((object) => [object.nodeId, object.endpoint!]))) .download(authorized);
    expect(restored).toEqual(original);
    expect(await sha256(restored)).toBe(originalHash);
  }, 60_000);

  test("fails explicitly after a third real node process is terminated", async () => {
    nodes[2]!.process.kill();
    await nodes[2]!.process.exited;
    const authorized = await request<FileManifest>(`/files/${manifest.fileId}/download-manifest`);
    await expect(makePipeline(new Map(authorized.objects.map((object) => [object.nodeId, object.endpoint!]))) .download(authorized)).rejects.toThrow(/Insufficient (Reed-Solomon shards|Shamir shares)/);
  }, 60_000);

  function makePipeline(endpoints: Map<string, string>) {
    return new BrowserFilePipeline(
      new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(),
      new HttpShardTransport({
        resolveEndpoint: (nodeId) => endpoints.get(nodeId) ?? Promise.reject(new Error(`Missing endpoint for ${nodeId}`)),
        requestCapability: async (input: CapabilityRequest) => (await request<{ capability: string }>(`/nodes/${input.nodeId}/capabilities`, { method: "POST", body: JSON.stringify(withoutNodeId(input)) })).capability,
        submitReceipt: async ({ nodeId, fileId, receipt }) => { await request(`/nodes/${nodeId}/receipts`, { method: "POST", body: JSON.stringify({ fileId, receipt }) }); },
      }),
    );
  }

  async function request<T = unknown>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (authenticated) headers.set("Authorization", `Bearer ${session.accessToken}`);
    const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
    return response.json() as Promise<T>;
  }
});

function withoutNodeId({ nodeId: _nodeId, ...input }: CapabilityRequest) { return input; }
function commitBody(manifest: FileManifest) { return { compressedSize: manifest.compressedSize, encryptedSize: manifest.encryptedSize, ciphertextHash: manifest.ciphertextHash, encryptionIv: manifest.encryptionIv, shardSize: manifest.shardSize, objects: manifest.objects }; }
function deterministicBytes(size: number) { const bytes = new Uint8Array(size); for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + index >>> 7) & 0xff; return bytes; }

function verifyOpaqueNodeStorage(manifest: FileManifest, nodes: Node[], original: Uint8Array) {
  for (const node of nodes) {
    const expected = manifest.objects.filter((object) => object.nodeId === node.id);
    expect(expected).toHaveLength(2);
    const database = new Database(join(node.directory, "metadata.sqlite"), { readonly: true });
    const stored = database.query<{ object_id: string; checksum: string; size: number; path: string }, []>("SELECT object_id,checksum,size,path FROM objects WHERE status='stored'").all();
    database.close();
    expect(stored.map((object) => object.object_id).sort()).toEqual(expected.map((object) => object.objectId).sort());
    for (const object of stored) {
      expect(object.size).toBeGreaterThan(0);
      expect(Bun.file(object.path).size).toBe(object.size);
      expect(Bun.file(object.path).size).not.toBe(original.byteLength);
    }
  }
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, env: { ...globalThis.process.env, GOCACHE: "/tmp/horcrux-go-cache", GOMODCACHE: "/tmp/horcrux-go-mod" }, stdout: "pipe", stderr: "pipe" });
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(child.stderr).text()}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(check: () => boolean | Promise<boolean>, name: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${name}`);
}
