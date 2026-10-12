import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { gestureKind } from "../src/game/presence.ts";
import { allKeys, Client, uniqueCallsign } from "./helpers.ts";

// Presence, gestures and head direction: what the other players at the pad can
// see. All of it is public to the crew, so the test that matters is the one
// that proves a gesture says THAT a seat acted and never WHAT it did.

const baseUrl = inject("baseUrl");
const seq = JSON.parse(readFileSync("data/sequences/mvp.json", "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("presence, gestures and looking around", () => {
  const a = new Client(baseUrl); // flight and ground
  const b = new Client(baseUrl); // propulsion
  let code = "";
  let sa: ReturnType<Client["stream"]>;

  beforeAll(async () => {
    expect((await a.setCallsign(uniqueCallsign("pa"))).status).toBe(303);
    expect((await b.setCallsign(uniqueCallsign("pb"))).status).toBe(303);
    code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
    for (const role of ["flight", "ground"]) expect((await a.post(`/m/${code}/seat`, { role })).status).toBe(303);
    expect((await b.post(`/m/${code}/seat`, { role: "propulsion" })).status).toBe(303);
    sa = a.stream(`/m/${code}/stream`);
    await sa.waitFor((m) => m.type === "lobby");
  });
  afterAll(async () => {
    await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
    b.closeStreams();
  });

  /** Wait for a message that arrives after `from` (earlier ones do not count). */
  const next = (s: typeof sa, from: number, pred: (m: any) => boolean, ms = 1500) =>
    s.waitFor((m) => s.messages.indexOf(m) >= from && pred(m), ms);

  it("a seat shows present while its holder has a stream open, and absent within 1.5 s of the last one closing", async () => {
    const first = sa.messages.findLast((m) => m.type === "lobby");
    expect(first.present).toEqual({ flight: true, propulsion: false, ground: true }); // A is connected, B has not been
    let from = sa.messages.length;
    const sb = b.stream(`/m/${code}/stream`);
    const on = await next(sa, from, (m) => m.type === "lobby" && m.present.propulsion === true);
    expect(on.seats.propulsion).toBeTruthy();

    from = sa.messages.length;
    const t0 = Date.now();
    sb.close();
    await next(sa, from, (m) => m.type === "lobby" && m.present.propulsion === false);
    expect(Date.now() - t0).toBeLessThan(1500);

    // reconnecting brings it back, and a second tab closing does not take it away
    from = sa.messages.length;
    const s1 = b.stream(`/m/${code}/stream`);
    const s2 = b.stream(`/m/${code}/stream`);
    await next(sa, from, (m) => m.type === "lobby" && m.present.propulsion === true);
    s1.close();
    await sleep(700);
    expect(sa.messages.slice(from).filter((m) => m.type === "lobby").every((m) => m.present.propulsion === true)).toBe(true);
    s2.close();
  });

  const sb2: { s?: ReturnType<Client["stream"]> } = {};
  const gestures = () => sa.messages.filter((m) => m.type === "gesture");

  it("a rejected action makes no gesture", async () => {
    sb2.s = b.stream(`/m/${code}/stream`);
    await sb2.s.waitFor((m) => m.type === "views");
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
    await next(sa, 0, (m) => m.type === "gesture" && m.kind === "start");
    // propulsion's first step is locked until ground has retracted the arm
    const from = sa.messages.length;
    const r = await b.act(code, { role: "propulsion", type: "step", stepId: "tank_pressurise" });
    expect(r.body.ok).toBe(false);
    await sleep(600);
    expect(sa.messages.slice(from).filter((m) => m.type === "gesture")).toEqual([]);
  });

  it("an accepted step gestures 'press' to everyone, with nothing that says which step", async () => {
    const fromG = gestures().length;
    expect((await a.act(code, { role: "ground", type: "step", stepId: "arm_retract" })).body.ok).toBe(true);
    await next(sa, 0, (m) => m.type === "gesture" && m.role === "ground" && m.kind === "press");
    // propulsion's window opens 10 s into the count
    await sb2.s!.waitFor((m) => m.type === "views" && m.views.propulsion?.steps.find((s: any) => s.id === "tank_pressurise")?.status === "ready", 15_000);
    const from = sa.messages.length;
    expect((await b.act(code, { role: "propulsion", type: "step", stepId: "tank_pressurise" })).body.ok).toBe(true);
    const g = await next(sa, from, (m) => m.type === "gesture" && m.role === "propulsion");
    expect(g.kind).toBe("press");
    expect(typeof g.at).toBe("number");
    // B sees it too (the lobby topic is shared) and the gesture is the same shape
    await sb2.s!.waitFor((m) => m.type === "gesture" && m.role === "propulsion" && m.kind === "press");

    // redaction: no key or value in any gesture or look message is a step, value, fault or poll id or label
    const forbidden = new Set<string>([
      ...seq.steps.flatMap((s: any) => [s.id, s.label]),
      ...Object.entries(seq.values).flatMap(([id, v]: any) => [id, v.label]),
      ...seq.faults.flatMap((f: any) => [f.id, f.label]),
      ...seq.polls.flatMap((p: any) => [p.id, p.label]),
    ]);
    expect(forbidden.size).toBeGreaterThan(15);
    const seen = [...gestures(), ...sb2.s!.messages.filter((m) => m.type === "gesture")];
    expect(seen.length).toBeGreaterThan(2);
    for (const m of seen) {
      expect([...allKeys(m)].sort()).toEqual(["at", "kind", "role", "type"]);
      const text = JSON.stringify(m);
      for (const f of forbidden) expect(text, `gesture leaked "${f}"`).not.toContain(f);
      for (const v of Object.values(m)) expect(forbidden.has(String(v)), `value ${v}`).toBe(false);
    }
    expect(gestures().length).toBeGreaterThan(fromG);
  }, 30_000);

  it("a step press and a fix press are indistinguishable, and every action type has its coarse gesture", () => {
    const press = (stepId: string) => gestureKind({ role: "ground", type: "step", stepId });
    expect(press("arm_retract")).toBe("press");
    expect(press("fix_bus")).toBe(press("arm_retract"));
    expect(gestureKind({ role: "flight", type: "poll_open", pollId: "poll_1" })).toBe("call_poll");
    expect(gestureKind({ role: "ground", type: "poll_report", pollId: "poll_1", report: "go" })).toBe("report_go");
    expect(gestureKind({ role: "ground", type: "poll_report", pollId: "poll_2", report: "nogo" })).toBe("report_nogo");
    expect(gestureKind({ role: "flight", type: "hold" })).toBe("hold");
    expect(gestureKind({ role: "flight", type: "resume" })).toBe("resume");
    expect(gestureKind({ role: "flight", type: "scrub", reason: "a private reason" })).toBe("scrub");
    expect(gestureKind({ role: "flight", type: "start" })).toBe("start");
    expect(gestureKind({ role: "range", type: "terminate" })).toBe("terminate");
  });

  it("a hold by flight gestures 'hold', then 'resume'", async () => {
    let from = sa.messages.length;
    expect((await a.act(code, { role: "flight", type: "hold" })).body.ok).toBe(true);
    await next(sa, from, (m) => m.type === "gesture" && m.role === "flight" && m.kind === "hold");
    from = sa.messages.length;
    expect((await a.act(code, { role: "flight", type: "resume" })).body.ok).toBe(true);
    await next(sa, from, (m) => m.type === "gesture" && m.role === "flight" && m.kind === "resume");
  });

  const look = (c: Client, fields: Record<string, string>) => c.post(`/m/${code}/look`, fields);

  it("head direction: published to the others, wrapped and clamped, held for new streams", async () => {
    let from = sa.messages.length;
    const r = await look(b, { role: "propulsion", yaw: "0.5", pitch: "-0.2" });
    expect(r.status).toBe(200);
    const m = await next(sa, from, (x) => x.type === "look" && x.heads.propulsion);
    expect(m.heads.propulsion).toEqual([0.5, -0.2]);
    expect(Object.keys(m).sort()).toEqual(["heads", "type"]);

    await sleep(1100);
    from = sa.messages.length;
    expect((await look(b, { role: "propulsion", yaw: "7", pitch: "5" })).status).toBe(200); // 7 rad wraps to 7 - 2 pi
    const w = await next(sa, from, (x) => x.type === "look" && x.heads.propulsion?.[1] === 1.2);
    expect(w.heads.propulsion[0]).toBeCloseTo(7 - 2 * Math.PI, 2);

    // a new stream is told where everyone is looking, after its lobby message and views
    const late = a.stream(`/m/${code}/stream`);
    const snap = await late.waitFor((x) => x.type === "look");
    expect(snap.heads.propulsion[1]).toBe(1.2);
    expect(late.messages[0].type).toBe("lobby");
    late.close();
  });

  it("head direction: bad numbers are 400, a seat you do not hold is 403", async () => {
    await sleep(1100);
    for (const bad of [{ yaw: "NaN", pitch: "0" }, { yaw: "0", pitch: "Infinity" }, { yaw: "abc", pitch: "0" }, { yaw: "", pitch: "0" }]) {
      expect((await look(b, { role: "propulsion", ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    await sleep(1100);
    expect((await look(b, { role: "flight", yaw: "0", pitch: "0" })).status).toBe(403);
    expect((await look(a, { role: "propulsion", yaw: "0", pitch: "0" })).status).toBe(403);
    expect((await look(b, { role: "bogus", yaw: "0", pitch: "0" })).status).toBe(403);
    expect((await look(b, { yaw: "0", pitch: "0" })).status).toBe(403);
    expect((await b.post(`/m/${code}/look`, { role: "propulsion", yaw: "0", pitch: "0" }, { csrf: false })).status).toBe(403);
  });

  it("head direction is rate limited per crew member", async () => {
    await sleep(1100);
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => look(b, { role: "propulsion", yaw: String(i / 100), pitch: "0" })));
    const codes = burst.map((r) => r.status);
    expect(codes).toContain(429);
    expect(codes).toContain(200);
    expect(codes.filter((s) => s !== 200 && s !== 429)).toEqual([]);
  });

  it("looks are coalesced: a burst of updates reaches the others at no more than about 5 Hz", async () => {
    await sleep(1200);
    const from = sa.messages.length;
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      await look(b, { role: "propulsion", yaw: String(0.1 * (i + 1)), pitch: "0" });
      await sleep(60);
    }
    await sleep(500);
    const n = sa.messages.slice(from).filter((m) => m.type === "look").length;
    const secs = (Date.now() - t0) / 1000;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(Math.ceil(secs * 5) + 1);
  });
});
