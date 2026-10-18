// Admin player page and JSON: auth, id handling, exact values, escaping, and the public views staying nameless.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function boot(adminToken: string | undefined = "secret"): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "sand-pp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await startServer({ port: 0, dataDir: dir, quiet: true, adminToken: adminToken ?? "" });
  cleanups.push(() => s.close());
  return s;
}
const get = (s: RunningServer, path: string, token?: string) =>
  fetch(`http://127.0.0.1:${s.port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("admin player page", () => {
  it("403 without a token and with a wrong one, on the page and the JSON", async () => {
    const s = await boot();
    const id = s.db!.createPlayer("Ann", "h1");
    for (const path of [`/dashboard/player/${id}`, `/api/admin/player/${id}`]) {
      expect((await get(s, path)).status).toBe(403);
      expect((await get(s, path, "wrong")).status).toBe(403);
      expect((await get(s, `${path}?token=wrong`)).status).toBe(403);
      expect((await get(s, path, "secret")).status).toBe(200);
      expect((await get(s, `${path}?token=secret`)).status).toBe(200);
    }
  });

  it("is disabled with no ADMIN_TOKEN, even for an empty token", async () => {
    const s = await boot(undefined);
    const id = s.db!.createPlayer("Ann", "h1");
    expect((await get(s, `/dashboard/player/${id}`)).status).toBe(403);
    expect((await get(s, `/dashboard/player/${id}?token=`)).status).toBe(403);
    expect((await get(s, `/api/admin/player/${id}`, "")).status).toBe(403);
  });

  it("404 for a bad or unknown id without echoing it", async () => {
    const s = await boot();
    s.db!.createPlayer("Ann", "h1");
    for (const bad of ["0", "-1", "abc", "1.5", "1e3", "999", "%3Cscript%3E", "01"]) {
      for (const base of ["/dashboard/player/", "/api/admin/player/"]) {
        const r = await get(s, base + bad, "secret");
        expect(r.status, base + bad).toBe(404);
        const body = await r.text();
        expect(body).not.toContain(bad === "999" ? "999" : "script");
        expect(body).not.toContain(bad);
      }
    }
    expect((await get(s, "/dashboard/player/1/extra", "secret")).status).toBe(404);
  });

  it("JSON carries the exact stored values and achievements; stats come from memory when loaded", async () => {
    const s = await boot();
    const id = s.db!.createPlayer("Zed", "h1");
    s.playerStats.bump(id, "casts_push", 7);
    s.playerStats.bump(id, "casts_water", 3);
    s.playerStats.bump(id, "paints_sand", 12);
    s.playerStats.bump(id, "sessions", 2);
    s.playerStats.bump(id, "play_ms", 3_725_000);
    s.playerStats.bump(id, "kills", 4);
    s.playerStats.bump(id, "deaths", 1);
    s.playerStats.max(id, "max_depth", 900);
    s.db!.awardAchievement(id, "first_spell", 1, 55);
    // Not flushed: the page must show the live totals.
    const j = await (await get(s, `/api/admin/player/${id}`, "secret")).json();
    expect(j).toMatchObject({
      id,
      name: "Zed",
      who: `Zed#${id}`,
      statsSource: "memory",
      sessions: 2,
      playMs: 3_725_000,
      maxDepth: 900,
      depthBand: "deep",
      kills: 4,
      deaths: 1,
      casts: { push: 7, water: 3 },
      paints: { sand: 12 },
      joinedAt: null,
      online: [],
    });
    const ach = j.achievements as { id: string; earned: boolean; earnedAt: number | null; world: number | null; tick: number | null }[];
    expect(ach.filter((a) => a.earned).map((a) => [a.id, a.world, a.tick])).toEqual([["first_spell", 1, 55]]);
    expect(ach.find((a) => a.id === "first_spell")!.earnedAt).toBeGreaterThan(0);
    expect(ach.find((a) => a.id === "gardener")).toMatchObject({ earned: false, earnedAt: null });
    expect(ach.length).toBeGreaterThanOrEqual(10);
    const html = await (await get(s, `/dashboard/player/${id}`, "secret")).text();
    expect(html).toContain(`Zed#${id}`);
    expect(html).toContain("1h 2m"); // 3725 s
    expect(html).toContain("900 cells (deep)");
    expect(html).toContain("live memory totals");
    expect(html).toContain("not yet earned");
    // The same player read from a fresh server instance's DB path: unloaded stats come from the database.
    s.playerStats.flush();
    expect(s.db!.loadStats(id).kills).toBe(4);
  });

  it("escapes a hostile name on the page", async () => {
    const s = await boot();
    const id = s.db!.createPlayer(`<script>alert(1)</script>"&`, "h1");
    const html = await (await get(s, `/dashboard/player/${id}`, "secret")).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;#" + id);
    // The only script tag a page may carry is none at all.
    expect(html).not.toContain("<script");
  });

  it("the public dashboard and summary still contain no names", async () => {
    const s = await boot();
    s.db!.createPlayer("Visible", "h1");
    for (const path of ["/dashboard", "/api/summary"]) {
      const body = await (await get(s, path)).text();
      expect(body).not.toContain("Visible");
    }
  });
});

describe("admin player index", () => {
  it("is admin only and links each player", async () => {
    const s = await boot();
    const id = s.db!.createPlayer("Ann", "h1");
    expect((await get(s, "/dashboard/players")).status).toBe(403);
    expect((await get(s, "/dashboard/players", "wrong")).status).toBe(403);
    const html = await (await get(s, "/dashboard/players", "secret")).text();
    expect(html).toContain(`href="/dashboard/player/${id}"`);
    expect(html).toContain(`Ann#${id}`);
  });

  it("paginates 50 a page, newest last_seen first, capped at 200", async () => {
    const s = await boot();
    for (let i = 1; i <= 230; i++) s.db!.db.prepare("insert into players (display_name, token_hash, created_at, last_seen) values (?, ?, 1, ?)").run(`P${i}`, `h${i}`, i);
    const page = async (q: string) => await (await get(s, `/dashboard/players${q}`, "secret")).text();
    const names = (h: string) => [...h.matchAll(/>(P\d+#\d+)</g)].map((m) => m[1]);
    const p1 = names(await page(""));
    expect(p1).toHaveLength(50);
    expect(p1[0]).toBe("P230#230");
    expect(p1[49]).toBe("P181#181");
    const p2 = names(await page("?page=2"));
    expect(p2[0]).toBe("P180#180");
    const p4 = await page("?page=4");
    expect(names(p4)).toHaveLength(50);
    expect(names(p4)[49]).toBe("P31#31");
    expect(names(await page("?page=5"))).toHaveLength(0);
    expect(await page("")).toContain("page 1 of 4");
    expect(await page("?page=abc")).toContain("page 1 of 4");
  });

  it("escapes a hostile name", async () => {
    const s = await boot();
    s.db!.createPlayer("<script>alert(1)</script>", "h1");
    const html = await (await get(s, "/dashboard/players", "secret")).text();
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
