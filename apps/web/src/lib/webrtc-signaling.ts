import { authenticatedRequest } from "./api";

type WebRtcSignal = { nodeId: string; type: "offer" | "answer" | "ice-candidate"; payload: string };

// Signaling deliberately carries only SDP/ICE strings. Object authorization still
// uses the ordinary capability endpoint when the data channel opens.
export interface WebRtcSession { sessionId: string; expiresAt: string; iceServers: RTCIceServer[] }
export async function createWebRtcSession(nodeId: string): Promise<WebRtcSession> { return api<WebRtcSession>("/webrtc/sessions", { method: "POST", body: JSON.stringify({ nodeId }) }); }
export async function sendWebRtcSignal(sessionId: string, signal: Pick<WebRtcSignal, "nodeId" | "type" | "payload">) { await api(`/webrtc/sessions/${sessionId}/signals`, { method: "POST", body: JSON.stringify(signal) }); }
export async function readWebRtcSignals(sessionId: string) { return api<{ nodeId: string; signals: Array<{ type: "answer" | "ice-candidate"; payload: string }> }>(`/webrtc/sessions/${sessionId}/signals`, {}); }

function api<T>(path: string, init: RequestInit): Promise<T> { return authenticatedRequest<T>(path, init); }
