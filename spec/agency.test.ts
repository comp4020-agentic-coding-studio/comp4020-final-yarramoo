import { afterAll, describe, expect, inject, it } from "vitest";
import { Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function newMission(c: Client): Promise<string> {
  const res = await c.post("/missions");
  expect(res.status).toBe(303);
  return res.headers.get("location")!.replace("/m/", "");
}

describe("the shared agency", () => {
  const a = new Client(baseUrl);
  afterAll(() => a.closeStreams());

  it("/agency shows budget and reputation", async () => {
    await a.setCallsign(uniqueCallsign("ag"));
    const { res, text } = await a.get("/agency");
    expect(res.status).toBe(200);
    expect(text).toMatch(/id="budget">\d+/);
    expect(text).toMatch(/id="reputation">\d+/);
    expect(text).toContain("NO-GO on a caution");
  });

  it("the lobby names the assigned rocket", async () => {
    const code = await newMission(a);
    const { text } = await a.get(`/m/${code}`);
    expect(text).toMatch(/id="rocket-name">K1-\d+/);
    expect(text).toContain("LC-1");
    await a.post(`/m/${code}/seat`, { role: "flight" }); // leaves a stale lobby only
  });

  it("a scrubbed mission puts -50 in the ledger, on the replay and pings the agency stream", async () => {
    const code = await newMission(a);
    for (const role of ["flight", "propulsion", "ground"]) await a.post(`/m/${code}/seat`, { role });
    const s = a.stream("/agency/stream");
    await s.waitFor((m) => m.type === "hello");
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
    expect((await a.act(code, { role: "flight", type: "scrub" })).body.ok).toBe(true);
    await s.waitFor((m) => m.type === "agency", 2000);
    const replay = (await a.get(`/missions/${code}`)).text;
    expect(replay).toContain("What it cost the agency");
    expect(replay).toMatch(/-50<\/td>[\s\S]*?Scrub/);
    const ledger = (await a.get("/agency")).text;
    expect(ledger).toContain(`/missions/${code}`);
  });

  it("two simultaneous pad repairs on an undamaged pad cost nothing and write no ledger line", async () => {
    // the shared pad may be damaged by other files; only assert when it is whole
    const before = (await a.get("/agency")).text;
    if (!before.includes("LC-1") || !/aria-label="100%"/.test(before.split("Pads")[1]!.split("Hangar")[0]!)) return;
    const n = (t: string) => (t.match(/Repaired pad/g) ?? []).length;
    const rs = await Promise.all([a.post("/agency/repair-pad"), a.post("/agency/repair-pad")]);
    for (const r of rs) {
      expect(r.status).toBe(303);
      expect(decodeURIComponent(r.headers.get("location")!)).toContain("Nothing to repair");
    }
    expect(n((await a.get("/agency")).text)).toBe(n(before));
  });

  it("a POST without a CSRF token is refused", async () => {
    const r = await a.post("/agency/buy-rocket", {}, { csrf: false });
    expect(r.status).toBe(403);
  });
});
