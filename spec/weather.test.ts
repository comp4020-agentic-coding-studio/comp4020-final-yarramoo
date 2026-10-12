import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { allKeys, Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");
const k2 = JSON.parse(readFileSync("data/sequences/kestrel2.json", "utf8"));
const weatherIds = Object.entries(k2.values).filter(([, v]: any) => v.role === "weather").map(([id]) => id);
const weatherLabels = Object.values(k2.values).filter((v: any) => v.role === "weather").map((v: any) => v.label as string);

describe("Kestrel-2 with a weather seat", () => {
  const a = new Client(baseUrl);
  const b = new Client(baseUrl);
  let code = "";

  beforeAll(async () => {
    expect((await a.setCallsign(uniqueCallsign("wf"))).status).toBe(303);
    expect((await b.setCallsign(uniqueCallsign("wp"))).status).toBe(303);
  });
  afterAll(async () => {
    if (code) await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
    b.closeStreams();
  });

  it("the home page offers both sequences, Kestrel-1 selected", async () => {
    const { text } = await a.get("/");
    expect(text).toContain('name="sequence" value="mvp" checked');
    expect(text).toContain('name="sequence" value="kestrel2"');
    expect(text).toContain("Kestrel-1 suborbital");
    expect(text).toContain("Kestrel-2 orbital");
  });

  it("an unknown sequence is refused, and none means Kestrel-1 with three seats", async () => {
    const bad = await a.post("/missions", { sequence: "../../etc/passwd" });
    expect(bad.status).toBe(422);
    const plain = await a.post("/missions");
    expect(plain.status).toBe(303);
    const plainCode = plain.headers.get("location")!.replace("/m/", "");
    const { text } = await a.get(`/m/${plainCode}`);
    expect(text).toContain("Kestrel-1 suborbital");
    expect(text).not.toContain('data-role="weather"');
  });

  it("a kestrel2 mission lists all four seats, and starts only when weather is seated", async () => {
    const res = await a.post("/missions", { sequence: "kestrel2" });
    expect(res.status).toBe(303);
    code = res.headers.get("location")!.replace("/m/", "");
    const { text } = await a.get(`/m/${code}`);
    expect(text).toContain("Kestrel-2 orbital");
    for (const r of ["flight", "propulsion", "ground", "weather"]) expect(text).toContain(`data-role="${r}"`);

    expect((await a.post(`/m/${code}/seat`, { role: "flight" })).status).toBe(303);
    expect((await a.post(`/m/${code}/seat`, { role: "weather" })).status).toBe(303);
    expect((await b.post(`/m/${code}/seat`, { role: "propulsion" })).status).toBe(303);
    const early = await a.act(code, { role: "flight", type: "start" });
    expect(early.body.ok).toBe(false);
    expect(early.body.error).toMatch(/ground/);
    expect((await b.post(`/m/${code}/seat`, { role: "ground" })).status).toBe(303);
  });

  it("the weather seat's stream carries weather readouts; propulsion and ground never see them", async () => {
    const sa = a.stream(`/m/${code}/stream`);
    const sb = b.stream(`/m/${code}/stream`);
    await sa.waitFor((m) => m.type === "lobby" && m.seats.weather !== null && m.seats.ground !== null);
    expect((await a.act(code, { role: "flight", type: "start" })).body).toEqual({ ok: true });
    await sa.waitFor((m) => m.type === "views" && m.views.weather?.phase === "count", 2000);
    await sb.waitFor((m) => m.type === "views" && m.views.propulsion?.phase === "count", 2000);
    await new Promise((r) => setTimeout(r, 2500)); // a couple of 1 Hz pushes, so values have moved

    const latest = sa.messages.filter((m) => m.type === "views" && m.views.weather).at(-1);
    const w = latest.views.weather;
    expect(w.role).toBe("weather");
    expect(w.values.map((v: any) => v.id).sort()).toEqual([...weatherIds].sort());
    for (const v of w.values) {
      expect(typeof v.value).toBe("number");
      expect(v.nominal).toHaveLength(2);
      expect(v.limit).toHaveLength(2);
    }
    expect(w.steps.map((s: any) => s.id).sort()).toEqual(["balloon_release", "lcc_brief"]);
    // the seat holding flight and weather gets each view separately: flight carries no readouts
    expect(latest.views.flight.values).toEqual([]);
    expect(JSON.stringify(latest.views.flight)).not.toContain(weatherLabels[0]);

    // B holds propulsion and ground only
    expect(sb.messages.length).toBeGreaterThan(2);
    for (const m of sb.messages) {
      const text = JSON.stringify(m);
      if (m.type === "views") for (const r of Object.keys(m.views)) expect(["ground", "propulsion"]).toContain(r);
      for (const id of weatherIds) expect(text, `leaked ${id}`).not.toContain(`"${id}"`);
      for (const l of weatherLabels) expect(text, `leaked ${l}`).not.toContain(l);
      expect(text).not.toContain("Release weather balloon");
      const keys = allKeys(m);
      for (const k of ["real", "debrief", "events", "scheduledT", "checklist", "fronts", "frontIdx", "rate"]) {
        expect(keys.has(k), `key ${k}`).toBe(false);
      }
    }
    sa.close();
    sb.close();
  }, 20_000);

  it("a weather step lands on the weather console and shows up in flight's checklist", async () => {
    const sa = a.stream(`/m/${code}/stream`);
    // the balloon waits on ground's pad check, and its own window opens 25 s into the count
    expect((await b.act(code, { role: "ground", type: "step", stepId: "pad_clear" })).body.ok).toBe(true);
    await sa.waitFor((m) => m.type === "views" && m.views.weather?.steps.find((s: any) => s.id === "balloon_release")?.status === "ready", 35_000);
    expect((await a.act(code, { role: "weather", type: "step", stepId: "balloon_release" })).body.ok).toBe(true);
    await sa.waitFor((m) => m.type === "views" && m.views.flight?.checklist?.find((s: any) => s.id === "balloon_release")?.status === "done", 3000);
    // the weather seat cannot do another console's step, nor can propulsion's player act as weather
    expect((await a.act(code, { role: "weather", type: "step", stepId: "tank_pressurise" })).body.ok).toBe(false);
    expect((await b.act(code, { role: "weather", type: "step", stepId: "lcc_brief" })).status).toBe(403);
    sa.close();
  }, 50_000);
});
