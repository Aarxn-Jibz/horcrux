import type { Env } from "../env";
import { ApiError } from "./http";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

// The Worker exchanges its secret provider token for disposable client credentials.
export async function issueIceServers(env: Env): Promise<IceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) throw new ApiError(503, "ice_unavailable", "WebRTC relay credentials are not configured");
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate`, { method: "POST", headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}` } });
  if (!response.ok) throw new ApiError(503, "ice_unavailable", "WebRTC relay credentials could not be issued");
  const body = await response.json().catch(() => null) as { iceServers?: IceServer[] } | null;
  if (!body?.iceServers?.length) throw new ApiError(503, "ice_unavailable", "WebRTC relay returned no ICE servers");
  return body.iceServers;
}
