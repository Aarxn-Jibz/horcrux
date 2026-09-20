import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeBase64Url } from "../packages/protocol/src";

const root = process.cwd();
const state = join(root, ".demo-local");
const apiUrl = "http://127.0.0.1:8787";
const webUrl = "http://127.0.0.1:5173";
const email = "demo@horcrux.local";
const password = "horcrux-demo-password";
const kdf = { version: "pbkdf2-sha256-v1", algorithm: "PBKDF2", hash: "SHA-256", iterations: 310_000, salt: "AAAAAAAAAAAAAAAAAAAAAA==", derivedKeyLength: 256 } as const;
const children: ReturnType<typeof Bun.spawn>[] = [];

await mkdir(state, { recursive: true });
const envFile = join(state, "api.env");
if (!(await Bun.file(envFile).exists())) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  await Bun.write(envFile, `JWT_SECRET=${crypto.randomUUID()}-${crypto.randomUUID()}\nAUTH_PEPPER=local-demo-pepper\nWEB_ORIGIN=${webUrl}\nCAPABILITY_PRIVATE_KEY=${encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))}\nCAPABILITY_PUBLIC_KEY=${encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))}\n`);
}
const env = Object.fromEntries((await readFile(envFile, "utf8")).trim().split("\n").map((line) => line.split("=", 2))) as Record<string, string>;

async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`${command.join(" ")} failed`);
}
async function waitFor(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(200); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function credential() {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return Buffer.from(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(kdf.salt, "base64"), iterations: kdf.iterations }, key, 256)).toString("base64");
}
async function request(path: string, body?: unknown, token?: string) {
  const response = await fetch(`${apiUrl}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
function spawn(command: string[], cwd = root, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...extraEnv }, stdout: "inherit", stderr: "inherit" }); children.push(child); return child;
}
function stop() { for (const child of children) child.kill(); }
process.on("SIGINT", () => { stop(); process.exit(); });
process.on("SIGTERM", () => { stop(); process.exit(); });

await run(["./node_modules/.bin/wrangler", "d1", "migrations", "apply", "horcrux-file-system", "--local", "--persist-to", join(state, "d1")], join(root, "apps/api"));
spawn(["./node_modules/.bin/wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", "8787", "--persist-to", join(state, "d1"), "--env-file", envFile, "--log-level", "error"], join(root, "apps/api"));
await waitFor(async () => fetch(`${apiUrl}/health`).then((r) => r.ok).catch(() => false), "local control plane");
let session: { accessToken: string };
try { session = await request("/auth/register", { email, credential: await credential(), kdf }); } catch (error) { if (!String(error).includes("409")) throw error; session = await request("/auth/login", { email, credential: await credential() }); }
await run(["go", "build", "-o", "horcrux-node", "./cmd/horcrux-node"], join(root, "apps/node"));
for (let index = 1; index <= 5; index++) {
  const data = join(state, `node-${index}`); const identity = join(data, "identity.json"); const args = [join(root, "apps/node/horcrux-node"), "--data-dir", data, "--listen", `127.0.0.1:${9442 + index}`, "--advertise-url", `http://127.0.0.1:${9442 + index}`, "--control-plane-public-key", env.CAPABILITY_PUBLIC_KEY!, "--control-plane-url", apiUrl, "--node-name", `Demo node ${index}`, "--web-origin", webUrl, "--heartbeat-interval", "10s"];
  if (!(await Bun.file(identity).exists())) { const challenge = await request("/devices/enrollment-challenges", {}, session.accessToken); args.push("--enrollment-challenge", challenge.challengeId); spawn(args, root, { HORCRUX_ENROLLMENT_TOKEN: challenge.token }); } else spawn(args);
}
await waitFor(async () => (await request("/devices", undefined, session.accessToken)).devices.filter((node: any) => node.status === "online" && node.health === "healthy").length === 5, "five healthy nodes");
spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1"], join(root, "apps/web"), { VITE_API_URL: apiUrl, VITE_HORCRUX_STORAGE_MODE: "http" });
console.log(`\nREADY: ${webUrl}\nLogin: ${email}\nPassword: ${password}\nNodes: 9443 9444 9445 9446 9447\nStop a node: kill -TERM $(pgrep -f 'Demo node 4')\nCtrl+C stops Worker, Vite, and all five nodes.\n`);
await Promise.all(children.map((child) => child.exited));
