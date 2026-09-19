import { expect, test } from "bun:test";
import { issueIceServers } from "./ice";

test("ICE credentials are issued server-side and require provider configuration", async () => {
  await expect(issueIceServers({} as never)).rejects.toMatchObject({ code: "ice_unavailable" });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-a/credentials/generate-ice-servers");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ ttl: 600 }));
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-only");
    return Response.json({ iceServers: [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp"], username: "short-lived", credential: "temporary" }] });
  };
  await expect(issueIceServers({ TURN_KEY_ID: "key-a", TURN_API_TOKEN: "server-only" } as never, fetcher)).resolves.toEqual([{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:turn.example:3478?transport=udp", "turn:turn.example:3478?transport=tcp"], username: "short-lived", credential: "temporary" }]);
  await expect(issueIceServers({ TURN_KEY_ID: "key-a", TURN_API_TOKEN: "server-only" } as never, async () => new Response(null, { status: 503 }))).rejects.toMatchObject({ code: "ice_unavailable" });
});
