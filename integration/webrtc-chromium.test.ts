import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { encodeBase64Url } from "../packages/protocol/src";
import { nodeBinary } from "./node-binary";

type Process = ReturnType<typeof Bun.spawn>;
type Node = { directory: string; process: Process; id?: string };
type Session = { accessToken: string };

const CHROMIUM = process.env.HORCRUX_CHROMIUM ?? "/usr/bin/chromium";
const GO_CACHE = join(process.cwd(), ".integration-cache", "go-build");
const GO_MODULE_CACHE = join(process.cwd(), ".integration-cache", "go-mod");
let buildTempRoot = "";

describe("Chromium browser and Pion node WebRTC data plane", () => {
  let root = "";
  let apiUrl = "";
  let webUrl = "";
  let api: Process | undefined;
  let web: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  let nodes: Node[] = [];
  let session: Session;

  const cleanup = async () => {
    await browser?.close().catch(() => undefined);
    for (const node of nodes) node.process.kill();
    await Promise.all(nodes.map((node) => node.process.exited.catch(() => 0)));
    web?.stop(true);
    api?.kill();
    if (api) await api.exited.catch(() => 0);
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
    buildTempRoot = "";
  };

  beforeAll(async () => {
    try {
    console.log("webrtc e2e: starting control plane");
    // Chromium and cgo link steps can exceed the constrained /tmp filesystem.
    // Keep this disposable cluster under the repository's roomy workspace and
    // remove it in afterAll.
    root = await mkdtemp(join(process.cwd(), ".tmp-webrtc-"));
    buildTempRoot = root;
    await Promise.all([mkdir(join(root, "go-tmp")), mkdir(GO_CACHE, { recursive: true }), mkdir(GO_MODULE_CACHE, { recursive: true })]);
    const [apiPort, webPort] = await Promise.all([reservePort(), reservePort()]);
    apiUrl = `http://127.0.0.1:${apiPort}`;
    webUrl = `http://127.0.0.1:${webPort}`;
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)));
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
    const environmentFile = join(root, "api.env");
    await Bun.write(environmentFile, `JWT_SECRET=webrtc-test-${crypto.randomUUID()}\nWEB_ORIGIN=${webUrl}\nCAPABILITY_PRIVATE_KEY=${privateKey}\nCAPABILITY_PUBLIC_KEY=${publicKey}\nTURN_KEY_ID=test-key\nTURN_API_TOKEN=test-only-token\nTURN_CREDENTIALS_URL=${webUrl}/turn-credentials\n`);
    const persistence = join(root, "d1");
    console.log("webrtc e2e: migrating local D1");
    await run(["./node_modules/.bin/wrangler", "d1", "migrations", "apply", "horcrux-file-system", "--local", "--persist-to", persistence], "apps/api");
    console.log("webrtc e2e: local D1 migrated");
    api = Bun.spawn(["./node_modules/.bin/wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(apiPort), "--persist-to", persistence, "--env-file", environmentFile, "--log-level", "error"], { cwd: "apps/api", stdout: "pipe", stderr: "pipe" });
    await waitFor(() => fetch(`${apiUrl}/health`).then((response) => response.ok).catch(() => false), "control plane");
    console.log("webrtc e2e: starting browser origin");
    const bundle = join(root, "webrtc-transport.js");
    const built = await Bun.build({ entrypoints: [join(process.cwd(), "packages/storage/src/webrtc.ts")], outdir: root, naming: "webrtc-transport.js", target: "browser", format: "esm" });
    if (!built.success) throw new Error(`Could not build browser transport: ${built.logs.map((log) => log.message).join("; ")}`);
    web = Bun.serve({ hostname: "127.0.0.1", port: webPort, fetch(request) {
      return new URL(request.url).pathname === "/turn-credentials"
        ? Response.json({ iceServers: [{ urls: ["stun:stun.example.test:3478"] }] })
        : new URL(request.url).pathname === "/webrtc-transport.js"
        ? new Response(Bun.file(bundle), { headers: { "Content-Type": "text/javascript" } })
        : new Response("<!doctype html><title>Horcrux WebRTC integration</title>", { headers: { "Content-Type": "text/html" } });
    } });
    session = await request<Session>("/auth/register", { method: "POST", body: JSON.stringify({ email: `webrtc-${crypto.randomUUID()}@example.com`, password: "browser-webrtc-correct-horse" }) }, false);
    const binary = await nodeBinary();
    console.log("webrtc e2e: starting node processes");
    const ports = await Promise.all([reservePort(), reservePort()]);
    nodes = await Promise.all(ports.map(async (port, index) => {
      const challenge = await request<{ challengeId: string; token: string }>("/devices/enrollment-challenges", { method: "POST" });
      const directory = join(root, `node-${index + 1}`);
      const child = Bun.spawn([binary, "--data-dir", directory, "--listen", `127.0.0.1:${port}`, "--transport", "webrtc", "--control-plane-public-key", publicKey, "--control-plane-url", apiUrl, "--enrollment-challenge", challenge.challengeId, "--node-name", `webrtc-node-${index + 1}`, "--web-origin", webUrl], { env: { ...process.env, HORCRUX_ENROLLMENT_TOKEN: challenge.token }, stdout: "inherit", stderr: "inherit" });
      console.log(`webrtc e2e: node ${index + 1} listening`);
      return { directory, process: child };
    }));
    await waitFor(async () => {
      const devices = await request<{ devices: Array<{ id: string; endpoint?: string; transport: string; status: string; health: string }> }>("/devices");
      const healthy = devices.devices.filter((item) => item.status === "online" && item.health === "healthy");
      nodes.forEach((node, index) => { node.id = healthy.find((item) => item.transport === "webrtc" && !nodes.slice(0, index).some((prior) => prior.id === item.id))?.id; });
      return nodes.every((node) => node.id) && healthy.filter((item) => item.transport === "webrtc" && item.endpoint === undefined).length === 2;
    }, "enrolled node heartbeats", 45_000);
    console.log("webrtc e2e: launching Chromium");
    // Pion is not a browser mDNS resolver; expose loopback host candidates for
    // this direct local integration path rather than relying on a TURN relay.
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns", "--force-webrtc-ip-handling-policy=default"] });
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  });

  test("streams a multi-chunk opaque object over a real browser DataChannel and reads it back", async () => {
    console.log("webrtc e2e: running DataChannel transfer");
    const page = await browser!.newPage();
    if (process.env.HORCRUX_WEBRTC_DEBUG === "1") page.on("console", (message) => console.log(`chromium: ${message.text()}`));
    console.log("webrtc e2e: navigating Chromium");
    await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 5_000 });
    console.log("webrtc e2e: Chromium origin ready");
    const fileId = crypto.randomUUID();
    const original = deterministicBytes(3 * 1024 * 1024 + 317);
    const plaintextHash = await hash(original);
    console.log("webrtc e2e: initializing file placement");
    const initialized = await request<{ nodes: Array<{ id: string }> }>("/files/init", { method: "POST", body: JSON.stringify({ fileId, originalName: "webrtc.bin", mimeType: "application/octet-stream", originalSize: original.byteLength, plaintextHash, dataShards: 1, parityShards: 1, keyShareThreshold: 2, keyShareCount: 2, storageMode: "webrtc", formatVersion: 2 }) });
    expect(initialized.nodes).toHaveLength(2);
    await request(`/files/${fileId}/state`, { method: "POST", body: JSON.stringify({ status: "distributing" }) });
    console.log("webrtc e2e: beginning browser transport");
    const uploaded = await page.evaluate(async ({ apiUrl, token, fileId, nodeIds, bytes, storagePath }) => {
      console.log("loading WebRtcShardTransport");
      const { WebRtcShardTransport } = await import(/* @vite-ignore */ storagePath) as typeof import("../packages/storage/src/webrtc");
      const request = async <T>(path: string, body?: unknown, method = "POST") => {
        const response = await fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
        return response.json() as Promise<T>;
      };
      const peers: RTCPeerConnection[] = [];
      const waitForChannelOpen = (peer: RTCPeerConnection, channel: RTCDataChannel, nodeId: string) => new Promise<void>((resolve, reject) => {
        const finish = (callback: () => void) => { clearTimeout(timer); channel.removeEventListener("open", open); channel.removeEventListener("error", fail); channel.removeEventListener("close", fail); callback(); };
        const open = () => { console.log(`channel open ${nodeId}`); finish(resolve); };
        const fail = () => finish(() => reject(new Error(`DataChannel failed to open for ${nodeId}`)));
        const timer = setTimeout(() => { const candidates = (description: RTCSessionDescription | null) => description?.sdp.match(/^a=candidate:/gm)?.length ?? 0; finish(() => reject(new Error(`DataChannel open timed out for ${nodeId}: channel=${channel.readyState} connection=${peer.connectionState} ice=${peer.iceConnectionState} gathering=${peer.iceGatheringState} local=${peer.localDescription?.type ?? "none"}/${candidates(peer.localDescription)} remote=${peer.remoteDescription?.type ?? "none"}/${candidates(peer.remoteDescription)}`))); }, 30_000);
        channel.addEventListener("open", open, { once: true }); channel.addEventListener("error", fail, { once: true }); channel.addEventListener("close", fail, { once: true });
      });
      const connect = async (nodeId: string) => {
        console.log(`creating signaling session for ${nodeId}`);
        const session = await request<{ sessionId: string; iceServers: RTCIceServer[] }>("/webrtc/sessions", { nodeId });
        const peer = new RTCPeerConnection({ iceServers: session.iceServers }); peers.push(peer);
        const channel = peer.createDataChannel("horcrux", { ordered: true }); channel.binaryType = "arraybuffer";
        peer.onicegatheringstatechange = () => console.log(`ICE gathering ${nodeId}: ${peer.iceGatheringState}`);
        peer.oniceconnectionstatechange = () => console.log(`ICE connection ${nodeId}: ${peer.iceConnectionState}`);
        peer.onconnectionstatechange = () => console.log(`peer connection ${nodeId}: ${peer.connectionState}`);
        peer.onicecandidate = ({ candidate }) => console.log(`local ICE candidate ${nodeId}: ${candidate?.candidate ?? "end-of-candidates"}`);
        channel.onclosing = () => console.log(`channel closing ${nodeId}`);
        channel.onclose = () => console.log(`channel closed ${nodeId}`);
        const opened = waitForChannelOpen(peer, channel, nodeId);
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
        if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve) => peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); }, { once: false }));
        if (!peer.localDescription?.sdp.includes("a=candidate:")) throw new Error(`Browser produced no local ICE candidates for ${nodeId}`);
        console.log(`offer SDP ${nodeId}: ${peer.localDescription!.sdp}`);
        await request(`/webrtc/sessions/${session.sessionId}/signals`, { nodeId, type: "offer", payload: peer.localDescription!.sdp });
        console.log(`offer posted for ${nodeId}`);
        const deadline = Date.now() + 30_000;
        let lastSignalProgress = Date.now();
        while (!peer.currentRemoteDescription && Date.now() < deadline) {
          if (Date.now() - lastSignalProgress >= 1_000) { console.log(`waiting for answer ${nodeId}`); lastSignalProgress = Date.now(); }
          const signals = await request<{ signals: Array<{ type: "answer" | "ice-candidate"; payload: string }> }>(`/webrtc/sessions/${session.sessionId}/signals`, undefined, "GET");
          for (const signal of signals.signals) {
            if (signal.type === "answer" && !peer.currentRemoteDescription) { console.log(`answer SDP ${nodeId}: ${signal.payload}`); await peer.setRemoteDescription({ type: "answer", sdp: signal.payload }); }
            else if (signal.type === "ice-candidate") { console.log(`remote ICE candidate ${nodeId}: ${signal.payload}`); await peer.addIceCandidate(JSON.parse(signal.payload)); }
          }
          if (!peer.currentRemoteDescription) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!peer.currentRemoteDescription) throw new Error("Pion answer timed out");
        await opened;
        return { channel, close: () => peer.close() };
      };
      const receipts: string[] = [];
      const transport = new WebRtcShardTransport(
        connect,
        async (input: { nodeId: string; fileId: string; objectId: string; operation: "PUT" | "GET" | "DELETE"; maxSize?: number }) => (await request<{ capability: string }>(`/nodes/${input.nodeId}/capabilities`, input)).capability,
        async ({ nodeId, fileId: receiptFileId, receipt }: { nodeId: string; fileId: string; receipt: string }) => { receipts.push(receipt); await request(`/nodes/${nodeId}/receipts`, { fileId: receiptFileId, receipt }); },
      );
      const source = new Uint8Array(bytes);
      for (let index = 0; index < source.byteLength; index += 1) source[index] = (index * 31 + (index >>> 7)) & 0xff;
      const shard = await transport.putShard(nodeIds[0], `${fileId}/shard-0`, source);
      const share0 = await transport.putShard(nodeIds[0], `${fileId}/share-0`, new Uint8Array([1, 2, 3, 4]));
      const share1 = await transport.putShard(nodeIds[1], `${fileId}/share-1`, new Uint8Array([5, 6, 7, 8]));
      return { shard, share0, share1, receiptCount: receipts.length };
    }, { apiUrl, token: session.accessToken, fileId, nodeIds: initialized.nodes.map((node) => node.id), bytes: original.byteLength, storagePath: "/webrtc-transport.js" });
    expect(uploaded.receiptCount).toBe(3);
    expect(uploaded.shard.size).toBe(original.byteLength);
    expect(uploaded.shard.checksum).toBe(await hash(original));

    const nodeFor = new Map(nodes.map((node) => [node.id, node]));
    const db = new Database(join(nodeFor.get(uploaded.shard.nodeId)!.directory, "metadata.sqlite"), { readonly: true });
    const stored = db.query<{ checksum: string; size: number }, [string]>("SELECT checksum,size FROM objects WHERE object_id=? AND status='stored'").get(`${fileId}/shard-0`);
    db.close();
    expect(stored).toEqual({ checksum: uploaded.shard.checksum, size: original.byteLength });

    await request(`/files/${fileId}/complete`, { method: "POST", body: JSON.stringify({ formatVersion: 2, chunkSize: 1_048_576, chunkCount: 1, noncePrefix: "test-prefix", objects: [
      { id: crypto.randomUUID(), kind: "shard", index: 0, nodeId: uploaded.shard.nodeId, objectId: uploaded.shard.objectId, size: uploaded.shard.size, checksum: uploaded.shard.checksum, shardType: "data", status: "stored" },
      { id: crypto.randomUUID(), kind: "key-share", index: 0, nodeId: uploaded.share0.nodeId, objectId: uploaded.share0.objectId, size: uploaded.share0.size, checksum: uploaded.share0.checksum, status: "stored" },
      { id: crypto.randomUUID(), kind: "key-share", index: 1, nodeId: uploaded.share1.nodeId, objectId: uploaded.share1.objectId, size: uploaded.share1.size, checksum: uploaded.share1.checksum, status: "stored" },
    ] }) });
    const downloaded = await page.evaluate(async ({ apiUrl, token, fileId, nodeId, objectId, storagePath }) => {
      const { WebRtcShardTransport } = await import(/* @vite-ignore */ storagePath) as typeof import("../packages/storage/src/webrtc");
      const request = async <T>(path: string, body?: unknown, method = "POST") => { const response = await fetch(`${apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json() as Promise<T>; };
      const connect = async (target: string) => {
        const session = await request<{ sessionId: string; iceServers: RTCIceServer[] }>("/webrtc/sessions", { nodeId: target }); const peer = new RTCPeerConnection({ iceServers: session.iceServers }); const channel = peer.createDataChannel("horcrux", { ordered: true }); channel.binaryType = "arraybuffer";
        peer.onicegatheringstatechange = () => console.log(`ICE gathering ${target}: ${peer.iceGatheringState}`); peer.oniceconnectionstatechange = () => console.log(`ICE connection ${target}: ${peer.iceConnectionState}`); peer.onconnectionstatechange = () => console.log(`peer connection ${target}: ${peer.connectionState}`); peer.onicecandidate = ({ candidate }) => console.log(`local ICE candidate ${target}: ${candidate?.candidate ?? "end-of-candidates"}`);
        const opened = new Promise<void>((resolve, reject) => { const finish = (callback: () => void) => { clearTimeout(timer); channel.removeEventListener("open", open); channel.removeEventListener("error", fail); channel.removeEventListener("close", fail); callback(); }; const open = () => { console.log(`channel open ${target}`); finish(resolve); }; const fail = () => finish(() => reject(new Error(`DataChannel failed to open for ${target}`))); const timer = setTimeout(() => finish(() => reject(new Error(`DataChannel open timed out for ${target}`))), 30_000); channel.addEventListener("open", open, { once: true }); channel.addEventListener("error", fail, { once: true }); channel.addEventListener("close", fail, { once: true }); });
        await peer.setLocalDescription(await peer.createOffer()); if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve) => peer.addEventListener("icegatheringstatechange", () => peer.iceGatheringState === "complete" && resolve()));
        console.log(`offer SDP ${target}: ${peer.localDescription!.sdp}`); await request(`/webrtc/sessions/${session.sessionId}/signals`, { nodeId: target, type: "offer", payload: peer.localDescription!.sdp }); const until = Date.now() + 30_000; let lastSignalProgress = Date.now();
        while (!peer.currentRemoteDescription && Date.now() < until) { if (Date.now() - lastSignalProgress >= 1_000) { console.log(`waiting for answer ${target}`); lastSignalProgress = Date.now(); } const signals = await request<{ signals: Array<{ type: "answer" | "ice-candidate"; payload: string }> }>(`/webrtc/sessions/${session.sessionId}/signals`, undefined, "GET"); for (const signal of signals.signals) { if (signal.type === "answer" && !peer.currentRemoteDescription) { console.log(`answer SDP ${target}: ${signal.payload}`); await peer.setRemoteDescription({ type: "answer", sdp: signal.payload }); } else if (signal.type === "ice-candidate") { console.log(`remote ICE candidate ${target}: ${signal.payload}`); await peer.addIceCandidate(JSON.parse(signal.payload)); } } if (!peer.currentRemoteDescription) await new Promise((resolve) => setTimeout(resolve, 100)); }
        if (!peer.currentRemoteDescription) throw new Error("answer timed out"); await opened; return { channel, close: () => peer.close() };
      };
      const transport = new WebRtcShardTransport(connect, async (input: { nodeId: string; fileId: string; objectId: string; operation: "PUT" | "GET" | "DELETE" }) => (await request<{ capability: string }>(`/nodes/${input.nodeId}/capabilities`, input)).capability);
      const bytes = await transport.getShard(nodeId, objectId);
      await transport.deleteShard(nodeId, objectId);
      let deleted = false; try { await transport.getShard(nodeId, objectId); } catch { deleted = true; }
      return { bytes: [...bytes], deleted };
    }, { apiUrl, token: session.accessToken, fileId, nodeId: uploaded.shard.nodeId, objectId: uploaded.shard.objectId, storagePath: "/webrtc-transport.js" });
    expect(new Uint8Array(downloaded.bytes)).toEqual(original);
    expect(await hash(new Uint8Array(downloaded.bytes))).toBe(await hash(original));
    expect(downloaded.deleted).toBe(true);
    await page.close();
  }, 120_000);

  async function request<T = unknown>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers); if (init.body) headers.set("Content-Type", "application/json"); if (authenticated) headers.set("Authorization", `Bearer ${session.accessToken}`);
    const response = await fetch(`${apiUrl}${path}`, { ...init, headers }); if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`); return response.json() as Promise<T>;
  }
});

function deterministicBytes(size: number) { const bytes = new Uint8Array(size); for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + (index >>> 7)) & 0xff; return bytes; }
async function hash(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
async function run(command: string[], cwd: string) { const temp = join(buildTempRoot, "go-tmp"); const child = Bun.spawn(command, { cwd, env: { ...process.env, CI: "1", GOCACHE: GO_CACHE, GOMODCACHE: GO_MODULE_CACHE, GOTMPDIR: temp, TMPDIR: temp }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed: ${await new Response(child.stderr).text()}`); }
async function reservePort() { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not reserve port"); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return address.port; }
async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 30_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(100); } throw new Error(`Timed out waiting for ${label}`); }
