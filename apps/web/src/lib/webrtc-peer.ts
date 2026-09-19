import { createWebRtcSession, readWebRtcSignals, sendWebRtcSignal } from "./webrtc-signaling";

export class HorcruxPeer {
  readonly connection: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  private closed = false;
  private constructor(connection: RTCPeerConnection, channel: RTCDataChannel) { this.connection = connection; this.channel = channel; }
  static async connect(nodeId: string) {
    const session = await createWebRtcSession(nodeId); const connection = new RTCPeerConnection({ iceServers: session.iceServers }); const channel = connection.createDataChannel("horcrux", { ordered: true }); const peer = new HorcruxPeer(connection, channel);
    // Register before applying the answer: on a local/LAN path ICE and DTLS can
    // complete synchronously enough to otherwise miss the open event.
    const opened = peer.waitForOpen(); void opened.catch(() => {});
    connection.onicecandidate = ({ candidate }) => { if (candidate) void sendWebRtcSignal(session.sessionId, { nodeId, type: "ice-candidate", payload: JSON.stringify(candidate.toJSON()) }).catch(() => peer.close()); };
    try {
      const offer = await connection.createOffer(); await connection.setLocalDescription(offer); await waitForIceGathering(connection); await sendWebRtcSignal(session.sessionId, { nodeId, type: "offer", payload: connection.localDescription!.sdp! });
      await peer.waitForAnswer(session.sessionId, nodeId); await opened; return peer;
    } catch (error) { peer.close(); throw error; }
  }
  private async waitForAnswer(sessionId: string, nodeId: string) { const deadline = Date.now() + 30_000; while (!this.closed && Date.now() < deadline) { const response = await readWebRtcSignals(sessionId); for (const signal of response.signals) { if (signal.type === "answer" && !this.connection.currentRemoteDescription) await this.connection.setRemoteDescription({ type: "answer", sdp: signal.payload }); else if (signal.type === "ice-candidate") await this.connection.addIceCandidate(JSON.parse(signal.payload)); } if (this.connection.currentRemoteDescription) return; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error(`WebRTC answer timed out for ${nodeId}`); }
  private waitForOpen() { return new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => { clearTimeout(timer); this.channel.removeEventListener("open", open); this.channel.removeEventListener("error", fail); this.channel.removeEventListener("close", fail); callback(); };
    const open = () => finish(resolve); const fail = () => finish(() => reject(new Error("WebRTC data channel failed to open")));
    const timer = setTimeout(() => finish(() => reject(new Error("WebRTC data channel timed out"))), 30_000);
    this.channel.addEventListener("open", open, { once: true }); this.channel.addEventListener("error", fail, { once: true }); this.channel.addEventListener("close", fail, { once: true });
  }); }
  close() { if (!this.closed) { this.closed = true; this.channel.close(); this.connection.close(); } }
}

function waitForIceGathering(connection: RTCPeerConnection) { if (connection.iceGatheringState === "complete") return Promise.resolve(); return new Promise<void>((resolve, reject) => { const finish = (callback: () => void) => { clearTimeout(timer); connection.removeEventListener("icegatheringstatechange", listener); callback(); }; const listener = () => { if (connection.iceGatheringState === "complete") finish(resolve); }; const timer = setTimeout(() => finish(() => reject(new Error("WebRTC ICE gathering timed out"))), 30_000); connection.addEventListener("icegatheringstatechange", listener); }); }
