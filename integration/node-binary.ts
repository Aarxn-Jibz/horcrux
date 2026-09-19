import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let built: Promise<string> | undefined;

export function nodeBinary() {
  if (process.env.HORCRUX_NODE_BINARY) return Promise.resolve(process.env.HORCRUX_NODE_BINARY);
  return built ??= build();
}

async function build() {
  const output = join(await mkdtemp(join(tmpdir(), "horcrux-node-bin-")), "horcrux-node");
  const child = Bun.spawn(["go", "build", "-o", output, "./cmd/horcrux-node"], { cwd: join(import.meta.dir, "../apps/node"), stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(`Go node build failed:\n${await new Response(child.stderr).text()}`);
  return output;
}
