import { decodeBase64Url, encodeBase64Url, signEnvelope } from "@horcrux-file-system/protocol";
import type { StorageCapability, StorageReceipt } from "@horcrux-file-system/protocol";

const encoder = new TextEncoder();

export function createOpaqueToken(bytes = 32) {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashOpaqueToken(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export async function deriveNodeId(publicKey: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(publicKey)));
  let hex = "";
  for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, "0");
  return `node_${hex}`;
}

export function enrollmentProofPayload(challengeId: string, token: string, publicKey: string) {
  return encoder.encode(`horcrux-enroll-v1:${challengeId}:${token}:${publicKey}`);
}

export async function verifyNodeSignature(publicKey: string, payload: Uint8Array, signature: string) {
  try {
    const key = await crypto.subtle.importKey("raw", decodeBase64Url(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, decodeBase64Url(signature), payload as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

export async function issueCapability(capability: StorageCapability, privateKey?: string) {
  if (!privateKey) throw new Error("Capability signing key is not configured");
  return signEnvelope(capability, privateKey);
}

export function receiptMatchesCapability(
  receipt: StorageReceipt,
  capability: Pick<StorageCapability, "jti" | "nodeId" | "objectId" | "operation" | "checksum" | "size" | "maxSize">,
) {
  return capability.operation === "PUT"
    && receipt.requestId === capability.jti
    && receipt.nodeId === capability.nodeId
    && receipt.objectId === capability.objectId
    && (capability.maxSize !== undefined
      ? receipt.size <= capability.maxSize
      : receipt.checksum === capability.checksum && receipt.size === capability.size);
}
