import { describe, expect, test } from "bun:test";
import { HttpShardTransport, WebRtcShardTransport } from "@horcrux-file-system/storage";
import { createStorageTransport } from "./pipeline";

describe("browser storage transport selection", () => {
  test("selects WebRTC without an endpoint", () => {
    expect(createStorageTransport("webrtc")).toBeInstanceOf(WebRtcShardTransport);
  });

  test("keeps HTTP endpoint transport available", () => {
    expect(createStorageTransport("http", new Map([["node-a", "https://node.example"]]))).toBeInstanceOf(HttpShardTransport);
  });
});
