// Process-level robustness: the real server as a child process on a throwaway
// data directory, stopped and started again mid-mission. The scenarios use
// separate servers, so they run side by side to keep the file under 20 s.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client, uniqueCallsign } from "../../spec/helpers.ts";
import { disposeAll, TestServer } from "./testserver.ts";

afterAll(disposeAll);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A crew member holding all three seats of a mission that has started. */
async function flyingMission(server: TestServer): Promise<{ a: Client; code: string }> {
  const a = new Client(server.url);
  expect((await a.setCallsign(uniqueCallsign("rs"))).status).toBe(303);
  const code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
  for (const role of ["flight", "propulsion", "ground"]) expect((await a.post(`/m/${code}/seat`, { role })).status).toBe(303);
  expect((await a.act(code, { role: "flight", type: "start" })).body).toEqual({ ok: true });
  return { a, code };
}

/** What a freshly connected stream is told first. */
async function snapshot(a: Client, code: string): Promise<{ lobby: any; views: any }> {
  const s = a.stream(`/m/${code}/stream`);
  try {
    const lobby = await s.waitFor((m) => m.type === "lobby", 3000);
    const views = (await s.waitFor((m) => m.type === "views", 3000)).views;
    return { lobby, views };
  } finally {
    s.close();
  }
}

const stepStatus = (views: any, id: string): string | undefined => views.flight.checklist.find((c: any) => c.id === id)?.status;

describe.concurrent("the server process", () => {
  it("SIGTERM mid-mission: still live, the done step is still done, the clock paused for the downtime", async () => {
    const server = new TestServer();
    await server.start();
    const { a, code } = await flyingMission(server);
    expect((await a.act(code, { role: "ground", type: "step", stepId: "arm_retract" })).body).toEqual({ ok: true });
    const before = await snapshot(a, code);
    expect(stepStatus(before.views, "arm_retract")).toBe("done");

    await server.stop("SIGTERM");
    await sleep(1500);
    await server.start();

    const after = await snapshot(a, code);
    expect(after.lobby.phase).toBe("count");
    expect(stepStatus(after.views, "arm_retract")).toBe("done");
    const wall = after.lobby.serverNow - before.lobby.serverNow; // includes the downtime
    const game = after.lobby.tMs - before.lobby.tMs; // what the countdown advanced
    expect(wall - game).toBeGreaterThanOrEqual(1400); // the 1.5 s the server was down was not counted
    expect(game).toBeGreaterThanOrEqual(0);
    expect(game).toBeLessThan(1500); // only the short time it was up
    expect(server.output).toMatch(/resumed at tMs/);
    expect(server.output).not.toMatch(/does not reproduce/);
    // the mission is listed as in progress, not flown
    expect((await a.get("/missions")).text.split("Flown")[0]).toContain(`href="/m/${code}"`);
  }, 15_000);

  it("SIGKILL mid-mission: no accepted action is lost and at most 5 s of clock is", async () => {
    const server = new TestServer();
    await server.start();
    const { a, code } = await flyingMission(server);
    expect((await a.act(code, { role: "ground", type: "step", stepId: "arm_retract" })).body.ok).toBe(true);
    expect((await a.act(code, { role: "ground", type: "step", stepId: "pad_clear" })).body.ok).toBe(true);
    const atStep = await snapshot(a, code);
    await sleep(1500); // the clock runs with nothing written (the next periodic write is 5 s on)
    await server.stop("SIGKILL");
    await sleep(500);
    await server.start();

    const after = await snapshot(a, code);
    expect(after.lobby.phase).toBe("count");
    expect(stepStatus(after.views, "arm_retract")).toBe("done");
    expect(stepStatus(after.views, "pad_clear")).toBe("done");
    // back to the last write (within the snapshot's own ms), never ahead of it by more than the up time
    expect(after.lobby.tMs).toBeGreaterThanOrEqual(atStep.lobby.tMs - 50);
    expect(after.lobby.tMs - atStep.lobby.tMs).toBeLessThan(5000);
    expect(server.output).not.toMatch(/does not reproduce/);
    await a.act(code, { role: "flight", type: "scrub" });
  }, 15_000);

  it("two tabs of one crew both get views; closing one leaves the other, and the mission is not abandoned while one is open", async () => {
    const server = new TestServer({ ABANDON_AFTER_MS: "3000" });
    await server.start();
    const { a, code } = await flyingMission(server);
    const tab1 = a.stream(`/m/${code}/stream`);
    const tab2 = a.stream(`/m/${code}/stream`);
    await tab1.waitFor((m) => m.type === "views" && m.views.ground, 3000);
    await tab2.waitFor((m) => m.type === "views" && m.views.ground, 3000);

    // a step is pushed to both
    expect((await a.act(code, { role: "ground", type: "step", stepId: "arm_retract" })).body.ok).toBe(true);
    const done = (m: any): boolean => m.type === "views" && m.views.flight?.checklist?.find((c: any) => c.id === "arm_retract")?.status === "done";
    await tab1.waitFor(done, 1500);
    await tab2.waitFor(done, 1500);

    tab1.close();
    await sleep(4500); // longer than the 3 s abandon limit
    const seen = tab2.messages.length;
    await sleep(1200);
    expect(tab2.messages.length).toBeGreaterThan(seen); // still receiving, 1 Hz
    expect((await a.fetch(`/missions/${code}`)).status).toBe(302); // still live (a replay would be 200)

    tab2.close();
    let status = 302;
    for (let i = 0; i < 30 && status === 302; i++) {
      await sleep(250);
      status = (await a.fetch(`/missions/${code}`)).status;
    }
    expect(status, "a mission with no console open for 3 s is scrubbed").toBe(200);
    expect(server.output).toMatch(/crew lost contact/);
  }, 20_000);

  it("a poll answered twice at once is counted once, across restarts that move the clock", async () => {
    const server = new TestServer();
    await server.start();
    const { a, code } = await flyingMission(server);
    const a2 = new Client(server.url); // the same crew in a second tab
    a2.jar = new Map(a.jar);

    // Real time would make this a three-minute test: move the countdown on while
    // the server is down, which is exactly what a restart does to it.
    const jump = async (ms: number): Promise<void> => {
      await server.stop("SIGTERM");
      const db = new DatabaseSync(join(server.dataDir, "mission.db"));
      db.prepare("UPDATE missions SET clock_offset_ms = clock_offset_ms - ? WHERE code = ?").run(ms, code);
      db.close();
      await server.start();
    };
    await jump(45_000); // T-195 s: every first-round step is open
    for (const [role, stepId] of [
      ["ground", "arm_retract"], ["ground", "pad_clear"], ["propulsion", "tank_pressurise"],
      ["propulsion", "feed_prime"], ["ground", "deluge_arm"], ["ground", "bus_transfer"],
    ] as const) {
      expect((await a.act(code, { role, type: "step", stepId })).body, stepId).toEqual({ ok: true });
    }
    await jump(90_000); // T-105 s: the first poll is open for business

    const opens = await Promise.all([a, a2, a, a2].map((c) => c.act(code, { role: "flight", type: "poll_open", pollId: "poll_1" })));
    expect(opens.filter((r) => r.body.ok)).toHaveLength(1);
    expect(opens.find((r) => !r.body.ok)!.body.error).toMatch(/already open/);

    const reports = await Promise.all([a, a2, a, a2].map((c) => c.act(code, { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "go" })));
    expect(reports.filter((r) => r.body.ok)).toHaveLength(1);
    expect(reports.find((r) => !r.body.ok)!.body.error).toMatch(/already reported/);

    expect((await a.act(code, { role: "flight", type: "scrub" })).body.ok).toBe(true);
    const replay = (await a.get(`/missions/${code}`)).text;
    // one row on the timeline for each (the poll record and the tick marks repeat them, so count timeline rows only)
    expect(replay.match(/class="ev k-poll_opened"/g)).toHaveLength(1);
    expect(replay.match(/class="ev k-poll_report"/g)).toHaveLength(1);
  }, 20_000);
});
