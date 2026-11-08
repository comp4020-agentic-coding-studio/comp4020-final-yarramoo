// R3: the client-side real-room join path (client/room.ts's resolveRoomTarget, client/worker.ts's beginReplay
// initing from WELCOME's real cfg bytes instead of the derived bare worldKind). This mirrors the existing
// two-client-agreement pattern in tests/net/room-join.test.ts and tests/net/game.test.ts, but decodes the
// config exactly as the browser client does (GET /api/rooms/:code's base64 `config` field, the same bytes
// resolveRoomTarget hands to the worker, which WELCOME must echo back unchanged) rather than reusing the
// server-side RoomConfig object directly, so a regression in either side's (de)coding would show up here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/main.ts";
import { CAVES_PVP, decodeConfig, encodeConfig } from "../../shared/room.ts";
import { buildHashHex, connect, register, sleep, waitFor } from "./helpers.ts";

let hex: string;
beforeAll(async () => {
  hex = await buildHashHex();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sand-menu-room-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
async function boot(dir: string | null): Promise<RunningServer> {
  const s = await startServer({ port: 0, dataDir: dir, quiet: true });
  cleanups.push(() => s.close());
  return s;
}

describe("the menu's real-room join path (two browser-equivalent contexts share a code)", () => {
  it("one context creates an unlisted room and shares its code; a second fetches the same config via /api/rooms/:code and their sims agree on a state hash", async () => {
    const s = await boot(tmp());
    const cfg = { ...CAVES_PVP, size: 0 }; // avatar-capable: a hash-agreement check means something

    // Context A: creates the room (POST /api/rooms), exactly as menu.ts's create-sheet submit does.
    const created = await (
      await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
        method: "POST",
        body: JSON.stringify({ name: "Shared room", mode: "deathmatch", config: Buffer.from(encodeConfig(cfg)).toString("base64"), visibility: "unlisted" }),
      })
    ).json();
    expect(created.code).toMatch(/^[A-Z0-9]{6}$/);

    // The public list never shows this unlisted room (plan "done when").
    const publicList = await (await fetch(`http://127.0.0.1:${s.port}/api/rooms`)).json();
    expect(publicList.rooms.find((r: { code: string }) => r.code === created.code)).toBeUndefined();

    // Context B: "shares the code" by fetching GET /api/rooms/:code, exactly as client/room.ts's
    // resolveRoomTarget does for a `/r/<code>` URL — base64-decoded and run through shared/room.ts's
    // decodeConfig, the same function the client calls.
    const fetched = await (await fetch(`http://127.0.0.1:${s.port}/api/rooms/${created.code}`)).json();
    expect(fetched.id).toBe(created.id);
    const decoded = decodeConfig(Buffer.from(fetched.config, "base64"));
    expect(decoded).toEqual(cfg);

    // Both contexts now HELLO with the same numeric id (client/room.ts's RoomTarget.worldId) and must get a
    // WELCOME whose cfg matches what was fetched — the exact bytes client/worker.ts's beginReplay inits from.
    const [who1, who2] = [await register(s.port, "ShareA"), await register(s.port, "ShareB")];
    const a = await connect(s.port, hex, { world: created.id, token: who1.token });
    const b = await connect(s.port, hex, { world: created.id, token: who2.token });
    const stepper = setInterval(() => (a.ls.run(100000), b.ls.run(100000)), 4);
    cleanups.push(() => clearInterval(stepper));
    a.move(5, 5);
    await waitFor(() => s.worlds.get(created.id)!.clock.lastClosed > 30, 10000, "a few ticks");
    await sleep(200);
    clearInterval(stepper);
    a.drain();
    b.drain();
    const common = [...a.hashes.keys()].filter((t) => b.hashes.has(t));
    expect(common.length, "no common ticks to compare").toBeGreaterThan(0);
    for (const t of common) expect(b.hashes.get(t), `clients disagree at tick ${t}`).toBe(a.hashes.get(t));
    a.close();
    b.close();
  });

  it("an unknown room code (as a visitor might mistype) is a clean 404, not a crash", async () => {
    const s = await boot(tmp());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/rooms/ZZZZZZ`);
    expect(res.status).toBe(404);
  });
});
