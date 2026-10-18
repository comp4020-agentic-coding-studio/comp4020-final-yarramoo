// The dashboard: a public aggregate view and a token-gated admin view over SSE. Players' names never reach the public one.
import { get, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { buildHashHex, connect, register, sleep, waitFor, WASM, type TestClient } from "./helpers.ts";

interface Sse {
  events: { event: string; data: string }[];
  raw: string;
  res: IncomingMessage;
  status: number;
  close(): void;
}

function openSse(port: number, query = "", headers: Record<string, string> = {}): Promise<Sse> {
  return new Promise((ok, bad) => {
    const req = get({ host: "127.0.0.1", port, path: `/dashboard/stream${query}`, headers }, (res) => {
      const s: Sse = { events: [], raw: "", res, status: res.statusCode ?? 0, close: () => req.destroy() };
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        s.raw += c;
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data !== undefined) s.events.push({ event: ev, data });
        }
      });
      res.on("error", () => {});
      ok(s);
    });
    req.on("error", bad);
  });
}

const kinds = (s: Sse) => new Set(s.events.map((e) => e.event));

describe("dashboard", () => {
  let srv: RunningServer | undefined;
  const clients: TestClient[] = [];
  const streams: Sse[] = [];
  const start = async (adminToken?: string) =>
    (srv = await startServer({ wasmPath: WASM, dataDir: null, quiet: true, adminToken: adminToken ?? "" }));
  const sse = async (...a: Parameters<typeof openSse>) => {
    const s = await openSse(...a);
    streams.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = undefined;
  });
  const join = async (port: number, name: string, world = 0) => {
    const p = await register(port, name);
    const c = await connect(port, await buildHashHex(), { world, token: p.token });
    clients.push(c);
    return { c, p };
  };

  it("serves the page with no token and no player name in it", async () => {
    await start("secret");
    await join(srv!.port, "Zorblax");
    const r = await fetch(`http://127.0.0.1:${srv!.port}/dashboard`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("Zorblax");
    expect(html).not.toContain("secret");
    const t = await fetch(`http://127.0.0.1:${srv!.port}/dashboard?token=secret`);
    expect(await t.text()).not.toContain("secret");
  });

  it("/api/summary has both worlds and the process fields", async () => {
    await start();
    const j = (await (await fetch(`http://127.0.0.1:${srv!.port}/api/summary`)).json()) as any;
    expect(j.worlds.map((w: any) => w.world)).toEqual([0, 1]);
    for (const k of ["rssMb", "heapMb", "lagP99Ms", "uptimeS"]) expect(typeof j.process[k]).toBe("number");
  });

  it("the public stream carries summaries only and no names", async () => {
    await start("secret");
    const { p } = await join(srv!.port, "Zorblax");
    const s = await sse(srv!.port);
    expect(s.status).toBe(200);
    expect(s.res.headers["content-type"]).toBe("text/event-stream");
    expect(s.res.headers["x-accel-buffering"]).toBe("no");
    await waitFor(() => s.events.some((e) => e.event === "summary"), 5000, "summary");
    await join(srv!.port, "Quillfeather"); // a join event must not leak either
    await sleep(2000);
    expect(kinds(s)).toEqual(new Set(["summary"]));
    expect(s.raw).not.toContain("Zorblax");
    expect(s.raw).not.toContain("Quillfeather");
    expect(s.raw).not.toContain(`#${p.id}`);
  });

  it("the admin stream gets backlog, conns with Name#id, then live log events", async () => {
    await start("secret");
    const { p } = await join(srv!.port, "Zorblax");
    const s = await sse(srv!.port, "?token=secret");
    await waitFor(() => s.events.some((e) => e.event === "conns"), 5000, "conns");
    const order = s.events.map((e) => e.event);
    expect(order.indexOf("backlog")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("backlog")).toBeLessThan(order.indexOf("conns"));
    const conns = JSON.parse(s.events.find((e) => e.event === "conns")!.data) as { who: string }[];
    expect(conns.map((c) => c.who)).toContain(`Zorblax#${p.id}`);
    await join(srv!.port, "Quillfeather");
    await waitFor(() => s.events.some((e) => e.event === "log" && e.data.includes("Quillfeather")), 5000, "live join");
  });

  it("a Bearer header also works", async () => {
    await start("secret");
    const s = await sse(srv!.port, "", { authorization: "Bearer secret" });
    await waitFor(() => s.events.some((e) => e.event === "backlog"), 5000, "backlog");
  });

  it.each([["wrong", "?token=nope"], ["same length", "?token=secreT"], ["empty", "?token="]])("a %s token gets the public view only", async (_n, q) => {
    await start("secret");
    await join(srv!.port, "Zorblax");
    const s = await sse(srv!.port, q);
    await waitFor(() => s.events.length > 0, 5000, "summary");
    await sleep(1500);
    expect(kinds(s)).toEqual(new Set(["summary"]));
    expect(s.raw).not.toContain("Zorblax");
  });

  it("with no ADMIN_TOKEN configured a token gets the public view", async () => {
    await start();
    const s = await sse(srv!.port, "?token=");
    const t = await sse(srv!.port, "?token=undefined");
    await waitFor(() => s.events.length > 0 && t.events.length > 0, 5000, "summary");
    await sleep(1200);
    expect(kinds(t)).toEqual(new Set(["summary"]));
    expect(kinds(s)).toEqual(new Set(["summary"]));
  });

  it("refuses the ninth stream with 503", async () => {
    await start();
    for (let i = 0; i < 8; i++) expect((await sse(srv!.port)).status).toBe(200);
    expect((await sse(srv!.port)).status).toBe(503);
  });

  it("a full public cap does not lock the admin out; admin has its own cap", async () => {
    await start("secret");
    for (let i = 0; i < 8; i++) expect((await sse(srv!.port)).status).toBe(200);
    expect((await sse(srv!.port)).status).toBe(503);
    for (let i = 0; i < 4; i++) expect((await sse(srv!.port, "?token=secret")).status).toBe(200);
    expect((await sse(srv!.port, "?token=secret")).status).toBe(503);
  });

  it("close() with open streams resolves promptly", async () => {
    await start("secret");
    const s = await sse(srv!.port, "?token=secret");
    await sse(srv!.port);
    await waitFor(() => s.events.length > 0, 5000, "first event");
    const t0 = performance.now();
    await srv!.close();
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
