import type { Env } from "../env";
import { ApiError } from "./http";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// The Worker exchanges its secret provider token for disposable client credentials.
export async function issueIceServers(env: Env, fetcher: Fetcher = fetch): Promise<IceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) throw new ApiError(503, "ice_unavailable", "WebRTC relay credentials are not configured");
  const url = env.TURN_CREDENTIALS_URL ?? `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`;
  const response = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 600 }) });
  if (!response.ok) throw new ApiError(503, "ice_unavailable", "WebRTC relay credentials could not be issued");
  const body = await response.json().catch(() => null) as { iceServers?: IceServer[] } | null;
  if (!body?.iceServers?.length) throw new ApiError(503, "ice_unavailable", "WebRTC relay returned no ICE servers");
  return body.iceServers;
}
