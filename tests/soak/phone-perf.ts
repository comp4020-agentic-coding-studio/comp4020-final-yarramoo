// Track C (8 Nov): phone frame-time bench. A script, not a vitest test: `node tests/soak/phone-perf.ts` after
// `pnpm build:client`. Starts a real server, opens Chromium as a phone (DPR 3 unless DPR is set, touch, coarse pointer) at 390x844 and
// 844x390, and measures for MEASURE_S seconds each: (a) the menu backdrop at `/`, (b) an M Survival room after the
// descent (one player, readied with R).
//
// Throttling: CDP `Emulation.setCPUThrottlingRate{rate:4}` on the page (main thread only). It does not reach workers
// (n1.ts found the same), and the game draws in its worker, so the worker's rAF callback is also stretched to take 4x
// as long (a busy-wait of 3x its own duration). GPU work is SwiftShader (software GL) in headless Chromium; it shows up
// in the worker's frame interval, not in the callback time.
//
// Reported per scene: the worker's frame interval p50/p95 (what the player sees), its callback cost p50/p95 (step +
// draw submission, unstretched), the page's own rAF interval p50/p95, and the canvas's backing size.
// Throttling starts when a scene's measurement starts (after joining and the descent) and stops after it.
// Env: PORT (default 8082), MEASURE_S (default 15), OUT (JSON path), SHOTS (png prefix), ONLY (menu|game).
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { startServer } from "../../server/main.ts";
import { encodeConfig, SURVIVAL } from "../../shared/room.ts";

const PORT = Number(process.env.PORT ?? 8082);
const MEASURE_S = Number(process.env.MEASURE_S ?? 15);
const OUT = process.env.OUT ?? "/tmp/phoneperf-bench.json";
const SHOTS = process.env.SHOTS ?? "";
const ONLY = process.env.ONLY ?? "";
const DATA = process.env.DATA_DIR_BENCH ?? "/tmp/phoneperf-bench-data";
const DPR = Number(process.env.DPR ?? 3);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Prepended to the worker bundle: records rAF intervals and callback cost, and stretches the callback 4x. */
const workerPrefix = `(() => {
  const raf = self.requestAnimationFrame?.bind(self);
  if (!raf) return;
  const S = (globalThis.__pp = { iv: [], cost: [], last: 0, on: false });
  self.requestAnimationFrame = (cb) => raf((t) => {
    const t0 = performance.now();
    if (S.on && S.last) { S.iv.push(t0 - S.last); }
    S.last = t0;
    cb(t);
    const d = performance.now() - t0;
    if (S.on) S.cost.push(d);
    if (S.on) { const end = performance.now() + 3 * d; while (performance.now() < end) {} }
  });
})();
`;

const pageProbe = () => {
  const w = window as unknown as { __ppPage: { iv: number[]; last: number; on: boolean } };
  w.__ppPage = { iv: [], last: 0, on: false };
  const tick = (t: number) => {
    const s = w.__ppPage;
    if (s.on && s.last) s.iv.push(t - s.last);
    s.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const q = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
};

interface Row { scene: string; viewport: string; frames: number; frameP50: number; frameP95: number; costP50: number; costP95: number; pageP50: number; pageP95: number; canvas: string; note?: string }

async function measure(page: Page, scene: string, viewport: string): Promise<Row> {
  // Throttle only the measured window: joining and replaying an M world at 4x takes minutes and is not what this measures.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await sleep(1500);
  const worker = page.workers().at(-1);
  if (!worker) throw new Error(`${scene} ${viewport}: no worker`);
  await worker.evaluate(() => { const S = (globalThis as any).__pp; S.iv = []; S.cost = []; S.last = 0; S.on = true; });
  await page.evaluate(() => { const s = (window as any).__ppPage; s.iv = []; s.last = 0; s.on = true; });
  await sleep(MEASURE_S * 1000);
  const w = await worker.evaluate(() => { const S = (globalThis as any).__pp; S.on = false; return { iv: S.iv as number[], cost: S.cost as number[] }; });
  const p = await page.evaluate(() => { const s = (window as any).__ppPage; s.on = false; return s.iv as number[]; });
  const canvas = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.getBoundingClientRect().width > 100) as HTMLCanvasElement | undefined;
    if (!c) return "none";
    const r = c.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)} css`;
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}-${scene}-${viewport}.png` });
  return { scene, viewport, frames: w.iv.length, frameP50: q(w.iv, 0.5), frameP95: q(w.iv, 0.95), costP50: q(w.cost, 0.5), costP95: q(w.cost, 0.95), pageP50: q(p, 0.5), pageP95: q(p, 0.95), canvas };
}

async function phonePage(browser: Browser, width: number, height: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`pageerror ${e.message}`));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`worker ${m.type()}: ${m.text()}`); }));
  // Instrument the worker without page.route: a routed worker script loses its WebSocket in this setup (seen 8 Nov),
  // so the page's Worker constructor is wrapped instead: a blob runs the probe, then imports the real worker script.
  await page.addInitScript((prefix: string) => {
    const W = window.Worker;
    (window as unknown as { Worker: unknown }).Worker = function (url: string | URL, opts?: WorkerOptions) {
      const abs = new URL(String(url), location.href).href;
      // Messages posted before the import sets onmessage would be dropped (the menu posts init at once): queue, then replay.
      const src = `${prefix}\nconst __q = []; const __h = (e) => __q.push(e); self.addEventListener("message", __h);\nimport(${JSON.stringify(abs)}).then(() => { self.removeEventListener("message", __h); for (const e of __q) self.onmessage?.(e); });`;
      return new W(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { ...(opts ?? {}), type: "module" });
    };
  }, workerPrefix);
  await page.addInitScript(pageProbe);
  return page;
}

async function main(): Promise<void> {
  mkdirSync(DATA, { recursive: true });
  const srv = await startServer({ port: PORT, dataDir: DATA, quiet: process.env.QUIET !== "0", env: {} });
  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({ headless: true });
  const rows: Row[] = [];
  try {
    for (const [w, h] of [[390, 844], [844, 390]] as const) {
      const vp = `${w}x${h}`;
      if (ONLY !== "game") {
        const page = await phonePage(browser, w, h);
        const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
        await page.goto(`${base}/`);
        await page.waitForFunction(() => !!(window as any).__menuStats, null, { timeout: 60_000 });
        await sleep(4000); // first vignette forms
        const r = await measure(page, "menu", vp);
        r.note = `coarse=${coarse}`;
        rows.push(r);
        console.log(JSON.stringify(r));
        // The same backdrop behind a settings panel (#new/survival).
        await page.evaluate(() => { location.hash = "#new/survival"; });
        await sleep(2000);
        const s = await measure(page, "menu-settings", vp);
        rows.push(s);
        console.log(JSON.stringify(s));
        await page.context().close();
      }
      if (ONLY !== "menu") {
        const cfg = { ...SURVIVAL, size: 1 };
        const body = { name: `Bench ${vp}`, mode: "survival", config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "public" };
        const created = (await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify(body) })).json()) as { code: string };
        const page = await phonePage(browser, w, h);
        await page.goto(`${base}/r/${created.code}`);
        await page.waitForSelector("#name", { state: "visible", timeout: 30_000 });
        await page.fill("#name", "Phone");
        await page.click("#joinForm button");
        page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[game ${vp}] ${m.type()}: ${m.text()}`); });
        await page.waitForFunction(() => !!(window as any).__players?.some((p: any) => p.me), null, { timeout: 90_000 }).catch(async (e) => {
          console.log(await page.evaluate(() => JSON.stringify({ net: (window as any).__net, txt: document.body.innerText.slice(0, 200) })));
          await page.screenshot({ path: `/tmp/phoneperf-shots/fail-game-${vp}.png` });
          throw e;
        });
        await sleep(1500);
        await page.keyboard.press("r");
        await page.waitForFunction(() => !document.body.innerText.includes("Ready up") && !document.body.innerText.includes("Descending"), null, { timeout: 60_000 }).catch(() => {});
        await sleep(4000);
        const r = await measure(page, "game", vp);
        r.note = await page.evaluate(() => JSON.stringify({ view: (window as any).__view && { vw: (window as any).__view.vw, vh: (window as any).__view.vh }, net: (window as any).__net?.state }));
        rows.push(r);
        console.log(JSON.stringify(r));
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  writeFileSync(OUT, JSON.stringify(rows, null, 2));
  console.log(`wrote ${OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
