import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");

describe("mission history", () => {
  const a = new Client(baseUrl);
  const name = uniqueCallsign("hx");
  let live = "";
  let done = "";

  async function seatedMission(): Promise<string> {
    const code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
    for (const role of ["flight", "propulsion", "ground"]) expect((await a.post(`/m/${code}/seat`, { role })).status).toBe(303);
    const start = await a.act(code, { role: "flight", type: "start" });
    expect(start.body.ok).toBe(true);
    return code;
  }

  beforeAll(async () => {
    expect((await a.setCallsign(name)).status).toBe(303);
    live = await seatedMission();
    done = await seatedMission();
    expect((await a.act(done, { role: "flight", type: "scrub" })).body.ok).toBe(true);
  });
  afterAll(async () => {
    await a.act(live, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
  });

  it("/missions lists a started mission under In progress", async () => {
    const { res, text } = await a.get("/missions");
    expect(res.status).toBe(200);
    const inProgress = text.split("Flown")[0]!;
    expect(inProgress).toContain("In progress");
    expect(inProgress).toContain(`href="/m/${live}"`);
    expect(inProgress).toContain(name);
  });

  it("a live mission's replay redirects to the console and reveals no fault truth", async () => {
    const res = await a.fetch(`/missions/${live}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/m/${live}`);
    const { text } = await a.get(`/m/${live}`);
    expect(text).not.toMatch(/glitch|real fault/i);
  });

  it("a scrubbed mission is listed under Flown and has a replay", async () => {
    const { text } = await a.get("/missions");
    const flown = text.split("Flown")[1]!;
    expect(flown).toContain(`/missions/${done}`);
    expect(flown).toContain("SCRUBBED");
    const replay = await a.get(`/missions/${done}`);
    expect(replay.res.status).toBe(200);
    expect(replay.text).toMatch(/scrub/i);
    expect(replay.text).toContain("The record");
    expect((await a.get("/missions/ZZZZZ")).res.status).toBe(404);
  });
});
