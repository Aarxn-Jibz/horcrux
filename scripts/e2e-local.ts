import { AuditedShamirProvider, BrowserFilePipeline, WasmReedSolomonProvider, WebCryptoAesGcm, ZstdCompressionProvider, sha256 } from "../packages/core/src";
import { MemoryShardTransport } from "../packages/storage/src";
import { DEFAULT_PIPELINE } from "../packages/shared/src";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:8787";
const email = `e2e-${crypto.randomUUID()}@example.com`;
const response = await fetch(`${apiUrl}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "e2e-only-correct-horse-battery-staple" }) });
if (!response.ok) throw new Error(`Registration failed (${response.status})`);
const session = await response.json() as { accessToken: string };
const authenticated = (path: string, init: RequestInit = {}) => fetch(`${apiUrl}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${session.accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } });

const bytes = crypto.getRandomValues(new Uint8Array(16 * 1024)); const fileId = crypto.randomUUID(); const originalHash = await sha256(bytes);
const initializedResponse = await authenticated("/files/init", { method: "POST", body: JSON.stringify({ fileId, originalName: "e2e-random.bin", mimeType: "application/octet-stream", originalSize: bytes.byteLength, plaintextHash: originalHash, dataShards: DEFAULT_PIPELINE.dataShards, parityShards: DEFAULT_PIPELINE.parityShards, keyShareThreshold: DEFAULT_PIPELINE.keyThreshold, keyShareCount: DEFAULT_PIPELINE.keyShares }) });
if (!initializedResponse.ok) throw new Error(`Initialization failed (${initializedResponse.status}): ${await initializedResponse.text()}`);
const initialized = await initializedResponse.json() as { nodes: Array<{ id: string }> }; const nodeIds = initialized.nodes.map((node) => node.id);
await authenticated(`/files/${fileId}/state`, { method: "POST", body: JSON.stringify({ status: "distributing" }) });
const storage = new MemoryShardTransport(nodeIds); const pipeline = new BrowserFilePipeline(new ZstdCompressionProvider(), new WebCryptoAesGcm(), new WasmReedSolomonProvider(), new AuditedShamirProvider(), storage);
const manifest = await pipeline.upload({ fileId, name: "e2e-random.bin", mimeType: "application/octet-stream", bytes }, DEFAULT_PIPELINE, nodeIds);
const completed = await authenticated(`/files/${fileId}/complete`, { method: "POST", body: JSON.stringify({ compressedSize: manifest.compressedSize, encryptedSize: manifest.encryptedSize, ciphertextHash: manifest.ciphertextHash, encryptionIv: manifest.encryptionIv, shardSize: manifest.shardSize, objects: manifest.objects }) });
if (!completed.ok) throw new Error(`Completion failed (${completed.status}): ${await completed.text()}`);
const manifestResponse = await authenticated(`/files/${fileId}/download-manifest`); if (!manifestResponse.ok) throw new Error(`Manifest failed (${manifestResponse.status})`);
const authorizedManifest = await manifestResponse.json() as typeof manifest;
storage.setNodeAvailable(nodeIds[0]!, false); storage.setNodeAvailable(nodeIds[1]!, false);
const restored = await pipeline.download(authorizedManifest); const restoredHash = await sha256(restored);
if (restoredHash !== originalHash) throw new Error("End-to-end output hash did not match input");
await authenticated(`/files/${fileId}`, { method: "DELETE" });
console.log(`E2E passed: ${bytes.byteLength} bytes, ${manifest.objects.length} objects, two unavailable nodes, SHA-256 ${restoredHash}`);
