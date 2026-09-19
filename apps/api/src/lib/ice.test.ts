import { expect, test } from "bun:test";
import { issueIceServers } from "./ice";

test("ICE credentials are issued server-side and require provider configuration", async () => {
  await expect(issueIceServers({} as never)).rejects.toMatchObject({ code: "ice_unavailable" });
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    expect(String(input)).toContain("/turn/keys/key-a/credentials/generate");
    return Response.json({ iceServers: [{ urls: ["stun:stun.example"], username: "short-lived", credential: "temporary" }] });
  };
  try { await expect(issueIceServers({ TURN_KEY_ID: "key-a", TURN_API_TOKEN: "server-only" } as never)).resolves.toEqual([{ urls: ["stun:stun.example"], username: "short-lived", credential: "temporary" }]); }
  finally { globalThis.fetch = original; }
});
