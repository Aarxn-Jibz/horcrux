import type { ByteStream, PutShardOptions, ShardTransport, StoredObjectRef } from "./index";

export type WebRtcConnection = { channel: RTCDataChannel; close: () => void };
type Connect = (nodeId: string) => Promise<WebRtcConnection>;
type Grant = (request: { nodeId: string; fileId: string; objectId: string; operation: "PUT" | "GET" | "DELETE"; maxSize?: number }) => Promise<string>;
type SubmitReceipt = (request: { nodeId: string; fileId: string; receipt: string }) => Promise<void>;
type Control = { type: string; objectId?: string; size?: number; checksum?: string; capability?: string; message?: string };

const CHUNK = 64 * 1024;
const TIMEOUT = 30_000;

/** A bounded, ordered DataChannel implementation of the shard transport. */
export class WebRtcShardTransport implements ShardTransport {
  private readonly ready = new Map<string, WebRtcConnection>();
  constructor(private readonly connect: Connect, private readonly grant: Grant, private readonly submitReceipt?: SubmitReceipt) {}

  private async takeConnection(nodeId: string) { const connection = this.ready.get(nodeId); if (connection) { this.ready.delete(nodeId); return connection; } return this.connect(nodeId); }

  async putShard(nodeId: string, objectId: string, bytes: Uint8Array, options: PutShardOptions = {}): Promise<StoredObjectRef> {
    return this.putShardStream(nodeId, objectId, (async function* () { yield bytes; })(), { ...options, maxSize: bytes.byteLength });
  }

  async putShardStream(nodeId: string, objectId: string, stream: ByteStream, options: PutShardOptions & { maxSize: number }): Promise<StoredObjectRef> {
    const connection = await this.takeConnection(nodeId); const channel = connection.channel;
    try {
      const capability = await this.grant({ nodeId, fileId: fileId(objectId), objectId, operation: "PUT", maxSize: options.maxSize });
      const receipt = waitForControl(channel, "receipt");
      void receipt.catch(() => {});
      await sendControl(channel, { type: "put-init", objectId, capability });
      for await (const input of stream) for (let offset = 0; offset < input.byteLength; offset += CHUNK) { await drain(channel); channel.send(input.slice(offset, offset + CHUNK)); }
      await sendControl(channel, { type: "put-finish" });
      const result = await receipt;
      const token = requiredString(result.capability, "storage receipt");
      await this.submitReceipt?.({ nodeId, fileId: fileId(objectId), receipt: token });
      return { nodeId, objectId, size: requiredNumber(result.size, "receipt size"), checksum: requiredString(result.checksum, "receipt checksum") };
    } finally { connection.close(); }
  }

  async getShard(nodeId: string, objectId: string, signal?: AbortSignal) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await this.getShardStream(nodeId, objectId, signal)) chunks.push(chunk);
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  async getShardStream(nodeId: string, objectId: string, signal?: AbortSignal, start = 0): Promise<ByteStream> {
    const connection = await this.takeConnection(nodeId); const channel = connection.channel;
    try {
      const stream = incoming(channel, signal, () => connection.close());
      await sendControl(channel, { type: "get", objectId, size: start, capability: await this.grant({ nodeId, fileId: fileId(objectId), objectId, operation: "GET" }) });
      return stream;
    } catch (error) { connection.close(); throw error; }
  }

  async deleteShard(nodeId: string, objectId: string) {
    const connection = await this.takeConnection(nodeId); const channel = connection.channel;
    try { const capability = await this.grant({ nodeId, fileId: fileId(objectId), objectId, operation: "DELETE" }); const complete = waitForControl(channel, "delete-finish"); void complete.catch(() => {}); await sendControl(channel, { type: "delete", objectId, capability }); await complete; } finally { connection.close(); }
  }
  async healthCheck(nodeId: string) { if (this.ready.has(nodeId)) return true; try { this.ready.set(nodeId, await this.connect(nodeId)); return true; } catch { return false; } }
  close() { for (const connection of this.ready.values()) connection.close(); this.ready.clear(); }
}

async function sendControl(channel: RTCDataChannel, message: Control) { await drain(channel); channel.send(JSON.stringify(message)); }
function drain(channel: RTCDataChannel) {
  if (channel.readyState !== "open") return Promise.reject(new Error("WebRTC data channel is not open"));
  if (channel.bufferedAmount < CHUNK * 4) return Promise.resolve();
  channel.bufferedAmountLowThreshold = CHUNK * 2;
  return new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => { clearTimeout(timer); channel.removeEventListener("bufferedamountlow", low); channel.removeEventListener("close", closed); channel.removeEventListener("error", closed); callback(); };
    const low = () => finish(resolve); const closed = () => finish(() => reject(new Error("WebRTC data channel closed while backpressured")));
    const timer = setTimeout(() => finish(() => reject(new Error("WebRTC data channel remained backpressured"))), TIMEOUT);
    channel.addEventListener("bufferedamountlow", low, { once: true }); channel.addEventListener("close", closed, { once: true }); channel.addEventListener("error", closed, { once: true });
  });
}
function waitForControl(channel: RTCDataChannel, expected: string) {
  return new Promise<Control>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const closed = () => finish(() => reject(new Error("WebRTC data channel closed")));
    const message = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let control: Control; try { control = JSON.parse(event.data) as Control; } catch { finish(() => reject(new Error("Malformed WebRTC control response"))); return; }
      if (control.type === "error") finish(() => reject(new Error(control.message ?? "WebRTC operation rejected")));
      else if (control.type === expected) finish(() => resolve(control));
    };
    const finish = (callback: () => void) => { clearTimeout(timer); channel.removeEventListener("message", message); channel.removeEventListener("close", closed); callback(); };
    timer = setTimeout(() => finish(() => reject(new Error(`WebRTC ${expected} timed out`))), TIMEOUT);
    channel.addEventListener("message", message); channel.addEventListener("close", closed, { once: true });
  });
}
function incoming(channel: RTCDataChannel, signal?: AbortSignal, closeConnection = () => channel.close()): ByteStream {
  const queue: Uint8Array[] = []; let done = false; let error: unknown; let wake: (() => void) | undefined;
  const notify = () => { const next = wake; wake = undefined; next?.(); };
  const message = (event: MessageEvent) => {
    if (typeof event.data === "string") { try { const control = JSON.parse(event.data) as Control; if (control.type === "error") error = new Error(control.message ?? "WebRTC operation rejected"); if (control.type === "get-finish") done = true; } catch { error = new Error("Malformed WebRTC control response"); } }
    else { const data = new Uint8Array(event.data as ArrayBuffer); if (data.byteLength === 0 || data.byteLength > CHUNK) error = new Error("Invalid WebRTC binary chunk"); else queue.push(data); }
    notify();
  };
  const onClose = () => { if (!done) error = new Error("WebRTC data channel closed"); notify(); };
  channel.addEventListener("message", message); channel.addEventListener("close", onClose, { once: true });
  return {
    async *[Symbol.asyncIterator]() {
      try { while (!done || queue.length) { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); if (error) throw error; const chunk = queue.shift(); if (chunk) yield chunk; else await new Promise<void>((resolve) => { const abort = () => finish(); const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); wake = undefined; resolve(); }; const timer = setTimeout(() => { error = new Error("WebRTC shard stream stalled"); finish(); }, TIMEOUT); wake = finish; signal?.addEventListener("abort", abort, { once: true }); }); } }
      finally { channel.removeEventListener("message", message); channel.removeEventListener("close", onClose); closeConnection(); }
    },
  };
}
function requiredString(value: unknown, label: string) { if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`); return value; }
function requiredNumber(value: unknown, label: string) { if (typeof value !== "number" || value < 0) throw new Error(`Missing ${label}`); return value; }
function fileId(objectId: string) { const slash = objectId.indexOf("/"); if (slash < 1) throw new Error("Object ID does not contain a file scope"); return objectId.slice(0, slash); }
