import type { ChunkedManifest } from "@horcrux-file-system/core";
import type { FileManifest, FileSummary, StorageNodeContract } from "@horcrux-file-system/shared";
import type { CapabilityRequest } from "@horcrux-file-system/storage";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
let accessToken: string | null = null;
export interface User { id: string; email: string }

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers); if (init.body) headers.set("Content-Type", "application/json"); if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 401 && retry && path !== "/auth/refresh") { const restored = await refresh().catch(() => null); if (restored) return request<T>(path, init, false); }
  if (!response.ok) { const body = await response.json().catch(() => ({ error: { message: "Request failed" } })) as { error?: { message?: string } }; throw new Error(body.error?.message ?? `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
async function session(path: "/auth/login" | "/auth/register", email: string, password: string) { const result = await request<{ accessToken: string; user: User }>(path, { method: "POST", body: JSON.stringify({ email, password }) }, false); accessToken = result.accessToken; return result.user; }
export const login = (email: string, password: string) => session("/auth/login", email, password);
export const register = (email: string, password: string) => session("/auth/register", email, password);
export async function refresh() { const result = await request<{ accessToken: string; user: User }>("/auth/refresh", { method: "POST" }, false); accessToken = result.accessToken; return result.user; }
export async function logout() { await request<void>("/auth/logout", { method: "POST" }, false).catch(() => {}); accessToken = null; }
export async function listFiles() { return (await request<{ files: FileSummary[] }>("/files")).files; }
export async function listDevices() { return (await request<{ devices: StorageNodeContract[] }>("/devices")).devices; }
export function initializeFile(body: unknown) { return request<{ fileId: string; uploadSessionId: string; nodes: StorageNodeContract[] }>("/files/init", { method: "POST", body: JSON.stringify(body) }); }
export function updateUploadState(fileId: string, status: "distributing" | "aborted") { return request<void>(`/files/${fileId}/state`, { method: "POST", body: JSON.stringify({ status }) }); }
export function completeFile(fileId: string, manifest: FileManifest | ChunkedManifest) {
  const body = isChunkedManifest(manifest)
    ? { formatVersion: 2, chunkSize: manifest.chunkSize, chunkCount: manifest.chunkCount, noncePrefix: manifest.noncePrefix, objects: manifest.objects }
    : { compressedSize: manifest.compressedSize, encryptedSize: manifest.encryptedSize, ciphertextHash: manifest.ciphertextHash, encryptionIv: manifest.encryptionIv, shardSize: manifest.shardSize, objects: manifest.objects };
  return request<{ fileId: string; status: string }>(`/files/${fileId}/complete`, { method: "POST", body: JSON.stringify(body) });
}
function isChunkedManifest(manifest: FileManifest | ChunkedManifest): manifest is ChunkedManifest { return "formatVersion" in manifest && manifest.formatVersion === 2; }
export function downloadManifest(fileId: string) { return request<FileManifest>(`/files/${fileId}/download-manifest`); }
export function getFile(fileId: string) { return request<FileSummary & { objects: FileManifest["objects"] }>(`/files/${fileId}`); }
export function deleteFile(fileId: string) { return request<void>(`/files/${fileId}`, { method: "DELETE" }); }

export async function requestNodeCapability(input: CapabilityRequest) {
  const { nodeId, ...body } = input;
  const result = await request<{ capability: string; expiresAt: string }>(`/nodes/${nodeId}/capabilities`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result.capability;
}

export function submitNodeReceipt(input: { nodeId: string; fileId: string; receipt: string }) {
  return request<{ accepted: true; nodeId: string; objectId: string }>(`/nodes/${input.nodeId}/receipts`, {
    method: "POST",
    body: JSON.stringify({ fileId: input.fileId, receipt: input.receipt }),
  });
}
