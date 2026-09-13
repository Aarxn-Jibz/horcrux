import { createWebRtcSession, readWebRtcSignals, sendWebRtcSignal } from "./webrtc-signaling";

export class HorcruxPeer {
  readonly connection: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  private closed = false;
  private constructor(connection: RTCPeerConnection, channel: RTCDataChannel) { this.connection = connection; this.channel = channel; }
  static async connect(nodeId: string, iceServers: RTCIceServer[] = []) {
    const session = await createWebRtcSession(nodeId); const connection = new RTCPeerConnection({ iceServers }); const channel = connection.createDataChannel("horcrux", { ordered: true }); const peer = new HorcruxPeer(connection, channel);
    connection.onicecandidate = ({ candidate }) => { if (candidate) void sendWebRtcSignal(session.sessionId, { nodeId, type: "ice-candidate", payload: JSON.stringify(candidate.toJSON()) }).catch(() => peer.close()); };
    const offer = await connection.createOffer(); await connection.setLocalDescription(offer); await waitForIceGathering(connection); await sendWebRtcSignal(session.sessionId, { nodeId, type: "offer", payload: connection.localDescription!.sdp! });
    await peer.waitForAnswer(session.sessionId, nodeId); await peer.waitForOpen(); return peer;
  }
  private async waitForAnswer(sessionId: string, nodeId: string) { const deadline = Date.now() + 30_000; while (!this.closed && Date.now() < deadline) { const response = await readWebRtcSignals(sessionId); for (const signal of response.signals) { if (signal.type === "answer" && !this.connection.currentRemoteDescription) await this.connection.setRemoteDescription({ type: "answer", sdp: signal.payload }); else if (signal.type === "ice-candidate") await this.connection.addIceCandidate(JSON.parse(signal.payload)); } if (this.connection.currentRemoteDescription) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`WebRTC answer timed out for ${nodeId}`); }
  private waitForOpen() { return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("WebRTC data channel timed out")), 30_000); this.channel.onopen = () => { clearTimeout(timer); resolve(); }; this.channel.onerror = () => { clearTimeout(timer); reject(new Error("WebRTC data channel failed")); }; }); }
  close() { if (!this.closed) { this.closed = true; this.channel.close(); this.connection.close(); } }
}

function waitForIceGathering(connection: RTCPeerConnection) { if (connection.iceGatheringState === "complete") return Promise.resolve(); return new Promise<void>((resolve) => { const listener = () => { if (connection.iceGatheringState === "complete") { connection.removeEventListener("icegatheringstatechange", listener); resolve(); } }; connection.addEventListener("icegatheringstatechange", listener); }); }
