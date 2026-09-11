import type { z } from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function signEnvelope(payload: unknown, privateKeyPkcs8: string) {
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("pkcs8", decodeBase64Url(privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, payloadBytes));
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signature)}`;
}

export async function verifyEnvelope<T>(token: string, publicKeyRaw: string, schema: z.ZodType<T>): Promise<T> {
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra) throw new Error("Invalid signed envelope");
  const payload = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(publicKeyRaw), { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, signature, payload)) throw new Error("Signed envelope verification failed");
  return schema.parse(JSON.parse(decoder.decode(payload)));
}
