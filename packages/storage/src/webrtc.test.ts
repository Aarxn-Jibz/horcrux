import { expect, test } from "bun:test";
import { WebRtcShardTransport } from "./webrtc";

class Channel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: Event) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0; }
  close() { this.readyState = "closed"; this.emit("close", {}); }
  send(value: string | Uint8Array) {
    if (typeof value !== "string") return;
    const control = JSON.parse(value) as { type: string };
    if (control.type === "put-finish") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "receipt", capability: "receipt", size: 1, checksum: "a".repeat(64) }) }));
    if (control.type === "delete") queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "delete-finish" }) }));
    if (control.type === "get") queueMicrotask(() => { this.emit("message", { data: new Uint8Array([1]).buffer }); this.emit("message", { data: JSON.stringify({ type: "get-finish" }) }); });
  }
  private emit(type: string, event: object) { for (const listener of this.listeners.get(type) ?? []) listener(event as MessageEvent); }
}

test("WebRTC transport closes the connection handle after every operation", async () => {
  const handles: Array<{ closed: number }> = [];
  const transport = new WebRtcShardTransport(async () => {
    const channel = new Channel(); const handle = { channel: channel as unknown as RTCDataChannel, closed: 0, close() { this.closed += 1; channel.close(); } };
    handles.push(handle);
    return handle;
  }, async () => "capability");
  const objectId = "file-1/object-1";

  await transport.putShard("node-1", objectId, new Uint8Array([1]));
  expect(await transport.getShard("node-1", objectId)).toEqual(new Uint8Array([1]));
  await transport.deleteShard("node-1", objectId);
  expect(await transport.healthCheck("node-1")).toBeTrue();
  transport.close();
  expect(handles.map((handle) => handle.closed)).toEqual([1, 1, 1, 1]);
});

test("WebRTC transport reuses a healthy probe connection for the next read", async () => {
  const handles: Array<{ closed: number }> = [];
  const transport = new WebRtcShardTransport(async () => {
    const channel = new Channel(); const handle = { channel: channel as unknown as RTCDataChannel, closed: 0, close() { this.closed += 1; channel.close(); } };
    handles.push(handle); return handle;
  }, async () => "capability");
  await expect(transport.healthCheck("node-1")).resolves.toBeTrue();
  await expect(transport.getShard("node-1", "file-1/object-1")).resolves.toEqual(new Uint8Array([1]));
  expect(handles).toHaveLength(1);
  expect(handles[0]!.closed).toBe(1);
});

test("WebRTC transport closes the connection handle when setup fails", async () => {
  const channel = new Channel(); let closed = 0;
  const transport = new WebRtcShardTransport(async () => ({ channel: channel as unknown as RTCDataChannel, close: () => { closed += 1; channel.close(); } }), async () => { throw new Error("capability unavailable"); });

  await expect(transport.putShard("node-1", "file-1/object-1", new Uint8Array([1]))).rejects.toThrow("capability unavailable");
  expect(closed).toBe(1);
});

test("WebRTC transport surfaces direct connection failures without an HTTP fallback", async () => {
  let connections = 0;
  const transport = new WebRtcShardTransport(async () => {
    connections += 1;
    throw new Error("direct ICE path unavailable");
  }, async () => "capability");

  await expect(transport.getShard("node-1", "file-1/object-1")).rejects.toThrow("direct ICE path unavailable");
  expect(connections).toBe(1);
});

test("WebRTC upload fails promptly when a backpressured channel closes", async () => {
  const channel = new Channel(); channel.bufferedAmount = 64 * 1024 * 4;
  const transport = new WebRtcShardTransport(async () => ({ channel: channel as unknown as RTCDataChannel, close: () => channel.close() }), async () => "capability");
  const upload = transport.putShard("node-1", "file-1/object-1", new Uint8Array([1]));
  while (channel.listenerCount("close") === 0) await new Promise((resolve) => queueMicrotask(resolve));
  channel.close();
  await expect(upload).rejects.toThrow("closed while backpressured");
});
