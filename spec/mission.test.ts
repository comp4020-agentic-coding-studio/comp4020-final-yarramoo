import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { allKeys, Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");
const seq = JSON.parse(readFileSync("data/sequences/mvp.json", "utf8"));

describe("a two-player mission", () => {
  const a = new Client(baseUrl);
  const b = new Client(baseUrl);
  const nameA = uniqueCallsign("fd");
  const nameB = uniqueCallsign("pr");
  let code = "";

  beforeAll(async () => {
    expect((await a.setCallsign(nameA)).status).toBe(303);
    expect((await b.setCallsign(nameB)).status).toBe(303);
    const res = await a.post("/missions");
    expect(res.status).toBe(303);
    code = res.headers.get("location")!.replace("/m/", "");
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  });
  afterAll(async () => {
    // end the mission so the server is not left ticking it, then drop every stream
    await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
    b.closeStreams();
  });

  const seatsAre = (flight: string | null, ground: string | null, propulsion: string | null) => (m: any) =>
    m.type === "lobby" && m.seats.flight === flight && m.seats.ground === ground && m.seats.propulsion === propulsion;

  it("both see the code, and a claimed seat reaches the other's lobby stream within 1 s", async () => {
    for (const client of [a, b]) {
      const { res, text } = await client.get(`/m/${code}`);
      expect(res.status).toBe(200);
      expect(text).toContain(code);
    }
    const sa = a.stream(`/m/${code}/stream`);
    const sb = b.stream(`/m/${code}/stream`);
    await sa.waitFor((m) => m.type === "lobby" && m.phase === "lobby");
    await sb.waitFor((m) => m.type === "lobby" && m.phase === "lobby");

    expect((await a.post(`/m/${code}/seat`, { role: "flight" })).status).toBe(303);
    expect((await a.post(`/m/${code}/seat`, { role: "ground" })).status).toBe(303);
    await sb.waitFor(seatsAre(nameA, nameA, null), 1000);

    // the same seat cannot be taken twice
    expect((await b.post(`/m/${code}/seat`, { role: "flight" })).status).toBe(409);

    expect((await b.post(`/m/${code}/seat`, { role: "propulsion" })).status).toBe(303);
    await sa.waitFor(seatsAre(nameA, nameA, nameB), 1000);
    sa.close();
    sb.close();
  });

  // Streams opened after the seats are settled; B's stays open through the
  // redaction check so it sees everything the server sends B.
  let sa: ReturnType<Client["stream"]>;
  let sb: ReturnType<Client["stream"]>;

  it("start needs every seat; once started, B's stream shows phase count within 1 s", async () => {
    // a throwaway mission with a missing seat
    const solo = await a.post("/missions");
    const soloCode = solo.headers.get("location")!.replace("/m/", "");
    await a.post(`/m/${soloCode}/seat`, { role: "flight" });
    const early = await a.act(soloCode, { role: "flight", type: "start" });
    expect(early.status).toBe(200);
    expect(early.body.ok).toBe(false);
    expect(early.body.error).toMatch(/seat/);

    // B holds propulsion; only the flight seat may start
    const notFlight = await b.act(code, { role: "flight", type: "start" });
    expect(notFlight.status).toBe(403);

    sa = a.stream(`/m/${code}/stream`);
    sb = b.stream(`/m/${code}/stream`);
    await sb.waitFor((m) => m.type === "views" && m.views.propulsion?.phase === "lobby");
    const started = await a.act(code, { role: "flight", type: "start" });
    expect(started.body).toEqual({ ok: true });
    await sb.waitFor((m) => m.type === "views" && m.views.propulsion?.phase === "count", 1000);
    await sa.waitFor((m) => m.type === "views" && m.views.flight?.phase === "count", 1000);
  });

  it("a propulsion step by B shows as done in A's flight checklist within 1 s", async () => {
    // propulsion's first step waits on ground's arm_retract, and its window opens 10 s into the count
    expect((await a.act(code, { role: "ground", type: "step", stepId: "arm_retract" })).body.ok).toBe(true);
    await sb.waitFor((m) => m.type === "views" && m.views.propulsion?.steps.find((s: any) => s.id === "tank_pressurise")?.status === "ready", 15_000);
    expect((await b.act(code, { role: "propulsion", type: "step", stepId: "tank_pressurise" })).body.ok).toBe(true);
    await sa.waitFor(
      (m) => m.type === "views" && m.views.flight?.checklist?.find((s: any) => s.id === "tank_pressurise")?.status === "done",
      1000,
    );
  }, 30_000);

  it("B's stream never carries another console's data, engine events or fault truth", async () => {
    await new Promise((r) => setTimeout(r, 2200)); // a couple of 1 Hz pushes
    const msgs = sb.messages;
    expect(msgs.length).toBeGreaterThan(3);
    const forbidden = [
      ...Object.entries(seq.values).filter(([, v]: any) => v.role !== "propulsion").flatMap(([id, v]: any) => [id, v.label]),
      ...seq.faults.filter((f: any) => f.role !== "propulsion").map((f: any) => f.label),
      ...seq.steps.filter((s: any) => s.role !== "propulsion").map((s: any) => s.label),
    ];
    expect(forbidden.length).toBeGreaterThan(4);
    for (const m of msgs) {
      const text = JSON.stringify(m);
      if (m.type === "views") {
        expect(Object.keys(m.views)).toEqual(["propulsion"]);
      } else {
        expect(m.type).toBe("lobby");
        expect(Object.keys(m).sort()).toEqual(["outcome", "phase", "seats", "serverNow", "tMs", "type"]);
      }
      for (const f of forbidden) expect(text, `leaked "${f}"`).not.toContain(f);
      const keys = allKeys(m);
      for (const k of ["real", "debrief", "events", "scheduledT", "checklist"]) expect(keys.has(k), `key ${k}`).toBe(false);
    }
  });

  it("rejects an unheld role, a missing CSRF token and an unknown type; ignores client clock fields", async () => {
    // not your seat
    const notMine = await b.act(code, { role: "ground", type: "step", stepId: "pad_clear" });
    expect(notMine.status).toBe(403);
    expect(notMine.body.ok).toBe(false);

    // no CSRF
    const noCsrf = await b.post(`/m/${code}/act`, { role: "propulsion", type: "hold" }, { csrf: false });
    expect(noCsrf.status).toBe(403);

    // unknown type: 200 with ok:false
    const unknown = await b.act(code, { role: "propulsion", type: "detonate" });
    expect(unknown.status).toBe(200);
    expect(unknown.body.ok).toBe(false);

    // real actions with time fields attached: the clock must not move. A calls a
    // hold and resumes; each view's tMs may advance by at most the real time between pushes.
    const sneaky = { tMs: "999999999", nowMs: "-5", atT: "0", clockOffsetMs: "99999999999", serverNow: "1" };
    const lastFlight = () => sa.messages.filter((m) => m.type === "views").at(-1);
    for (const [type, phase] of [["hold", "hold"], ["resume", "count"]] as const) {
      const before = lastFlight();
      const from = sa.messages.length;
      const res = await a.act(code, { role: "flight", type, ...sneaky });
      expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
      const next = await sa.waitFor((m) => sa.messages.indexOf(m) >= from && m.type === "views" && m.views.flight?.phase === phase, 1000);
      const moved = next.views.flight.tMs - before.views.flight.tMs;
      expect(moved).toBeGreaterThanOrEqual(0);
      expect(moved).toBeLessThanOrEqual(next.serverNow - before.serverNow + 50);
    }
  });
});

describe("callsigns", () => {
  it("a taken callsign (any case) shows an error and makes no second crew", async () => {
    const name = uniqueCallsign("dup");
    const first = new Client(baseUrl);
    expect((await first.setCallsign(name)).status).toBe(303);

    const second = new Client(baseUrl);
    const res = await second.setCallsign(name.toUpperCase());
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already taken/);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("crew="))).toBe(false);
    const home = await second.get("/");
    expect(home.text).toContain("callsign-form"); // still no crew
    expect((await second.post("/missions")).status).toBe(303);
    expect((await second.post("/missions")).headers.get("location")).toBe("/");

    const bad = await second.setCallsign("no spaces!");
    expect(bad.status).toBe(422);
  });
});
