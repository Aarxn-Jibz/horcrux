import type { ByteStream, PutShardOptions, ShardTransport, StoredObjectRef } from "./index";

export type CapabilityOperation = "PUT" | "GET" | "DELETE";
export interface CapabilityRequest {
  nodeId: string;
  fileId: string;
  objectId: string;
  operation: CapabilityOperation;
  checksum?: string;
  size?: number;
  maxSize?: number;
}
export interface HttpShardTransportOptions {
  resolveEndpoint(nodeId: string): string | Promise<string>;
  requestCapability(request: CapabilityRequest): Promise<string>;
  submitReceipt(request: { nodeId: string; fileId: string; receipt: string }): Promise<void>;
  fetch?: FetchLike;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type NodeErrorBody = { error?: { code?: string; message?: string; retryable?: boolean } };
type PutResponse = { nodeId: string; objectId: string; checksum: string; size: number; receipt: string };

export class NodeTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class HttpShardTransport implements ShardTransport {
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly options: HttpShardTransportOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async putShard(
    nodeId: string,
    objectId: string,
    bytes: Uint8Array,
    options: PutShardOptions = {},
  ): Promise<StoredObjectRef> {
    if (!options.checksum) throw new Error("HTTP shard uploads require the precomputed object checksum");
    const fileId = getFileId(objectId);
    const capability = await this.options.requestCapability({
      nodeId,
      fileId,
      objectId,
      operation: "PUT",
      checksum: options.checksum,
      size: bytes.byteLength,
    });
    const response = await this.nodeRequest(nodeId, objectId, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/octet-stream",
      },
      // Fetch accepts ArrayBufferView bodies; the cast avoids a DOM typing gap and does not copy bytes.
      body: bytes as BodyInit,
      signal: options.signal,
    });
    const stored = await response.json() as PutResponse;
    if (
      stored.nodeId !== nodeId
      || stored.objectId !== objectId
      || stored.checksum !== options.checksum
      || stored.size !== bytes.byteLength
      || !stored.receipt
    ) {
      throw new Error("Storage node returned an inconsistent receipt response");
    }
    await this.options.submitReceipt({ nodeId, fileId, receipt: stored.receipt });
    return { nodeId, objectId, size: stored.size, checksum: stored.checksum };
  }

  async getShard(nodeId: string, objectId: string, signal?: AbortSignal) {
    const capability = await this.options.requestCapability({
      nodeId,
      fileId: getFileId(objectId),
      objectId,
      operation: "GET",
    });
    const response = await this.nodeRequest(nodeId, objectId, {
      method: "GET",
      headers: { Authorization: `Bearer ${capability}` },
      signal,
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async putShardStream(nodeId: string, objectId: string, bytes: ByteStream, options: PutShardOptions & { maxSize: number }): Promise<StoredObjectRef> {
    const fileId = getFileId(objectId);
    const capability = await this.options.requestCapability({ nodeId, fileId, objectId, operation: "PUT", maxSize: options.maxSize });
    const streamInit = {
      method: "PUT",
      headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/octet-stream" },
      body: asyncIterableToReadableStream(bytes),
      signal: options.signal,
      // Required by Chromium for a streaming request body; ignored by browsers which do not need it.
      duplex: "half" as never,
    } as RequestInit & { duplex: "half" };
    const response = await this.nodeRequest(nodeId, objectId, streamInit);
    const stored = await response.json() as PutResponse;
    if (stored.nodeId !== nodeId || stored.objectId !== objectId || stored.size > options.maxSize || !stored.receipt) throw new Error("Storage node returned an inconsistent receipt response");
    await this.options.submitReceipt({ nodeId, fileId, receipt: stored.receipt });
    return { nodeId, objectId, size: stored.size, checksum: stored.checksum };
  }

  async getShardStream(nodeId: string, objectId: string, signal?: AbortSignal, start = 0): Promise<ByteStream> {
    const capability = await this.options.requestCapability({ nodeId, fileId: getFileId(objectId), objectId, operation: "GET" });
    const headers: Record<string, string> = { Authorization: `Bearer ${capability}` };
    if (start > 0) headers.Range = `bytes=${start}-`;
    const response = await this.nodeRequest(nodeId, objectId, { method: "GET", headers, signal });
    if (start > 0 && response.status !== 206) throw new Error("Storage node ignored a shard resume range request");
    if (!response.body) throw new Error("Storage node returned an empty response body");
    // Bun's fetch response body iterator is currently incompatible with chunked HTTP
    // responses from the local Go test daemon. Browsers retain the streaming branch.
    if ("Bun" in globalThis) return singleChunk(new Uint8Array(await response.arrayBuffer()));
    return readableStreamToAsyncIterable(response.body);
  }

  async deleteShard(nodeId: string, objectId: string) {
    const capability = await this.options.requestCapability({
      nodeId,
      fileId: getFileId(objectId),
      objectId,
      operation: "DELETE",
    });
    await this.nodeRequest(nodeId, objectId, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${capability}` },
    });
  }

  async healthCheck(nodeId: string) {
    try {
      const endpoint = await this.resolveSecureEndpoint(nodeId);
      const response = await this.fetchImplementation(`${endpoint}/health`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async nodeRequest(nodeId: string, objectId: string, init: RequestInit) {
    const endpoint = await this.resolveSecureEndpoint(nodeId);
    const objectPath = objectId.split("/").map(encodeURIComponent).join("/");
    const response = await this.fetchImplementation(`${endpoint}/objects/${objectPath}`, init);
    if (!response.ok) throw await nodeError(response);
    return response;
  }

  private async resolveSecureEndpoint(nodeId: string) {
    const rawEndpoint = await this.options.resolveEndpoint(nodeId);
    const url = new URL(rawEndpoint);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Remote storage nodes require HTTPS");
    }
    return url.href.replace(/\/$/, "");
  }
}

function asyncIterableToReadableStream(source: ByteStream) {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    async cancel() { await iterator.return?.(); },
  });
}

async function* readableStreamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } } finally { reader.releaseLock(); }
}
async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

function getFileId(objectId: string) {
  const separator = objectId.indexOf("/");
  if (separator < 1) throw new Error("Object ID does not contain a file scope");
  return objectId.slice(0, separator);
}

async function nodeError(response: Response) {
  const body = await response.json().catch(() => ({})) as NodeErrorBody;
  return new NodeTransportError(
    body.error?.message ?? `Storage node request failed (${response.status})`,
    response.status,
    body.error?.code ?? "node_request_failed",
    body.error?.retryable ?? response.status >= 500,
  );
}
