import { expect, test } from "bun:test";
import { describeError } from "./errors";

test("WebRTC transport failures tell users what to check", () => {
  expect(describeError(new Error("WebRTC data channel closed while backpressured"), "Upload failed").message).toBe("The direct WebRTC connection was interrupted. Check the device's network connection, then retry.");
  expect(describeError(new Error("WebRTC answer timed out for node-a"), "Upload failed").message).toBe("WebRTC signaling did not reach the device. Check that it is online, then retry.");
});
