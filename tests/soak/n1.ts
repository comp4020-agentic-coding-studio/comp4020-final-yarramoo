// Gate G2, test N1 (plan 12.2): three real Chromium clients, one real server, delay and jitter on every socket, one
// client CPU-throttled 4x, bots playing for DURATION_S seconds (M5 combat: see bot()). A script, not a test: run it with `pnpm soak:n1` after
// `pnpm build:client`. Env: SEED (default 20261014), DURATION_S (default 600), OUT (write the JSON summary there).
//
// Each client loads the page THROUGH its own proxy (same origin, so registration and the WebSocket are the real
// same-origin paths). The proxy forwards HTTP untouched and delays every WebSocket frame, in order, per direction.
// (`?server=host:port` is not used: registration is a cross-origin fetch and the server sends no CORS headers.)
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { decodeClient } from "../../shared/protocol.ts";
import { startServer } from "../../server/main.ts";

const SEED = Number(process.env.SEED ?? 20261014) >>> 0;
const DURATION_S = Number(process.env.DURATION_S ?? 600);
const CLIENTS = 3;
const THROTTLED = 2;
const MIN_MS = 20;
const MAX_MS = 150;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the delay proxy -------------------------------------------------------------------------------------------

/** Delivers items in order, each no earlier than its own due time (a TCP stream cannot reorder). */
class DelayLine {
  private q: { due: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private base: number;
  private target: number;
  private baseAt = 0;
  private nextRetarget = 0;
  maxDelay = 0;
  sumDelay = 0;
  frames = 0;
  private rng: () => number;
  constructor(rng: () => number) {
    this.rng = rng;
    this.base = this.target = MIN_MS + rng() * (MAX_MS - MIN_MS);
  }
  /** A slowly wandering base latency across the whole 20..150 ms range, plus a few ms of per-frame jitter. */
  private delay(now: number): number {
    if (now >= this.nextRetarget) {
      this.base = this.target;
      this.baseAt = now;
      this.target = MIN_MS + this.rng() * (MAX_MS - MIN_MS);
      this.nextRetarget = now + 500 + this.rng() * 2500;
    }
    const f = Math.min(1, (now - this.baseAt) / 400);
    const b = this.base + (this.target - this.base) * f;
    return Math.min(MAX_MS, Math.max(MIN_MS, b + (this.rng() - 0.5) * 20));
  }
  push(fn: () => void): void {
    const now = performance.now();
    const d = this.delay(now);
    const due = Math.max(this.last, now + d);
    this.last = due;
    this.frames++;
    this.sumDelay += due - now;
    this.maxDelay = Math.max(this.maxDelay, due - now);
    this.q.push({ due, fn });
    this.arm();
  }
  private arm(): void {
    if (this.timer || !this.q.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.q.length && this.q[0].due <= now + 0.5) this.q.shift()!.fn();
      this.arm();
    }, Math.max(0, this.q[0].due - performance.now()));
  }
}

interface ProxyStats {
  connections: number;
  upFrames: number;
  downFrames: number;
  upBytes: number;
  downBytes: number;
  meanDelayMs: number;
  maxDelayMs: number;
  /** tick -> hash (hex) that this client sent; read from the wire, independent of the server's own bookkeeping. */
  hashes: Map<number, bigint>;
  hashSends: number;
}

function startProxy(upstreamPort: number, seed: number): Promise<{ port: number; server: Server; stats: ProxyStats; close(): void }> {
  const stats: ProxyStats = { connections: 0, upFrames: 0, downFrames: 0, upBytes: 0, downBytes: 0, meanDelayMs: 0, maxDelayMs: 0, hashes: new Map(), hashSends: 0 };
  const lines: DelayLine[] = [];
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
  const sockets = new Set<WebSocket>();
  const server = createServer((req, res) => {
    const up = httpRequest({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (process.env.DEBUG_N1) console.log(`proxy: upgrade ${req.url}`);
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`, { headers: { "user-agent": String(req.headers["user-agent"] ?? "") }, maxPayload: 16 << 20 });
    upstream.on("error", (e) => { if (process.env.DEBUG_N1) console.log("proxy: upstream error", e.message); socket.destroy(); });
    upstream.on("open", () => {
      wss.handleUpgrade(req, socket, head, (client) => {
        const n = stats.connections++;
        sockets.add(client).add(upstream);
        const upLine = new DelayLine(mulberry32(seed + n * 7 + 1));
        const downLine = new DelayLine(mulberry32(seed + n * 7 + 2));
        lines.push(upLine, downLine);
        if (process.env.DEBUG_N1) console.log(`proxy: conn ${n} open`);
        const closeBoth = (from: WebSocket, to: WebSocket, line: DelayLine, code: number) => {
          line.push(() => {
            if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) to.close(code >= 3000 || code === 1000 ? code : 1000);
          });
          void from;
        };
        client.on("message", (data: RawData, isBinary) => {
          const buf = data as Buffer;
          stats.upFrames++;
          stats.upBytes += buf.length;
          const m = decodeClient(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
          if (m?.t === "hash") {
            stats.hashSends++;
            stats.hashes.set(m.tick, m.hash);
          }
          upLine.push(() => upstream.readyState === WebSocket.OPEN && upstream.send(buf, { binary: isBinary }));
        });
        upstream.on("message", (data: RawData, isBinary) => {
          const buf = data as Buffer;
          stats.downFrames++;
          stats.downBytes += buf.length;
          downLine.push(() => client.readyState === WebSocket.OPEN && client.send(buf, { binary: isBinary }));
        });
        client.on("close", (code) => { if (process.env.DEBUG_N1) console.log(`proxy: client ${n} closed ${code}`); closeBoth(client, upstream, upLine, code); });
        upstream.on("close", (code, reason) => { if (process.env.DEBUG_N1) console.log(`proxy: upstream ${n} closed ${code} ${reason}`); closeBoth(upstream, client, downLine, code); });
        client.on("error", () => client.terminate());
      });
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      ok({
        port,
        server,
        stats,
        close() {
          for (const s of sockets) s.terminate();
          server.close();
          server.closeAllConnections();
          const f = lines.reduce((a, l) => a + l.frames, 0);
          stats.meanDelayMs = f ? lines.reduce((a, l) => a + l.sumDelay, 0) / f : 0;
          stats.maxDelayMs = Math.max(0, ...lines.map((l) => l.maxDelay));
        },
      });
    }),
  );
}

/**
 * CDP CPU throttling applies to the page's main thread only: Chromium refuses it on a worker ("only supported for
 * pages"), and the sim steps in a worker. Measured: a 3e7-iteration loop took 75 ms in the worker before and after
 * throttling, 300 ms on the main thread. So the throttled client's worker script is also served with a prefix that
 * wraps the wasm `step` export to take 4x as long (it spins for 3x the measured step time). That models a 4x slower
 * core for the sim itself; it does not slow decoding, hashing, snapshots or anything else in the worker.
 */
const instrumentPrefix = (slow: boolean) => `(() => {
  // Read-only counters on the sim's own events() output, per kind, once per sim step. Nothing here feeds the sim.
  globalThis.__ev = { steps: 0, counts: {}, lastStep: -1 };
  const RealInstance = WebAssembly.Instance;
  WebAssembly.Instance = function (m, i) {
    const inst = new RealInstance(m, i);
    const ex = Object.assign({}, inst.exports);
    const step = inst.exports.step;
    const events = inst.exports.events;
    ex.step = () => { const t = performance.now(); const r = step(); ${slow ? "const d = performance.now() - t; const end = performance.now() + 3 * d; while (performance.now() < end) {}" : ""} globalThis.__ev.steps++; return r; };
    ex.events = (p, max) => {
      const n = events(p, max);
      if (globalThis.__ev.lastStep !== globalThis.__ev.steps && inst.exports.width() > 512) {
        globalThis.__ev.lastStep = globalThis.__ev.steps;
        const u8 = new Uint8Array(inst.exports.memory.buffer);
        for (let k = 0; k < n; k++) { const kind = u8[p + k * 17]; globalThis.__ev.counts[kind] = (globalThis.__ev.counts[kind] || 0) + 1; }
      }
      return n;
    };
    return { exports: ex };
  };
})();
`;

// ---- bots ----------------------------------------------------------------------------------------------------------

interface BotStats { moves: number; casts: number; bySpell: number[]; maxY: number; deepSamples: number; samples: number }

/** Dispatch key events on window after blurring the join field (a focused <input> swallows them). */
const keyOps = (page: Page, ops: [string, string][]) =>
  page.evaluate((o) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const [type, key] of o) window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  }, ops);

interface BotView { me: { x: number; y: number; dead: boolean } | null; others: { x: number; y: number; dead: boolean }[]; charges: number[]; cooldown: number[]; view: { x: number; y: number; vw: number; vh: number } | null; box: { x: number; y: number; w: number; h: number } }

/** Read-only look at the page's own debug globals, as a player would see the HUD. */
const readView = (page: Page): Promise<BotView | null> =>
  page.evaluate(() => {
    const w = window as any;
    const list: any[] = w.__players ?? [];
    const me = list.find((p) => p.me);
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    return {
      me: me ? { x: me.x, y: me.y, dead: !!me.dead } : null,
      others: list.filter((p) => !p.me).map((p) => ({ x: p.x, y: p.y, dead: !!p.dead })),
      charges: w.__spells?.charges ?? [],
      cooldown: w.__spells?.cooldown ?? [],
      view: w.__view ? { x: w.__view.x, y: w.__view.y, vw: w.__view.vw, vh: w.__view.vh } : null,
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  }).catch(() => null);

const SURFACE_Y = 270;
const DEEP_Y = 800;
const WORLD_W = 2048;

/**
 * A bot plays through the real client controls: A/D/space key events for walking and levitating, digit keys to pick a
 * spell, pointer down/move/up on the canvas to cast with aim. It sweeps the surface looking for a cave shaft and, once
 * below the surface, wanders (biased downwards: space is held less) and casts whatever it has charges for at the
 * nearest other player, or at random. What it reaches is measured from the pages' own sim events, not assumed.
 */
async function bot(page: Page, rng: () => number, stopAt: number, st: BotStats): Promise<void> {
  const held = new Set<string>();
  let nextMove = 0;
  let nextCast = performance.now() + 2000 + rng() * 2000;
  let nextRead = 0;
  let spellKey = "1";
  let bv: BotView | null = null;
  let targetX = rng() * WORLD_W;
  while (performance.now() < stopAt) {
    const now = performance.now();
    if (now >= nextRead) {
      bv = await readView(page);
      nextRead = now + 400;
      if (bv?.me) {
        st.samples++;
        st.maxY = Math.max(st.maxY, bv.me.y);
        if (bv.me.y >= DEEP_Y) st.deepSamples++;
      }
    }
    if (now >= nextMove) {
      const want = new Set<string>();
      const y = bv?.me?.y ?? 0;
      const x = bv?.me?.x ?? 0;
      const underground = y > SURFACE_Y + 25;
      if (!underground) {
        // Surface: sweep toward a target x, re-picked on arrival (and now and then at random), hoping to fall into a shaft.
        if (Math.abs(x - targetX) < 20 || rng() < 0.1) targetX = rng() * WORLD_W;
        want.add(x < targetX ? "d" : "a");
        if (rng() < 0.12) want.add(" ");
      } else {
        const d = rng();
        if (d < 0.4) want.add("a");
        else if (d < 0.8) want.add("d");
        if (rng() < 0.2) want.add(" "); // levitate rarely: gravity does the descending
      }
      const ops: [string, string][] = [];
      for (const k of held) if (!want.has(k)) ops.push(["keyup", k]);
      for (const k of want) if (!held.has(k)) ops.push(["keydown", k]);
      held.clear();
      for (const k of want) held.add(k);
      if (ops.length) await keyOps(page, ops).catch(() => {});
      st.moves++;
      nextMove = now + 300 + rng() * 1200;
    }
    if (now >= nextCast && bv?.me && !bv.me.dead) {
      // Pick among spells with charges (65535 is infinite) and no cooldown left; usually Push or Blast on the surface.
      const ready: number[] = [];
      for (let k = 0; k < 6; k++) if ((bv.charges[k] ?? 0) > 0 && (bv.cooldown[k] ?? 0) === 0) ready.push(k);
      const pool = ready.length ? ready : [0, 1];
      const idx = pool[Math.floor(rng() * pool.length)];
      const k = String(idx + 1);
      if (k !== spellKey) {
        await keyOps(page, [["keydown", k], ["keyup", k]]).catch(() => {});
        spellKey = k;
      }
      const box = bv.box;
      const rand = () => [box.x + 4 + rng() * (box.w - 8), box.y + 4 + rng() * (box.h - 8)] as const;
      let [x, y] = rand();
      const near = bv.others.filter((o) => !o.dead).sort((a, b) => Math.hypot(a.x - bv!.me!.x, a.y - bv!.me!.y) - Math.hypot(b.x - bv!.me!.x, b.y - bv!.me!.y))[0];
      if (near && bv.view && rng() < 0.6 && Math.hypot(near.x - bv.me.x, near.y - bv.me.y) < 150) {
        const sx = box.x + ((near.x - bv.view.x) / bv.view.vw) * box.w;
        const sy = box.y + ((near.y - 5 - bv.view.y) / bv.view.vh) * box.h;
        if (sx > box.x && sx < box.x + box.w && sy > box.y && sy < box.y + box.h) [x, y] = [sx, sy];
      }
      await page.mouse.move(x, y).catch(() => {});
      await page.mouse.down().catch(() => {});
      await sleep(80 + rng() * 500);
      if (rng() < 0.4) {
        const [x2, y2] = rand();
        await page.mouse.move(x2, y2, { steps: 3 }).catch(() => {});
        await sleep(50 + rng() * 200);
      }
      await page.mouse.up().catch(() => {});
      st.casts++;
      st.bySpell[idx]++;
      nextCast = performance.now() + 400 + rng() * 2600;
    }
    await sleep(40);
  }
  await keyOps(page, [...held].map((k) => ["keyup", k] as [string, string])).catch(() => {});
}

// ---- the run -------------------------------------------------------------------------------------------------------

interface Sample { tSec: number; client: number; state: string; tick: number; lag: number; buffered: number; resyncs: number; stepP95: number }

async function main(): Promise<void> {
  console.log(`N1 seed=${SEED} duration=${DURATION_S}s clients=${CLIENTS} throttled=#${THROTTLED} delay=${MIN_MS}-${MAX_MS}ms`);
  const dataDir = mkdtempSync(join(tmpdir(), "sand-n1-"));
  const srv = await startServer({ port: 0, dataDir });
  const proxies = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => startProxy(srv.port, SEED + i * 1000)));
  let browser: Browser | null = null;
  const ctxs: BrowserContext[] = [];
  const pages: Page[] = [];
  const workers: (import("playwright").Worker | null)[] = Array.from({ length: CLIENTS }, () => null);
  const errors: string[] = [];
  const t0 = performance.now();
  const samples: Sample[] = [];
  const botStats: BotStats[] = Array.from({ length: CLIENTS }, () => ({ moves: 0, casts: 0, bySpell: [0, 0, 0, 0, 0, 0], maxY: 0, deepSamples: 0, samples: 0 }));
  let throttleNote = "";
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks"] });
    for (let i = 0; i < CLIENTS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
      ctxs.push(ctx);
      const page = await ctx.newPage();
      pages.push(page);
      await page.route("**/assets/worker-*.js", async (route) => {
        const r = await route.fetch();
        await route.fulfill({ status: 200, contentType: "text/javascript", body: instrumentPrefix(i === THROTTLED) + (await r.text()) });
      });
      page.on("websocket", (w) => { w.on("close", () => errors.push(`client ${i} ws closed`)); w.on("socketerror", (e) => errors.push(`client ${i} ws error ${e}`)); errors.push(`client ${i} ws opened ${w.url()}`); });
      page.on("requestfailed", (r) => errors.push(`client ${i} requestfailed ${r.url()} ${r.failure()?.errorText}`));
      page.on("pageerror", (e) => errors.push(`client ${i} pageerror: ${e.message}`));
      page.on("worker", (w) => workers[i] = w);
      page.on("worker", (w) => w.on("console", (m) => { errors.push(`client ${i} worker ${m.type()}: ${m.text()}`); }));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`client ${i} console.error: ${m.text()}`);
      });
      await page.goto(`http://127.0.0.1:${proxies[i].port}/`);
      await page.fill("#name", `bot${i}`);
      await page.locator("#joinForm button").click();
    }
    // Throttle the third client's page. (Whether this reaches its worker is measured below, not assumed.)
    const cdp = await ctxs[THROTTLED].newCDPSession(pages[THROTTLED]);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    throttleNote = "Emulation.setCPUThrottlingRate{rate:4} on the page (main thread only), plus the worker's wasm step() wrapped to take 4x as long (CDP cannot throttle workers)";
    for (let i = 0; i < CLIENTS; i++) {
      await pages[i].waitForFunction(() => (window as any).__net?.state === "live" && ((window as any).__stats?.tick ?? 0) > 0, null, { timeout: 90_000 }).catch(async (e) => {
        console.error(`client ${i} never went live:`, errors, await pages[i].evaluate(() => JSON.stringify((window as any).__net)).catch(() => "?"));
        throw e;
      });
    }
    console.log(`all ${CLIENTS} clients live after ${((performance.now() - t0) / 1000).toFixed(1)} s`);

    const startAt = performance.now();
    const stopAt = startAt + DURATION_S * 1000;
    const bots = pages.map((p, i) => bot(p, mulberry32(SEED + 17 * (i + 1)), stopAt, botStats[i]));
    // Sample every 5 s.
    let lastLog = 0;
    while (performance.now() < stopAt) {
      await sleep(5000);
      const lastClosed = srv.game.clock.lastClosed;
      for (let i = 0; i < CLIENTS; i++) {
        const v = await Promise.race([
          pages[i].evaluate(() => ({ net: (window as any).__net, stats: (window as any).__stats })),
          sleep(20_000).then(() => null),
        ]).catch(() => null);
        if (!v || !v.net) {
          samples.push({ tSec: (performance.now() - startAt) / 1000, client: i, state: "unreadable", tick: 0, lag: -1, buffered: 0, resyncs: -1, stepP95: 0 });
          continue;
        }
        samples.push({
          tSec: (performance.now() - startAt) / 1000,
          client: i,
          state: v.net.state,
          tick: v.stats?.tick ?? 0,
          lag: lastClosed - (v.stats?.tick ?? 0),
          buffered: v.stats?.buffered ?? 0,
          resyncs: v.net.resyncs,
          stepP95: v.stats?.stepP95 ?? 0,
        });
      }
      if (performance.now() - lastLog > 30_000) {
        lastLog = performance.now();
        const s = samples.slice(-CLIENTS).map((x) => `${x.state}/lag ${x.lag}/rs ${x.resyncs}`).join("  ");
        console.log(`[${((performance.now() - startAt) / 1000).toFixed(0)}s] tick ${lastClosed} incidents ${srv.game.stats.incidents} | ${s}`);
      }
    }
    await Promise.all(bots);
    await sleep(4000); // let the last checkpoints resolve (the server waits up to 2 s for a slow client)

    // ---- collect
    const finals: any[] = [];
    for (let i = 0; i < CLIENTS; i++) {
      const v = await pages[i].evaluate(() => ({ net: (window as any).__net, stats: (window as any).__stats, players: (window as any).__players })).catch(() => null);
      finals.push(v);
    }
    const EVN: Record<number, string> = { 2: "pickup", 8: "explode", 9: "death", 10: "bagPickup", 3: "cast", 7: "respawn" };
    const evCounts = await Promise.all(workers.map(async (w) => {
      const r = await w?.evaluate(() => (globalThis as any).__ev).catch(() => null);
      const out: Record<string, number> = { pickup: 0, explode: 0, death: 0, bagPickup: 0, cast: 0, respawn: 0 };
      for (const [k, n] of Object.entries(r?.counts ?? {})) if (EVN[+k]) out[EVN[+k]] = n as number;
      return { ...out, stepsObserved: r?.steps ?? null };
    }));
    const combat = { perClientEventsSeenLive: evCounts, note: "counted in each page's worker from the sim's events() output (live ticks only, not replay), so a client that fast-forwarded sees fewer; the maximum per kind is the best estimate of what happened" , maxPerKind: Object.fromEntries(["pickup", "explode", "death", "bagPickup", "cast", "respawn"].map((k) => [k, Math.max(...evCounts.map((e) => (e as any)[k]))])) };
    const lastClosed = srv.game.clock.lastClosed;
    const incidents = srv.db!.incidents(1);
    const gw = srv.game as unknown as { truth: Map<number, bigint> };
    const truthTicks = [...gw.truth.keys()].sort((a, b) => a - b);
    // Wire evidence: for every checkpoint tick, every client's HASH as it left the page.
    const allTicks = new Set<number>();
    for (const p of proxies) for (const t of p.stats.hashes.keys()) allTicks.add(t);
    let allAgree = 0;
    let wireMismatchTicks: number[] = [];
    let fullyReported = 0;
    for (const t of [...allTicks].sort((a, b) => a - b)) {
      const hs = proxies.map((p) => p.stats.hashes.get(t)).filter((h): h is bigint => h !== undefined);
      if (hs.length === CLIENTS) fullyReported++;
      if (new Set(hs).size === 1) allAgree++;
      else wireMismatchTicks.push(t);
    }
    const sharedTicks = [...allTicks].filter((t) => proxies.every((p) => p.stats.hashes.has(t))).sort((a, b) => a - b);
    const finalShared = sharedTicks.length ? sharedTicks[sharedTicks.length - 1] : null;
    const finalHashes = finalShared === null ? null : proxies.map((p) => p.stats.hashes.get(finalShared)!.toString(16).padStart(16, "0"));
    const rss = process.memoryUsage().rss;

    const perClient = finals.map((f, i) => ({
      client: i,
      throttled: i === THROTTLED,
      finalState: f?.net?.state ?? "unreadable",
      tick: f?.stats?.tick ?? 0,
      ticksBehindServer: f?.stats ? lastClosed - f.stats.tick : null,
      resyncs: f?.net?.resyncs ?? null,
      reconnects: proxies[i].stats.connections - 1,
      playerSeen: !!f?.players?.some?.((p: any) => p.me),
      stepP95Ms: f?.stats?.stepP95 ?? null,
      hashesSent: proxies[i].stats.hashSends,
      bot: botStats[i],
      botReachedDeepBand: botStats[i].maxY >= DEEP_Y,
    }));
    const lagByClient = Array.from({ length: CLIENTS }, (_, i) => {
      const s = samples.filter((x) => x.client === i && x.lag >= 0);
      return { client: i, samples: s.length, maxLag: Math.max(0, ...s.map((x) => x.lag)), meanLag: s.length ? s.reduce((a, x) => a + x.lag, 0) / s.length : 0, nonLiveSamples: samples.filter((x) => x.client === i && x.state !== "live").length, maxStepP95: Math.max(0, ...samples.filter((x) => x.client === i).map((x) => x.stepP95)) };
    });

    const criteria = {
      zeroIncidents: srv.game.stats.incidents === 0 && incidents.length === 0 && srv.world.stats.incidents === 0,
      zeroWireMismatches: wireMismatchTicks.length === 0,
      allClientsLiveAtEnd: perClient.every((c) => c.finalState === "live" && c.ticksBehindServer !== null && c.ticksBehindServer < 120),
      throttledEndedLive: perClient[THROTTLED].finalState === "live" && (perClient[THROTTLED].ticksBehindServer ?? 1e9) < 120,
      sameHashAtFinalSharedCheckpoint: finalHashes !== null && new Set(finalHashes).size === 1,
    };
    const pass = Object.values(criteria).every(Boolean);
    const summary = {
      pass,
      criteria,
      seed: SEED,
      durationSec: DURATION_S,
      actualRunSec: Math.round((performance.now() - startAt) / 1000),
      serverTicks: lastClosed,
      hashChecks: { serverCheckpointsResolved: truthTicks.length, clientHashesSent: proxies.map((p) => p.stats.hashSends), ticksWithAllThreeReported: fullyReported, ticksAllAgree: allAgree, wireMismatchTicks },
      serverStats: { game: srv.game.stats, sandbox: srv.world.stats, server: srv.stats },
      incidents: incidents.map((x) => ({ tick: x.tick, chunks: (x.details as any).chunks, divergent: (x.details as any).divergent, hashes: (x.details as any).hashes, userAgents: (x.details as any).userAgents })),
      finalSharedCheckpoint: { tick: finalShared, hashes: finalHashes },
      combat,
      clients: perClient,
      lagByClient,
      network: proxies.map((p, i) => ({ client: i, connections: p.stats.connections, upFrames: p.stats.upFrames, downFrames: p.stats.downFrames, downMB: +(p.stats.downBytes / 1048576).toFixed(2) })),
      throttle: throttleNote,
      pageErrors: errors.slice(0, 20),
      harnessProcessRssMB: Math.round(rss / 1048576),
      note: "harnessProcessRssMB is the Node process that hosts the server AND the proxies and the driver; Chromium runs separately.",
    };
    const json = JSON.stringify(summary, null, 2);
    console.log(json);
    if (process.env.OUT) writeFileSync(process.env.OUT, json + "\n");
    process.exitCode = pass ? 0 : 1;
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    await browser?.close().catch(() => {});
    for (const p of proxies) p.close();
    await srv.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error("N1 harness error:", e);
    process.exit(2);
  },
);
