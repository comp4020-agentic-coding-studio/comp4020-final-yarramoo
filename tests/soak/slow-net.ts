// Brief SLOWNET: what a slow or lossy connection does to the player who has it and to the room. A script, not a vitest
// test: `node tests/soak/slow-net.ts` after `pnpm build:client`. Env: PORT (default 8075), OUT (summary JSON path),
// PHASES (JSON array overriding the default phases), SHOTS (png prefix: screenshots of B at the end of each phase).
//
// One real server, one Survival room (size S), two Chromium clients. A connects directly. B loads the page through a
// shaping proxy that forwards HTTP untouched and delays every WebSocket frame in order, per direction.
//
// Why a proxy and not CDP `Network.emulateNetworkConditions`: measured 8 Nov (tests/soak/slow-net-probe.ts), the
// throttle does not reach WebSocket frames, whether it is sent to the page target, to the worker target that owns the
// socket, or as `emulateNetworkConditionsByRule`: with 800 ms "latency" the client's own PING round trip stayed at
// 60-70 ms. So the shaping is done on the wire, which is also closer to what a real slow link does:
// - latency: half the RTT each way, with +-10% jitter, in order (TCP never reorders);
// - throughput: a byte rate per direction; when B's download queue passes 256 KB the proxy stops reading from the
//   server, so the server's own send queue grows exactly as it would behind a slow link (real TCP backpressure);
// - loss: TCP retransmits, so a lost segment is a head-of-line stall of one RTO for it and everything behind it;
// - blackout: nothing gets through for N seconds, then everything held arrives in a burst.
// Known gap: the server's ws ping is answered by the proxy itself, so the server-side `rtt_p95_ms` does not see the
// shaping. The client's own PING/PONG frames do pass through it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { startServer } from "../../server/main.ts";
import { encodeConfig, SURVIVAL } from "../../shared/room.ts";

const PORT = Number(process.env.PORT ?? 8075);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Shape {
  /** Added round trip, ms (half each way). */
  rtt: number;
  /** Bytes per second each way; 0 = unlimited. */
  bps: number;
  /** Probability a frame is "lost" and costs a retransmit stall. */
  loss: number;
  /** Retransmit timeout, ms. */
  rto: number;
}
interface Phase { name: string; secs: number; shape: Shape; /** Hold everything for this many seconds at the start of the phase. */ blackout?: number }
const CLEAN: Shape = { rtt: 0, bps: 0, loss: 0, rto: 300 };
const DEFAULT_PHASES: Phase[] = [
  { name: "clean", secs: 20, shape: CLEAN },
  { name: "rtt300", secs: 30, shape: { ...CLEAN, rtt: 300 } },
  { name: "rtt800", secs: 30, shape: { ...CLEAN, rtt: 800 } },
  { name: "rtt2000", secs: 30, shape: { ...CLEAN, rtt: 2000 } },
  { name: "clean2", secs: 15, shape: CLEAN },
  { name: "loss3", secs: 30, shape: { ...CLEAN, rtt: 150, loss: 0.03, rto: 400 } },
  { name: "loss10", secs: 30, shape: { ...CLEAN, rtt: 150, loss: 0.1, rto: 400 } },
  { name: "bw4k", secs: 30, shape: { ...CLEAN, rtt: 100, bps: 4000 } },
  { name: "bw1500", secs: 30, shape: { ...CLEAN, rtt: 100, bps: 1500 } },
  { name: "clean3", secs: 20, shape: CLEAN },
  { name: "blackout5", secs: 20, shape: CLEAN, blackout: 5 },
  { name: "blackout12", secs: 30, shape: CLEAN, blackout: 12 },
  { name: "clean4", secs: 15, shape: CLEAN },
];
const PHASES: Phase[] = process.env.PHASES ? JSON.parse(process.env.PHASES) : DEFAULT_PHASES;

let shape: Shape = CLEAN;
let holdUntil = 0;
let rngState = 12345;
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) >>> 0;
  return rngState / 4294967296;
};

/** In-order delivery with latency, jitter, a byte rate, retransmit stalls and blackouts. */
class Line {
  private q: { due: number; bytes: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private wireFree = 0;
  queuedBytes = 0;
  bytes = 0;
  frames = 0;
  onDrain: (() => void) | null = null;
  push(bytes: number, fn: () => void): void {
    const now = performance.now();
    const s = shape;
    let due = now + (s.rtt / 2) * (0.9 + 0.2 * rng());
    if (s.bps > 0) {
      this.wireFree = Math.max(this.wireFree, now) + (bytes / s.bps) * 1000;
      due = Math.max(due, this.wireFree + s.rtt / 2);
    }
    if (s.loss > 0 && rng() < s.loss) due += s.rto;
    due = Math.max(due, this.last, holdUntil);
    this.last = due;
    this.queuedBytes += bytes;
    this.bytes += bytes;
    this.frames++;
    this.q.push({ due, bytes, fn });
    this.arm();
  }
  private arm(): void {
    if (this.timer || !this.q.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.q.length && this.q[0].due <= now + 0.5) {
        const it = this.q.shift()!;
        this.queuedBytes -= it.bytes;
        it.fn();
      }
      this.onDrain?.();
      this.arm();
    }, Math.max(0, this.q[0].due - performance.now()));
  }
  /** A shape change re-times nothing already queued, except that a blackout's end is a floor for everything. */
  rearm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const it of this.q) it.due = Math.max(it.due, holdUntil);
    this.arm();
  }
}

const lines: Line[] = [];
const BACKPRESSURE_BYTES = 256 * 1024;
let pausedReads = 0;

function startProxy(upstreamPort: number): Promise<number> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
  const server = createServer((req, res) => {
    const up = httpRequest({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`, { headers: { "user-agent": String(req.headers["user-agent"] ?? ""), origin: `http://127.0.0.1:${upstreamPort}` }, maxPayload: 16 << 20 });
    upstream.on("error", () => socket.destroy());
    upstream.on("open", () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        const up = new Line();
        const down = new Line();
        lines.push(up, down);
        const raw = (upstream as unknown as { _socket: { pause(): void; resume(): void } })._socket;
        let paused = false;
        down.onDrain = () => {
          if (paused && down.queuedBytes < BACKPRESSURE_BYTES / 2) {
            paused = false;
            raw.resume();
          }
        };
        client.on("message", (data: RawData, isBinary) => {
          const buf = data as Buffer;
          up.push(buf.length, () => upstream.readyState === WebSocket.OPEN && upstream.send(buf, { binary: isBinary }));
        });
        upstream.on("message", (data: RawData, isBinary) => {
          const buf = data as Buffer;
          down.push(buf.length, () => client.readyState === WebSocket.OPEN && client.send(buf, { binary: isBinary }));
          if (!paused && down.queuedBytes > BACKPRESSURE_BYTES) {
            paused = true;
            pausedReads++;
            raw.pause();
          }
        });
        const fwdClose = (to: WebSocket, line: Line, code: number, reason: string) =>
          line.push(0, () => {
            if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) to.close(code >= 3000 || code === 1000 ? code : 1000, reason);
          });
        client.on("close", (code, reason) => fwdClose(upstream, up, code, reason.toString()));
        upstream.on("close", (code, reason) => fwdClose(client, down, code, reason.toString()));
        client.on("error", () => client.terminate());
      });
    });
  });
  return new Promise((ok) => server.listen(PORT + 1, "127.0.0.1", () => ok((server.address() as AddressInfo).port)));
}

/** In-page recorder: every 50 ms, the wall clock, net state, stats and the players list. Read-only. */
const RECORDER = `(() => {
  const w = window;
  w.__rec = [];
  setInterval(() => {
    const n = w.__net, s = w.__stats, p = w.__players;
    w.__rec.push({ t: Date.now(), st: n ? n.state : "", ping: n ? n.pingMs : 0, rs: n ? n.resyncs : 0, tick: s ? s.tick : 0, buf: s ? s.buffered : 0, sps: s ? s.stepsPerSec : 0,
      me: p ? (p.find((q) => q.me) || null) : null, others: p ? p.filter((q) => !q.me).map((q) => ({ id: q.id, x: q.x, y: q.y })) : [],
      notice: (() => { const el = document.getElementById("slowNotice"); return el && !el.hidden ? el.textContent : ""; })() });
    if (w.__rec.length > 20000) w.__rec.splice(0, 5000);
  }, 50);
})();`;

const keyOps = (page: Page, ops: [string, string][]) =>
  page.evaluate((o) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const [type, key] of o) window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }, ops).catch(() => {});

/** Walk left and right, switching every 1.5 s, with a hop now and then, so position changes are easy to line up. */
async function walker(page: Page, stopAt: () => boolean, phaseOffset: number): Promise<void> {
  let dir = phaseOffset % 2 === 0 ? "d" : "a";
  await keyOps(page, [["keydown", dir]]);
  while (!stopAt()) {
    await sleep(1500);
    const next = dir === "d" ? "a" : "d";
    await keyOps(page, [["keyup", dir], ["keydown", next], ["keydown", " "]]);
    await sleep(150);
    await keyOps(page, [["keyup", " "]]);
    dir = next;
  }
  await keyOps(page, [["keyup", dir]]);
}

interface Rec { t: number; st: string; ping: number; rs: number; tick: number; buf: number; sps: number; me: { id: number; x: number; y: number } | null; others: { id: number; x: number; y: number }[]; notice: string }
interface SrvSample { t: number; lastClosed: number; tps: number; held: boolean; conns: { who: string; tickLag?: number; buffered?: number; rttMs?: number }[] }

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How late `viewer` sees `mover`'s avatar: the delay d (ms) that best lines up the viewer's view of the mover's x
 * with the mover's own (predicted) x, by least mean absolute error over the window. NaN when the mover barely moved.
 */
function perceivedDelay(mover: Rec[], viewer: Rec[], moverId: number, t0: number, t1: number): number {
  const own = mover.filter((r) => r.t >= t0 - 6000 && r.t <= t1 && r.me && r.me.id === moverId).map((r) => ({ t: r.t, x: r.me!.x }));
  const seen = viewer.filter((r) => r.t >= t0 && r.t <= t1).map((r) => ({ t: r.t, x: r.others.find((o) => o.id === moverId)?.x })).filter((r): r is { t: number; x: number } => r.x !== undefined);
  if (own.length < 20 || seen.length < 20) return NaN;
  const xs = own.map((o) => o.x);
  if (Math.max(...xs) - Math.min(...xs) < 8) return NaN;
  const at = (t: number): number | undefined => {
    let lo = 0, hi = own.length - 1;
    if (t < own[0].t || t > own[hi].t) return undefined;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (own[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = own[lo], b = own[hi];
    return b.t === a.t ? a.x : a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
  };
  let best = NaN, bestErr = Infinity;
  for (let d = 0; d <= 6000; d += 25) {
    let err = 0, n = 0;
    for (const s of seen) {
      const x = at(s.t - d);
      if (x === undefined) continue;
      err += Math.abs(x - s.x);
      n++;
    }
    if (n >= seen.length * 0.6 && err / n < bestErr) {
      bestErr = err / n;
      best = d;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const outDir = "/tmp/slownet-run";
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync("/tmp/slownet-data-");
  const srv = await startServer({ port: PORT, dataDir, quiet: true });
  const events: { t: number; ev: string; f: Record<string, unknown> }[] = [];
  srv.log.subscribe((e) => {
    if (["input.summary", "process.minute", "stats.flush"].includes(e.ev)) return;
    events.push({ t: Date.now(), ev: e.ev, f: e as unknown as Record<string, unknown> });
  });
  const proxyPort = await startProxy(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const created = (await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ name: "Slow net", mode: "survival", config: Buffer.from(encodeConfig({ ...SURVIVAL, size: 0 })).toString("base64"), visibility: "public" }) })).json()) as { id: number; code: string };
  const room = srv.worlds.get(created.id) ?? null;
  const browser = await chromium.launch({ headless: true });
  const pages: Page[] = [];
  const errors: string[] = [];
  for (const [i, name] of ["Ana", "Bo"].entries()) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    await ctx.addInitScript(RECORDER);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${name} pageerror ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console.error ${m.text().slice(0, 200)}`); });
    const origin = i === 0 ? base : `http://127.0.0.1:${proxyPort}`;
    await page.goto(`${origin}/r/${created.code}`);
    await page.waitForSelector("#name", { state: "visible", timeout: 20000 });
    await page.fill("#name", name);
    await page.click("#joinForm button");
    pages.push(page);
  }
  for (const p of pages) await p.waitForFunction(() => (window as any).__net?.state === "live" && !!(window as any).__players?.some((q: any) => q.me), null, { timeout: 60000 });
  console.log(`room ${created.code} (world ${created.id}); both live`);
  const w = srv.worlds.get(created.id) ?? room;
  if (!w) throw new Error("room not loaded");

  let stop = false;
  const walkers = pages.map((p, i) => walker(p, () => stop, i));
  const srvSamples: SrvSample[] = [];
  const sampler = setInterval(() => {
    const s = srv.summary().worlds.find((x) => x.world === created.id);
    srvSamples.push({ t: Date.now(), lastClosed: w.clock.lastClosed, tps: s?.ticksPerSec ?? 0, held: w.held, conns: srv.connections().filter((c) => c.world === created.id).map((c) => ({ who: c.who, tickLag: c.tickLag, buffered: c.buffered, rttMs: c.rttMs })) });
  }, 500);

  const windows: { name: string; t0: number; t1: number; shape: Shape; blackout?: number }[] = [];
  for (const ph of PHASES) {
    shape = ph.shape;
    const t0 = Date.now();
    if (ph.blackout) holdUntil = performance.now() + ph.blackout * 1000;
    for (const l of lines) l.rearm();
    console.log(`phase ${ph.name} ${JSON.stringify(ph.shape)}${ph.blackout ? ` blackout ${ph.blackout}s` : ""}`);
    await sleep(ph.secs * 1000);
    windows.push({ name: ph.name, t0, t1: Date.now(), shape: ph.shape, blackout: ph.blackout });
    if (process.env.SHOTS) await pages[1].screenshot({ path: `${process.env.SHOTS}-${ph.name}.png` }).catch(() => {});
  }
  stop = true;
  await Promise.all(walkers);
  clearInterval(sampler);
  const recs = (await Promise.all(pages.map((p) => p.evaluate(() => (window as any).__rec as unknown[]).catch(() => [])))) as Rec[][];
  const ids = recs.map((r) => r.findLast((x) => x.me)?.me?.id ?? 0);

  // Ticks/s from the server's own lastClosed, per phase (the authoritative clock).
  const summary = windows.map((wd) => {
    const ss = srvSamples.filter((s) => s.t >= wd.t0 && s.t <= wd.t1);
    const tps = ss.length > 1 ? ((ss[ss.length - 1].lastClosed - ss[0].lastClosed) * 1000) / (ss[ss.length - 1].t - ss[0].t) : NaN;
    // Each client's lag behind the server's clock, from its own sim tick at the matching moment.
    const lagOf = (r: Rec[]) => r.filter((x) => x.t >= wd.t0 && x.t <= wd.t1 && x.tick > 0).map((x) => {
      const s = ss.reduce<SrvSample | null>((b, c) => (!b || Math.abs(c.t - x.t) < Math.abs(b.t - x.t) ? c : b), null);
      return s ? s.lastClosed + ((x.t - s.t) * 60) / 1000 - x.tick : NaN;
    }).filter((n) => !Number.isNaN(n));
    const stateCounts = (r: Rec[]) => {
      const c: Record<string, number> = {};
      for (const x of r) if (x.t >= wd.t0 && x.t <= wd.t1) c[x.st] = (c[x.st] ?? 0) + 1;
      return c;
    };
    const inW = (r: Rec[]) => r.filter((x) => x.t >= wd.t0 && x.t <= wd.t1);
    const ev: Record<string, number> = {};
    for (const e of events) if (e.t >= wd.t0 && e.t <= wd.t1) {
      const k = e.ev === "leave" ? `leave:${e.f.reason ?? e.f.code}` : e.ev;
      ev[k] = (ev[k] ?? 0) + 1;
    }
    const lagA = lagOf(recs[0]);
    const lagB = lagOf(recs[1]);
    return {
      phase: wd.name,
      shape: wd.shape,
      blackout: wd.blackout,
      serverTicksPerSec: r1(tps),
      held: ss.some((s) => s.held),
      A: { lagP50: r1(pct(lagA, 0.5)), lagMax: r1(Math.max(...lagA)), sps: r1(pct(inW(recs[0]).map((x) => x.sps), 0.5)), spsMin: r1(Math.min(...inW(recs[0]).map((x) => x.sps))), pingP50: pct(inW(recs[0]).map((x) => x.ping), 0.5), states: stateCounts(recs[0]), seesBoLateMs: perceivedDelay(recs[1], recs[0], ids[1], wd.t0, wd.t1) },
      B: { lagP50: r1(pct(lagB, 0.5)), lagMax: r1(Math.max(...lagB)), sps: r1(pct(inW(recs[1]).map((x) => x.sps), 0.5)), pingP50: pct(inW(recs[1]).map((x) => x.ping), 0.5), pingMax: Math.max(...inW(recs[1]).map((x) => x.ping)), bufMax: Math.max(...inW(recs[1]).map((x) => x.buf)), states: stateCounts(recs[1]), resyncs: (inW(recs[1]).at(-1)?.rs ?? 0) - (inW(recs[1])[0]?.rs ?? 0), seesAnaLateMs: perceivedDelay(recs[0], recs[1], ids[0], wd.t0, wd.t1), notice: [...new Set(inW(recs[1]).map((x) => x.notice))].filter(Boolean) },
      serverEvents: ev,
    };
  });
  for (const s of summary) console.log(JSON.stringify(s));
  console.log(`proxy paused reads (server backpressure): ${pausedReads}; errors: ${errors.length}`);
  const out = process.env.OUT ?? `${outDir}/summary.json`;
  writeFileSync(out, JSON.stringify({ room: created, summary, errors, events: events.map((e) => ({ t: e.t, ev: e.ev, f: e.f })), pausedReads }, null, 1));
  writeFileSync(out.replace(/\.json$/, "-recs.json"), JSON.stringify({ windows, recs, srvSamples }));
  console.log(`wrote ${out}`);
  await browser.close();
  await srv.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
