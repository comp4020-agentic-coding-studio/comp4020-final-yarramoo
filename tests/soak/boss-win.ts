// Brief HB: a scripted boss win in a real two-browser Survival room. A script, not a vitest test: `pnpm soak:boss-win`
// after `pnpm build:client`. Starts a real server with dev teleport on (server/devteleport.ts), creates an S Survival
// room, opens two Chromium pages, readies both, teleports each to the boss supply pile (__devGoto) then beside the
// boss (__devGotoEnemy(4)), and casts through the real pointer path until the boss dies. Then checks the win banner,
// the achievement toast, the room list, the round.end log line and the hash counters.
// Env: PORT (default 8103), SEED (room seed, default random), HEADED=1, OUT (summary JSON), SHOTS (png prefix), MAX_S (default 300).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startServer } from "../../server/main.ts";
import { encodeConfig, SURVIVAL } from "../../shared/room.ts";

const PORT = Number(process.env.PORT ?? 8103);
const MAX_S = Number(process.env.MAX_S ?? 300);
const TELE_DIST = Number(process.env.TELE_DIST ?? 40);
const HOP_MS = Number(process.env.HOP_MS ?? 400);
const TELE_EVERY_S = Number(process.env.TELE_EVERY_S ?? 8);
const KIT = process.env.KIT ?? 'fire,bomb'; // spells used on the boss: 'fire' (Fire, then Blast) or 'fire,bomb' (a Bomb's blast reaches the caster at close range)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface View { me: { x: number; y: number; health: number; dead: boolean } | null; others: { x: number; y: number; health: number }[]; view: { x: number; y: number; vw: number; vh: number } | null; box: { x: number; y: number; w: number; h: number }; charges: number[]; cooldown: number[]; selected: number; boss: { x: number; y: number; hp: number } | null; ev: Ev[] }
interface Ev { k: number; p: number; a: number; b: number; c: number }
const EV_EXPLODE = 8, ENEMY_OWNER = 0x80000000;
const BOMB_REACH = 27; // BOMB_RADIUS * 3 / 2 (D-179)
const read = (page: Page): Promise<View | null> =>
  page.evaluate(() => {
    const w = window as any;
    const list: any[] = w.__players ?? [];
    const me = list.find((p) => p.me);
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    return {
      me: me ? { x: me.x, y: me.y, health: me.health, dead: !!me.dead } : null,
      others: list.filter((p) => !p.me).map((p) => ({ x: p.x, y: p.y, health: p.health })),
      view: w.__view ? { x: w.__view.x, y: w.__view.y, vw: w.__view.vw, vh: w.__view.vh } : null,
      box: { x: r.left, y: r.top, w: r.width, h: r.height },
      charges: w.__spells?.charges ?? [],
      cooldown: w.__spells?.cooldown ?? [],
      selected: w.__spells?.selected ?? 0,
      boss: w.__boss ? { x: w.__boss.x, y: w.__boss.y, hp: w.__boss.hp } : null,
      ev: (w.__evLog ?? []).splice(0) as Ev[],
    };
  }).catch(() => null);
const bossHp = (page: Page): Promise<{ hp: number; max: number; phase: number } | null> =>
  page.evaluate(() => {
    const b = document.getElementById("bossBar");
    const f = b?.querySelector("b") as HTMLElement | null;
    return b && !b.hidden && f ? { hp: Math.round((parseFloat(f.style.width) || 0) * 8), max: 800, phase: 0 } : null;
  }).catch(() => null);
const bodyText = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText).catch(() => "");

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "sand-boss-win-"));
  const srv = await startServer({ port: PORT, dataDir, devTeleport: true, env: {} });
  const base = `http://127.0.0.1:${PORT}`;
  const checks: Record<string, boolean> = {};
  const summary: Record<string, unknown> = { port: PORT };
  const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
  const t0 = performance.now();
  try {
    const cfg = { ...SURVIVAL, size: 0 };
    const body: Record<string, unknown> = { name: "Boss win", mode: "survival", config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "public" };
    const created = (await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify(body) })).json()) as { id: number; code: string };
    summary.room = created;
    const pages: Page[] = [];
    for (const name of ["Ana", "Bo"]) {
      const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log(`[${name}] pageerror ${e.message}`));
      await page.goto(`${base}/r/${created.code}`);
      await page.waitForSelector("#name", { state: "visible", timeout: 15000 });
      await page.fill("#name", name);
      await page.click("#joinForm button");
      pages.push(page);
    }
    // Lobby: both ready (the R key), then wait for the descent.
    for (const p of pages) await p.waitForFunction(() => !!(window as any).__players?.some((q: any) => q.me), null, { timeout: 30000 });
    await sleep(1500);
    for (const p of pages) await p.keyboard.press("r");
    await Promise.all(pages.map((p) => p.waitForFunction(() => !document.body.innerText.includes("Ready up") && !document.body.innerText.includes("Descending"), null, { timeout: 30000 }).catch(() => {})));
    await sleep(2500);
    const hasGoto = await Promise.all(pages.map((p) => p.evaluate(() => typeof (window as any).__devGoto === "function")));
    checks.hooksPresent = hasGoto.every(Boolean);
    if (!checks.hooksPresent) throw new Error("__devGoto missing in a real room");

    const dmg: Record<string, number>[] = [{}, {}];
    const tourDmg: Record<string, number>[] = [{}, {}];
    const ownIds: number[] = [0, 0];
    for (let i = 0; i < 2; i++) ownIds[i] = await pages[i].evaluate(() => ((window as any).__players ?? []).find((p: any) => p.me)?.id ?? 0);
    const lastHp: (number | null)[] = [null, null];
    const dropLog: unknown[] = [];
    let inTour = true;
    // Cause of an hp drop: an explosion whose reach covered me since the last sample (own Bomb, the boss's Bomb, another player's), else a bolt, lava or contact (told apart by the boss's distance).
    const track = (i: number, v: View | null): void => {
      const h = v?.me?.health ?? null;
      if (v?.me && h !== null && lastHp[i] !== null && h < lastHp[i]!) {
        const near = v.ev.filter((e) => e.k === EV_EXPLODE && Math.hypot(e.a - v.me!.x, e.b - (v.me!.y - 5)) < BOMB_REACH);
        let cause = "bolt/lava/contact";
        if (near.length) cause = near.some((e) => e.p === ownIds[i]) ? "own Bomb" : near.some((e) => (e.p & ENEMY_OWNER) !== 0) ? "boss/imp Bomb" : "other player's Bomb";
        else if (v.boss && Math.hypot(v.boss.x - v.me.x, v.boss.y - v.me.y) < 16) cause = "contact (boss within 16)";
        if (!inTour) dropLog.push({ i, t: Math.round(performance.now() / 100) / 10, lost: lastHp[i]! - h, me: [Math.round(v.me.x), Math.round(v.me.y)], boss: v.boss ? [Math.round(v.boss.x), Math.round(v.boss.y)] : null, ex: v.ev.filter((e) => e.k === EV_EXPLODE).length });
        const into = inTour ? tourDmg : dmg;
        into[i][cause] = (into[i][cause] ?? 0) + (lastHp[i]! - h);
      }
      if (h !== null) lastHp[i] = h;
    };
    // Supply pile: Fire (4) then Bomb (5), a few visits each; then beside the boss.
    const tourHp: (number | null)[] = [];
    await Promise.all(pages.map(async (p, i) => {
      for (const sp of [4, 4, 4, 4, 5, 5, 4, 5]) {
        await p.evaluate((s) => (window as any).__devGoto(s), sp);
        track(i, await read(p));
        await sleep(450);
      }
      tourHp[i] = (await read(p))?.me?.health ?? null;
    }));
    summary.hpAfterSupplyTour = tourHp;
    summary.chargesAfterTour = await Promise.all(pages.map(async (p) => (await read(p))?.charges));
    const t1 = performance.now();
    const fightStart = performance.now();
    const hpTrace: { t: number; ana: number | null; bo: number | null; boss: number | null }[] = [];
    const casts = [0, 0];

    const bySpell: Record<string, number> = {};
    let healsSeen = 0;
    inTour = false;
    let nextTele = 0;
    const held = [false, false];
    let hop = 0;
    const lastD = [0, 0];
    let side = 1; // +1: right of the boss (aim -x), -1: left (aim +x). Alternating on each teleport dodges aimed bolts.
    let won = false;
    while (performance.now() - fightStart < MAX_S * 1000) {
      const now = performance.now();
      const views = await Promise.all(pages.map(read));
      const boss = views[0]?.boss ?? null;
      hpTrace.push({ t: Math.round((now - fightStart) / 100) / 10, ana: views[0]?.me?.health ?? null, bo: views[1]?.me?.health ?? null, boss: boss?.hp ?? null });
      for (let i = 0; i < 2; i++) {
        const v = views[i];
        const h = v?.me?.health ?? null;
        track(i, v);
        if (h !== null && lastHp[i] !== null && h > lastHp[i]! && h - lastHp[i]! >= 20) healsSeen++;
        lastHp[i] = h;
      }
      const text = await bodyText(pages[0]);
      if (text.includes("Victory") || text.includes("The party fell")) { won = text.includes("Victory"); break; }
      if (now >= nextTele) {
        // Dodge: the boss aims at where I stood when it fired, and its bolt takes ~15 ticks at 40 cells, so a new spot every
        // HOP_MS (never within 6 cells of the last) makes it miss. Players hop to opposite sides on the first hop.
        hop++;
        for (let i = 0; i < 2; i++) {
          let d = TELE_DIST + Math.round((Math.random() * 2 - 1) * 10);
          while (Math.abs(d - lastD[i]) < 6) d = TELE_DIST + Math.round((Math.random() * 2 - 1) * 10);
          lastD[i] = d;
          const sgn = i === 0 ? 1 : -1;
          await pages[i].evaluate(([k, dd]) => (window as any).__devGotoEnemy(k, dd), [4, sgn * d]);
        }
        nextTele = now + HOP_MS;
        if (hop === 1) { await sleep(1300); continue; }
      }
      for (let i = 0; i < 2; i++) {
        const v = views[i];
        if (!v?.me || v.me.dead || !v.view) continue;
        // Prefer Bomb when it has charges and is off cooldown, else Fire, else Blast (slot keys: Blast 2, Fire 6, Bomb 7).
        const ch = v.charges, cd = v.cooldown;
        const farEnough = !v.boss || Math.hypot(v.boss.x - v.me.x, v.boss.y - v.me.y) >= 30;
        const spell = KIT.includes('bomb') && farEnough && (ch[5] ?? 0) > 0 && (cd[5] ?? 0) === 0 ? 5 : (ch[4] ?? 0) > 0 && (cd[4] ?? 0) === 0 ? 4 : 1;
        const slot = { 1: "2", 4: "6", 5: "7" }[spell as 1 | 4 | 5]!;
        await pages[i].keyboard.press(slot);
        // __devGotoEnemy(4) stands me 14 cells to the boss's right, so aim along -x: pointer 40 cells left of my chest.
        // Aim at the boss itself (its feet centre, a little up its 14-cell body), read from the page's boss HUD.
        const tx = v.boss ? v.boss.x : v.me.x - (i === 0 ? 1 : -1) * 40;
        const dist = v.boss ? Math.hypot(v.boss.x - v.me.x, v.boss.y - v.me.y) : 40;
        // Bomb arcs (gravity 20/256, speed 2.5 cells a tick): aim above by the boss's own lob formula. Fire barely drops.
        const lift = spell === 5 ? dist * dist / 620 + dist / 6 : dist * dist / 3000;
        const ty = v.boss ? v.boss.y - 6 - lift : v.me.y - 5;
        const sx = v.box.x + ((tx - v.view.x) / v.view.vw) * v.box.w;
        const sy = v.box.y + ((ty - v.view.y) / v.view.vh) * v.box.h;
        if (!held[i]) { await pages[i].mouse.down(); held[i] = true; }
        await pages[i].mouse.move(Math.max(v.box.x + 4, Math.min(sx, v.box.x + v.box.w - 4)), Math.max(v.box.y + 4, Math.min(sy, v.box.y + v.box.h - 4)));
        casts[i]++;
        const key = ["Push", "Blast", "Water", "Rose", "Fire", "Bomb"][spell];
        bySpell[key] = (bySpell[key] ?? 0) + 1;
      }
      await sleep(100);
    }
    const killSecs = Math.round((performance.now() - fightStart) / 100) / 10;
    await sleep(2500);
    const texts = await Promise.all(pages.map(bodyText));
    checks.victoryBothPages = texts.every((t) => t.includes("Victory"));
    checks.deepMageToastBothPages = texts.every((t) => t.includes("Boss slain"));
    if (process.env.SHOTS) for (let i = 0; i < 2; i++) await pages[i].screenshot({ path: `${process.env.SHOTS}-${i ? "bo" : "ana"}.png` });
    await sleep(1500);
    const list = (await (await fetch(`${base}/api/rooms`)).json()) as { code?: string }[] | { rooms: { code: string }[] };
    const rooms = Array.isArray(list) ? list : list.rooms;
    checks.roomLeftPublicList = !rooms.some((r) => r.code === created.code);
    const ends = srv.log.recent(500).filter((e) => e.ev === "round.end");
    checks.roundEndWinLogged = ends.some((e) => e.result === "win" && e.world === created.id);
    const sum = srv.summary();
    const w = sum.worlds.find((x) => x.world === created.id);
    checks.hashFailZero = (w?.hashFails ?? -1) === 0 && sum.worlds.every((x) => x.hashFails === 0);
    summary.killSecs = killSecs;
    summary.setupSecs = Math.round((t1 - t0) / 100) / 10;
    summary.won = won;
    summary.casts = casts;
    summary.damageByCause = { ana: dmg[0], bo: dmg[1] };
    summary.tourDamageByCause = { ana: tourDmg[0], bo: tourDmg[1] };
    summary.dropLog = dropLog;
    summary.bossHpEnd = hpTrace[hpTrace.length - 1]?.boss;
    summary.bySpell = bySpell;
    summary.healsPickedUpObserved = healsSeen;
    summary.hashFails = w?.hashFails;
    summary.minHp = { ana: Math.min(...hpTrace.map((h) => h.ana ?? 100)), bo: Math.min(...hpTrace.map((h) => h.bo ?? 100)) };
    summary.hpTrace = hpTrace.filter((_, i) => i % 5 === 0);
    summary.teleportLogged = srv.log.recent(500).some((e) => e.ev === "dev.teleport");
  } finally {
    summary.checks = checks;
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
  summary.ok = ok;
  console.log(JSON.stringify({ ...summary, hpTrace: undefined }, null, 1));
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(summary, null, 1));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
