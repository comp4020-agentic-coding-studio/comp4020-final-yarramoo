// Test support: run the real server (`node src/server.ts`) as a child process on
// a throwaway data directory, so a test can stop it, kill it and start it again.
// Not imported by app code. Paths come from import.meta.url, so it works from
// any working directory (the host in CI, a laptop, ...).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const all = new Set<TestServer>();

export class TestServer {
  readonly dataDir = mkdtempSync(join(tmpdir(), "mc-test-"));
  port = 0;
  output = "";
  private proc: ChildProcess | null = null;
  private readonly env: Record<string, string>;
  /** Extra environment, e.g. { ABANDON_AFTER_MS: "3000" }. */
  constructor(env: Record<string, string> = {}) {
    this.env = env;
    all.add(this);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Start the server and resolve once it is listening. The port is kept across restarts. */
  async start(): Promise<void> {
    if (this.proc) throw new Error("already running");
    if (!this.port) this.port = await freePort();
    const proc = spawn(process.execPath, ["src/server.ts"], {
      cwd: repoRoot,
      env: { ...process.env, ...this.env, DATA_DIR: this.dataDir, PORT: String(this.port), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.once("exit", () => { if (this.proc === proc) this.proc = null; });
    const onData = (b: Buffer): void => { this.output += b.toString(); };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    const from = this.output.length;
    const deadline = Date.now() + 10_000;
    while (!this.output.slice(from).includes("listening on")) {
      if (!this.proc) throw new Error(`server exited while starting:\n${this.output.slice(from)}`);
      if (Date.now() > deadline) throw new Error(`server did not start in 10 s:\n${this.output.slice(from)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Signal the process and wait for it to exit. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill(signal);
    await exited;
    this.proc = null;
  }

  /** Stop if running, then delete the data directory. */
  async dispose(): Promise<void> {
    await this.stop("SIGKILL").catch(() => {});
    all.delete(this);
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

/** For afterAll: kills every server this file started, even when a test failed. */
export async function disposeAll(): Promise<void> {
  await Promise.all([...all].map((s) => s.dispose()));
}
