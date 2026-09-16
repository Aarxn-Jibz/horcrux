import { expect, test } from "bun:test";
import { WebRtcShardTransport } from "./webrtc";

class Channel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.get(type)?.delete(listener); }
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
  expect(handles.map((handle) => handle.closed)).toEqual([1, 1, 1, 1]);
});

test("WebRTC transport closes the connection handle when setup fails", async () => {
  const channel = new Channel(); let closed = 0;
  const transport = new WebRtcShardTransport(async () => ({ channel: channel as unknown as RTCDataChannel, close: () => { closed += 1; channel.close(); } }), async () => { throw new Error("capability unavailable"); });

  await expect(transport.putShard("node-1", "file-1/object-1", new Uint8Array([1]))).rejects.toThrow("capability unavailable");
  expect(closed).toBe(1);
});
