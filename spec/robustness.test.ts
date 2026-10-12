import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Client, uniqueCallsign } from "./helpers.ts";

// Unplanned use: simultaneous and repeated actions, two tabs, dropped streams,
// oversized and garbage input, and a script hammering the server. Process-level
// cases (restart, SIGKILL, abandonment) are in src/game/restart.test.ts, which
// needs to stop and start the server and so cannot run against a shared one.
const baseUrl = inject("baseUrl");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Two crew members for the whole file (the app allows ten new callsigns a
// minute per address and the other spec files need theirs). `tab2` is `a` in a
// second browser tab.
const a = new Client(baseUrl);
const b = new Client(baseUrl);
const tab2 = new Client(baseUrl);
beforeAll(async () => {
  expect((await a.setCallsign(uniqueCallsign("ra"))).status).toBe(303);
  expect((await b.setCallsign(uniqueCallsign("rb"))).status).toBe(303);
  tab2.jar = new Map(a.jar);
});
afterAll(() => {
  a.closeStreams();
  b.closeStreams();
  tab2.closeStreams();
});

describe("simultaneous and repeated use", () => {
  let code = "";
  const created: string[] = [];

  async function newMission(c: Client): Promise<string> {
    const res = await c.post("/missions");
    expect(res.status).toBe(303);
    created.push(res.headers.get("location")!.replace("/m/", ""));
    return created.at(-1)!;
  }

  afterAll(async () => {
    for (const c of created) await a.act(c, { role: "flight", type: "scrub" }).catch(() => {});
  });

  it("two people racing for one seat: exactly one gets it", async () => {
    code = await newMission(a);
    const [ra, rb] = await Promise.all([a.post(`/m/${code}/seat`, { role: "ground" }), b.post(`/m/${code}/seat`, { role: "ground" })]);
    expect([ra.status, rb.status].sort()).toEqual([303, 409]);
    // settle the lobby: a holds flight and ground, b holds propulsion
    if (rb.status === 303) {
      expect((await b.post(`/m/${code}/unseat`, { role: "ground" })).status).toBe(303);
      expect((await a.post(`/m/${code}/seat`, { role: "ground" })).status).toBe(303);
    }
    expect((await a.post(`/m/${code}/seat`, { role: "flight" })).status).toBe(303);
    expect((await b.post(`/m/${code}/seat`, { role: "propulsion" })).status).toBe(303);
  });

  it("only the Flight Director can start the count", async () => {
    const r = await b.act(code, { role: "propulsion", type: "start" });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/Flight Director/);
  });

  it("a Start pressed in two tabs at once starts the count once", async () => {
    const lobby = a.stream(`/m/${code}/stream`);
    const seated = await lobby.waitFor((x) => x.type === "lobby", 2000);
    lobby.close();
    for (const r of ["flight", "ground", "propulsion"]) expect(seated.seats[r], `seat ${r}`).toBeTruthy();

    const starts = await Promise.all([a, tab2, a, tab2].map((c) => c.act(code, { role: "flight", type: "start" })));
    expect(starts.map((s) => s.status)).toEqual([200, 200, 200, 200]);
    expect(starts.filter((s) => s.body.ok)).toHaveLength(1);
    for (const s of starts.filter((s) => !s.body.ok)) expect(s.body.error).toMatch(/already started/);
  });

  it("the same step pressed in two tabs at once is done once and logged once", async () => {
    const results = await Promise.all(
      [a, tab2, a, tab2, a].map((c) => c.act(code, { role: "ground", type: "step", stepId: "arm_retract" })),
    );
    expect(results.filter((r) => r.body.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.body.ok)) expect(r.body.error).toMatch(/already done|not available|nothing to fix/);
  });

  it("two tabs of one crew both get the views; closing one leaves the other receiving", async () => {
    const t1 = a.stream(`/m/${code}/stream`);
    const t2 = tab2.stream(`/m/${code}/stream`);
    await t1.waitFor((m) => m.type === "views" && m.views.ground, 2000);
    await t2.waitFor((m) => m.type === "views" && m.views.ground, 2000);
    t1.close();
    await sleep(300);
    const before = t2.messages.length;
    expect((await a.act(code, { role: "ground", type: "step", stepId: "pad_clear" })).body.ok).toBe(true);
    await t2.waitFor((m) => m.type === "views" && m.views.flight?.checklist?.find((c: any) => c.id === "pad_clear")?.status === "done", 1500);
    expect(t2.messages.length).toBeGreaterThan(before);
    t2.close();
  });

  it("a dropped stream reconnects to a full snapshot that has caught up with the clock", async () => {
    const first = b.stream(`/m/${code}/stream`);
    const v1 = await first.waitFor((m) => m.type === "views" && m.views.propulsion, 2000);
    const l1 = first.messages.find((m) => m.type === "lobby")!;
    expect(l1.phase).toBe("count");
    first.close();
    await sleep(1500); // the countdown keeps running while nobody is connected

    const second = b.stream(`/m/${code}/stream`);
    const l2 = await second.waitFor((m) => m.type === "lobby", 2000);
    const v2 = await second.waitFor((m) => m.type === "views", 2000);
    expect(second.messages.slice(0, 2).map((m) => m.type)).toEqual(["lobby", "views"]); // lobby then views, first
    expect(Object.keys(v2.views)).toEqual(["propulsion"]);
    expect(l2.seats).toEqual(l1.seats);
    const advanced = l2.tMs - l1.tMs;
    expect(advanced).toBeGreaterThanOrEqual(1400);
    expect(advanced).toBeLessThan(4000);
    expect(v2.views.propulsion.tMs).toBeGreaterThan(v1.views.propulsion.tMs + 1300);
    second.close();
  });

  it("only one row per accepted action reaches the replay", async () => {
    expect((await a.act(code, { role: "flight", type: "scrub" })).body.ok).toBe(true);
    const replay = (await a.get(`/missions/${code}`)).text;
    expect(replay.match(/class="ev k-step_done"/g)).toHaveLength(2); // arm_retract once, pad_clear once
    expect(replay.match(/class="ev k-start"/g)).toHaveLength(1);
  });
});

describe("garbage and oversized input", () => {
  let code = "";
  beforeAll(async () => {
    code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
    for (const role of ["flight", "propulsion", "ground"]) await a.post(`/m/${code}/seat`, { role });
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
  });
  afterAll(async () => {
    await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
  });

  const alive = async (): Promise<void> => expect((await fetch(new URL("/", baseUrl))).status).toBe(200);

  /** POST over a socket of its own (no pooling), streaming `chunks` of 64 KB. Resolves with the status, or "reset" if the server hung up first. */
  const upload = (path: string, chunks: number, chunked: boolean): Promise<number | "reset"> =>
    new Promise((resolve) => {
      const chunk = Buffer.from("a=" + "x".repeat(65_534));
      const req = request(new URL(path, baseUrl), {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(chunked ? {} : { "content-length": String(chunk.length * chunks) }),
        },
      });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", () => resolve("reset"));
      for (let n = 0; n < chunks; n++) req.write(chunk);
      req.end();
    });


  it("a body over 16 KB on /act or /crew is refused with 413, not read", async () => {
    const over = "x".repeat(64 * 1024);
    expect((await a.post(`/m/${code}/act`, { role: "flight", type: "hold", stepId: over })).status).toBe(413);
    const fresh = new Client(baseUrl);
    await fresh.csrfToken(); // a page and cookie, but no crew
    expect((await fresh.post("/crew", { callsign: over })).status).toBe(413);
    await alive();
  });

  it("a 1 MB body is refused, declared or chunked (413, or hung up on mid-upload), and the server survives", async () => {
    for (const chunked of [false, true]) {
      for (const path of [`/m/${code}/act`, "/crew"]) {
        const r = await upload(path, 16, chunked);
        expect(r === 413 || r === "reset", `${path} chunked=${chunked}: ${r}`).toBe(true);
      }
    }
    await alive();
  });

  it("garbage role, type, stepId, pollId and report never reach a 500", async () => {
    const cases: Record<string, string>[] = [
      { role: "../../etc", type: "step", stepId: "arm_retract" },
      { role: "FLIGHT", type: "hold" },
      { role: "", type: "hold" },
      { role: "flight" },
      { role: "flight", type: "drop table missions" },
      { role: "ground", type: "step" },
      { role: "ground", type: "step", stepId: "nope" },
      { role: "ground", type: "step", stepId: "a".repeat(65) },
      { role: "ground", type: "step", stepId: "arm_retract\u0000" },
      { role: "ground", type: "step", stepId: "__proto__" },
      { role: "ground", type: "step", stepId: "constructor" },
      { role: "propulsion", type: "poll_report", pollId: "poll_1", report: "maybe" },
      { role: "propulsion", type: "poll_report", pollId: "toString", report: "go" },
      { role: "flight", type: "poll_open", pollId: "{}" },
      { role: "flight", type: "constructor" },
    ];
    for (const fields of cases) {
      const r = await a.act(code, fields);
      expect(r.status, JSON.stringify(fields)).toBeLessThan(500);
      if (r.status === 200 && fields["role"] !== "flight") expect(r.body.ok, JSON.stringify(fields)).toBe(false);
    }
    await sleep(1100); // /act allows 20 a second per crew; stay under it so these are answered, not limited
    // the same, in forms the app never sends
    for (const [type, body] of [["application/json", "{not json"], ["multipart/form-data; boundary=zz", "--zz\r\ngarbage"], ["text/plain", "role=flight"]] as const) {
      const res = await a.fetch(`/m/${code}/act`, { method: "POST", headers: { "content-type": type }, body });
      expect(res.status, type).toBeLessThan(500);
    }
    await sleep(1100);
    for (const path of ["/m/%00/act", "/m/<script>/act", "/m/ZZZZZ/act", "/m/zzzzz/stream", `/missions/%25`, "/m/../act"]) {
      expect((await a.post(path, { role: "flight", type: "hold" })).status, path).toBeLessThan(500);
    }
    await alive();
    await sleep(1100);
    // and the mission is intact: the real hold at the end still works
    expect((await a.act(code, { role: "flight", type: "hold" })).body.ok).toBe(true);
  });
});

// Last, because it uses up the crew's allowance for the next few seconds.
describe("a script hammering the server", () => {
  let code = "";
  beforeAll(async () => {
    code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
    for (const role of ["flight", "propulsion", "ground"]) await a.post(`/m/${code}/seat`, { role });
    await sleep(1100); // a fresh per-second window
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
  });
  afterAll(async () => {
    await sleep(1100); // the per-second window
    await a.act(code, { role: "flight", type: "scrub" }).catch(() => {});
  });

  it("is told to slow down with a 429 on /act, and real play still works a moment later", async () => {
    await a.csrfToken();
    const burst = await Promise.all(Array.from({ length: 80 }, () => a.act(code, { role: "flight", type: "hold" })));
    const limited = burst.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.body.ok).toBe(false);
    expect(limited[0]!.body.error).toMatch(/slow down/);
    expect(burst.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    await sleep(1100);
    expect((await a.act(code, { role: "flight", type: "resume" })).status).toBe(200);
  });

  it("is told to slow down on /missions after ten a minute", async () => {
    const lobbies: number[] = [];
    for (let i = 0; i < 12; i++) lobbies.push((await a.post("/missions")).status);
    expect(lobbies.filter((s) => s === 303).length).toBeLessThanOrEqual(10);
    expect(lobbies).toContain(429);
  });
});
