import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { allKeys, Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");
const k3 = JSON.parse(readFileSync("data/sequences/kestrel3.json", "utf8"));
const rangeIds = Object.entries(k3.values).filter(([, v]: any) => v.role === "range").map(([id]) => id);
const rangeLabels = Object.values(k3.values).filter((v: any) => v.role === "range").map((v: any) => v.label as string);
const anomaly = k3.anomalies[0];

describe("Kestrel-3 with a Range Safety seat", () => {
  const a = new Client(baseUrl); // flight, propulsion, ground, weather
  const b = new Client(baseUrl); // range
  let code = "";

  beforeAll(async () => {
    expect((await a.setCallsign(uniqueCallsign("rf"))).status).toBe(303);
    expect((await b.setCallsign(uniqueCallsign("rr"))).status).toBe(303);
  });
  afterAll(async () => {
    if (code) await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
    b.closeStreams();
  });

  it("the home page offers Kestrel-3 as a third sequence", async () => {
    const { text } = await a.get("/");
    expect(text).toContain('name="sequence" value="kestrel3"');
    expect(text).toContain("Kestrel-3 crewed cargo");
    expect(text).toContain("range safety");
  });

  it("a kestrel3 lobby lists five seats and will not start until range is seated", async () => {
    const res = await a.post("/missions", { sequence: "kestrel3" });
    expect(res.status).toBe(303);
    code = res.headers.get("location")!.replace("/m/", "");
    const { text } = await a.get(`/m/${code}`);
    expect(text).toContain("Kestrel-3 crewed-cargo");
    for (const r of ["flight", "propulsion", "ground", "weather", "range"]) expect(text).toContain(`data-role="${r}"`);
    expect(text).toContain("Range Safety");

    for (const r of ["flight", "propulsion", "ground", "weather"]) {
      expect((await a.post(`/m/${code}/seat`, { role: r })).status).toBe(303);
    }
    const early = await a.act(code, { role: "flight", type: "start" });
    expect(early.body.ok).toBe(false);
    expect(early.body.error).toMatch(/range/);
    expect((await b.post(`/m/${code}/seat`, { role: "range" })).status).toBe(303);
  });

  it("range's stream carries the range values and no other console's; the others carry none of range's", async () => {
    const sa = a.stream(`/m/${code}/stream`);
    const sb = b.stream(`/m/${code}/stream`);
    await sa.waitFor((m) => m.type === "lobby" && Object.values(m.seats).every((s) => s !== null));
    expect((await a.act(code, { role: "flight", type: "start" })).body).toEqual({ ok: true });
    await sb.waitFor((m) => m.type === "views" && m.views.range?.phase === "count", 2000);
    await sa.waitFor((m) => m.type === "views" && m.views.flight?.phase === "count", 2000);

    const mine = sb.messages.filter((m) => m.type === "views" && m.views.range).at(-1).views.range;
    expect(mine.role).toBe("range");
    expect(mine.values.map((v: any) => v.id).sort()).toEqual([...rangeIds].sort());
    expect(mine.steps.map((s: any) => s.id).sort()).toEqual(["fts_arm", "hazard_clear"]);
    expect(mine.terminateAvailable).toBeUndefined();
    expect(mine.ascentSec).toBe(60);

    // range holds nothing else: no tank pressure, weather or pad bus, and nothing about faults or truth
    for (const m of sb.messages) {
      const text = JSON.stringify(m);
      if (m.type === "views") expect(Object.keys(m.views)).toEqual(["range"]);
      for (const id of ["tank_pressure", "bus_voltage", "ceiling", "shear", "lightning"]) expect(text, `range sees ${id}`).not.toContain(`"${id}"`);
      for (const k of ["real", "debrief", "events", "scheduledT", "checklist", "fronts", "stage"]) {
        expect(allKeys(m).has(k), `key ${k}`).toBe(false);
      }
    }
    // the other four seats, on A's stream, never see range's readouts or anomaly
    expect(sa.messages.length).toBeGreaterThan(2);
    for (const m of sa.messages) {
      const text = JSON.stringify(m);
      for (const id of rangeIds) expect(text, `leaked ${id}`).not.toContain(`"${id}"`);
      for (const l of rangeLabels) expect(text, `leaked ${l}`).not.toContain(l);
      expect(text).not.toContain(anomaly.label);
      expect(text).not.toContain("terminateAvailable");
      for (const k of ["real", "debrief", "events", "scheduledT", "fronts", "stage"]) expect(allKeys(m).has(k), `key ${k}`).toBe(false);
    }
    // propulsion holds the cross-check, flight's checklist lists range's tasks without their values
    const prop = sa.messages.filter((m) => m.type === "views" && m.views.propulsion).at(-1).views.propulsion;
    expect(prop.crossChecks.map((c: any) => c.label)).toContain(anomaly.crossCheck.label);
    expect(prop.crossChecks.find((c: any) => c.label === anomaly.crossCheck.label).reading).toBe("normal");
    const flight = sa.messages.filter((m) => m.type === "views" && m.views.flight).at(-1).views.flight;
    expect(flight.checklist.some((c: any) => c.id === "hazard_clear")).toBe(true);
    expect(flight.values).toEqual([]);
    sa.close();
    sb.close();
  }, 20_000);

  it("terminate is refused before ascent, and by every seat that is not Range Safety", async () => {
    // range itself, but the vehicle has not launched
    const early = await b.act(code, { role: "range", type: "terminate" });
    expect(early.status).toBe(200);
    expect(early.body.ok).toBe(false);
    expect(early.body.error).toMatch(/has not launched/);
    // a seat the player does not hold is a 403, and holding flight is not enough
    expect((await b.act(code, { role: "flight", type: "terminate" })).status).toBe(403);
    expect((await a.act(code, { role: "range", type: "terminate" })).status).toBe(403);
    for (const role of ["flight", "propulsion", "ground", "weather"]) {
      const r = await a.act(code, { role, type: "terminate" });
      expect(r.body.ok, role).toBe(false);
      expect(r.body.error, role).toMatch(/only Range Safety/);
    }
    // the mission is still counting
    const sa = a.stream(`/m/${code}/stream`);
    const live = await sa.waitFor((m) => m.type === "views" && m.views.flight?.phase === "count", 2000);
    expect(live.views.flight.outcome).toBeNull();
    sa.close();
  });

  it("a range step lands on the range console, and only range may do it", async () => {
    const sb = b.stream(`/m/${code}/stream`);
    // hazard_clear waits on ground's pad check and its own window opens 20 s into the count
    expect((await b.act(code, { role: "range", type: "step", stepId: "hazard_clear" })).body.ok).toBe(false);
    expect((await a.act(code, { role: "ground", type: "step", stepId: "pad_clear" })).body.ok).toBe(true);
    await sb.waitFor((m) => m.type === "views" && m.views.range?.steps.find((s: any) => s.id === "hazard_clear")?.status === "ready", 35_000);
    expect((await a.act(code, { role: "weather", type: "step", stepId: "hazard_clear" })).body.ok).toBe(false);
    expect((await b.act(code, { role: "range", type: "step", stepId: "hazard_clear" })).body.ok).toBe(true);
    await sb.waitFor((m) => m.type === "views" && m.views.range?.steps.find((s: any) => s.id === "hazard_clear")?.status === "done", 2000);
    const hz = sb.messages.filter((m) => m.type === "views" && m.views.range).at(-1).views.range.values.find((v: any) => v.id === "hazard_area");
    expect(hz.value).toBe(0);
    sb.close();
  }, 50_000);
});
