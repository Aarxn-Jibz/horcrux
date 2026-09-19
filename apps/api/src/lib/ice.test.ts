import { expect, test } from "bun:test";
import { issueIceServers } from "./ice";

test("ICE credentials are issued server-side and require provider configuration", async () => {
  await expect(issueIceServers({} as never)).rejects.toMatchObject({ code: "ice_unavailable" });
  const fetcher = async (input: RequestInfo | URL) => {
    expect(String(input)).toContain("/turn/keys/key-a/credentials/generate");
    return Response.json({ iceServers: [{ urls: ["stun:stun.example"], username: "short-lived", credential: "temporary" }] });
  };
  await expect(issueIceServers({ TURN_KEY_ID: "key-a", TURN_API_TOKEN: "server-only" } as never, fetcher)).resolves.toEqual([{ urls: ["stun:stun.example"], username: "short-lived", credential: "temporary" }]);
});
