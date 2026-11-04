// Security hardening, low-severity items (sec-probe S3/S4, sec-review-code S5/S8): response headers, WebSocket Origin check, limited logs.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../../server/main.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function boot(extra: Parameters<typeof startServer>[0] = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: null, quiet: true, adminToken: "t", ...extra });
  cleanups.push(() => s.close());
  return s;
}
const open = (port: number, origin?: string) =>
  new Promise<"open" | "refused">((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { headers: { origin } });
    ws.on("open", () => (ws.close(), ok("open")));
    ws.on("error", () => ok("refused"));
    ws.on("unexpected-response", () => ok("refused"));
  });

describe("security headers", () => {
  it("every kind of response carries nosniff, referrer-policy and frame-ancestors", async () => {
    const s = await boot();
    for (const p of ["/", "/dashboard", "/api/summary", "/nope-404"]) {
      const r = await fetch(`http://127.0.0.1:${s.port}${p}`);
      await r.arrayBuffer();
      expect(r.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(r.headers.get("referrer-policy"), p).toBe("same-origin");
      expect(r.headers.get("content-security-policy"), p).toBe("frame-ancestors 'self'");
    }
  });
});

describe("websocket origin", () => {
  it("refuses a foreign Origin, allows same-origin, allowlisted and absent", async () => {
    const s = await boot({ allowedOrigins: ["https://ok.example"] });
    expect(await open(s.port, "https://evil.example")).toBe("refused");
    expect(await open(s.port, `http://127.0.0.1:${s.port}`)).toBe("open");
    expect(await open(s.port, "https://ok.example")).toBe("open");
    expect(await open(s.port)).toBe("open");
  });
});
