import { describe, expect, test } from "bun:test";
import { decodeBase64Url, encodeBase64Url, heartbeatSchema, signEnvelope, storageCapabilitySchema, verifyEnvelope, type StorageCapability } from "@horcrux-file-system/protocol";
import app from "./index";
import type { Env } from "./env";
import { issueAccessToken } from "./lib/tokens";
import { enrollmentProofPayload } from "./lib/node-crypto";

type NodeKeys = { privateKey: string; publicKey: string };
type QueryResult = Record<string, unknown> | null;

class NodeDatabase {
  node: QueryResult;
  file: QueryResult = { status: "uploading" };
  issued: QueryResult = null;
  readonly runs: Array<{ query: string; bindings: unknown[] }> = [];
  batches = 0;

  constructor(publicKey: string) {
    this.node = { id: "node-a", public_key: publicKey };
  }

  prepare(query: string) {
    const database = this;
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bindings = values;
        return statement;
      },
      async first() {
        if (query.includes("FROM devices")) return database.node;
        if (query.includes("FROM files")) return database.file;
        if (query.includes("FROM issued_capabilities")) return database.issued;
        return null;
      },
      async run() {
        database.runs.push({ query, bindings });
        return {};
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(_statements: D1PreparedStatement[]) {
    this.batches += 1;
    return [];
  }
}

class EnrollmentDatabase {
  claimed = false;
  inserted = 0;

  prepare(query: string) {
    const database = this;
    const statement = {
      bind() { return statement; },
      async first() {
        if (query.startsWith("SELECT user_id")) return { user_id: "user-a", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null };
        if (query.startsWith("UPDATE device_enrollment_challenges")) {
          if (database.claimed) return null;
          database.claimed = true;
          return { user_id: "user-a" };
        }
        return null;
      },
      async run() {
        if (query.startsWith("INSERT INTO devices")) database.inserted += 1;
        return {};
      },
    };
    return statement as unknown as D1PreparedStatement;
  }
}

describe("storage node control plane", () => {
  test("claims an enrollment challenge only once even with a stale lookup", async () => {
    const nodeKeys = await generateNodeKeys();
    const database = new EnrollmentDatabase();
    const challengeId = crypto.randomUUID();
    const token = "one-time-enrollment-token-123456789";
    const signingKey = await crypto.subtle.importKey("pkcs8", decodeBase64Url(nodeKeys.privateKey), { name: "Ed25519" }, false, ["sign"]);
    const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      signingKey,
      enrollmentProofPayload(challengeId, token, nodeKeys.publicKey),
    )));
    const request = () => app.request("http://api/nodes/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, token, publicKey: nodeKeys.publicKey, signature, name: "Laptop", capacityBytes: 1_000 }),
    }, environment(database as unknown as NodeDatabase));

    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(401);
    expect(database.inserted).toBe(1);
  });

  test("accepts a signed heartbeat and updates placement metadata", async () => {
    const nodeKeys = await generateNodeKeys();
    const database = new NodeDatabase(nodeKeys.publicKey);
    const now = Math.floor(Date.now() / 1_000);
    const heartbeat = {
      version: "1" as const,
      nodeId: "node-a",
      status: "online" as const,
      capacityBytes: 10_000,
      usedBytes: 4_000,
      availableBytes: 6_000,
      nodeVersion: "0.1.0",
      timestamp: now,
    };
    const response = await app.request("http://api/nodes/node-a/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heartbeat: await signEnvelope(heartbeatSchema.parse(heartbeat), nodeKeys.privateKey) }),
    }, environment(database));

    expect(response.status).toBe(200);
    expect(database.runs[0]?.bindings).toEqual(["online", 10_000, 4_000, 6_000, "0.1.0", "1", "healthy", "node-a"]);
  });

  test("issues an object-scoped grant and accepts only its matching node receipt", async () => {
    const nodeKeys = await generateNodeKeys();
    const controlKeys = await generateNodeKeys();
    const database = new NodeDatabase(nodeKeys.publicKey);
    const env = environment(database, controlKeys.privateKey);
    const accessToken = await issueAccessToken("user-a", "owner@example.com", env.JWT_SECRET);
    const fileId = crypto.randomUUID();
    const objectId = `${fileId}/shard/${crypto.randomUUID()}`;
    const checksum = "a".repeat(64);
    const grantResponse = await app.request("http://api/nodes/node-a/capabilities", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, objectId, operation: "PUT", checksum, size: 42 }),
    }, env);

    expect(grantResponse.status).toBe(201);
    const { capability: token } = await grantResponse.json() as { capability: string };
    const capability = await verifyEnvelope(token, controlKeys.publicKey, storageCapabilitySchema);
    expect(capability).toMatchObject({ nodeId: "node-a", objectId, operation: "PUT", checksum, size: 42 });
    database.issued = issuedRow(capability);

    const receipt = await signEnvelope({
      version: "1",
      nodeId: "node-a",
      objectId,
      checksum,
      size: 42,
      timestamp: Math.floor(Date.now() / 1_000),
      requestId: capability.jti,
    }, nodeKeys.privateKey);
    const receiptResponse = await app.request("http://api/nodes/node-a/receipts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, receipt }),
    }, env);

    expect(receiptResponse.status).toBe(200);
    expect(database.batches).toBe(1);

    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith("a") ? "b" : "a"}`;
    const rejected = await app.request("http://api/nodes/node-a/receipts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, receipt: tampered }),
    }, env);
    expect(rejected.status).toBe(401);
  });
});

function environment(database: NodeDatabase, privateKey?: string): Env {
  return {
    DB: database as unknown as D1Database,
    JWT_SECRET: "test-secret-that-is-long-and-random",
    WEB_ORIGIN: "http://localhost:5173",
    CAPABILITY_PRIVATE_KEY: privateKey,
  };
}

async function generateNodeKeys(): Promise<NodeKeys> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))),
    publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
  };
}

function issuedRow(capability: StorageCapability) {
  return {
    jti: capability.jti,
    device_id: capability.nodeId,
    object_id: capability.objectId,
    operation: capability.operation,
    checksum: capability.checksum,
    size: capability.size,
    expires_at: new Date(capability.expiresAt * 1_000).toISOString(),
  };
}
