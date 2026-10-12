import { afterAll, describe, expect, inject, it } from "vitest";
import { Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function newMission(c: Client): Promise<string> {
  const res = await c.post("/missions");
  expect(res.status).toBe(303);
  return res.headers.get("location")!.replace("/m/", "");
}

const sections = (text: string) => {
  const i = text.indexOf('id="in-flight"');
  return { open: text.slice(text.indexOf('id="open-crews"'), i), flight: text.slice(i) };
};

describe("the hub", () => {
  const a = new Client(baseUrl), b = new Client(baseUrl), c = new Client(baseUrl);
  const nameA = uniqueCallsign("ha"), nameB = uniqueCallsign("hb"), nameC = uniqueCallsign("hc");
  afterAll(() => [a, b, c].forEach((x) => x.closeStreams()));

  it("an open lobby shows on a stranger's home page, then moves to In flight once started", async () => {
    await a.setCallsign(nameA);
    await b.setCallsign(nameB);
    const code = await newMission(a);
    await a.post(`/m/${code}/seat`, { role: "flight" });
    await a.post(`/m/${code}/seat`, { role: "ground" });
    const { open } = sections((await b.get("/")).text);
    expect(open).toContain(`data-code="${code}"`);
    expect(open).toContain(`href="/crew/${nameA}"`);
    expect(open).toContain(`href="/m/${code}"`);
    // someone with no callsign sees it too, read-only
    expect(sections((await new Client(baseUrl).get("/")).text).open).toContain(`data-code="${code}"`);

    await a.post(`/m/${code}/seat`, { role: "propulsion" });
    const after = sections((await b.get("/")).text);
    expect(after.open).not.toContain(`data-code="${code}"`);
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
    const flying = sections((await b.get("/")).text);
    expect(flying.flight).toContain(`data-code="${code}"`);
    expect(flying.flight).toContain("Watch");
    expect((await a.act(code, { role: "flight", type: "scrub" })).body.ok).toBe(true);
    expect(sections((await b.get("/")).text).flight).not.toContain(`data-code="${code}"`);
  });

  it("/hub/stream pushes a hub message within 1 s when someone takes a seat", async () => {
    const code = await newMission(a);
    const s = b.stream("/hub/stream");
    await s.waitFor((m) => m.type === "hello");
    await a.post(`/m/${code}/seat`, { role: "flight" });
    await s.waitFor((m) => m.type === "hub", 1000);
    expect(JSON.stringify(s.messages)).not.toMatch(/callsign|role|seat/);
  });

  it("quick join seats the caller in some open lobby and redirects to it", async () => {
    const code = await newMission(a);
    await a.post(`/m/${code}/seat`, { role: "flight" });
    await a.post(`/m/${code}/seat`, { role: "ground" });
    const res = await b.post("/quick-join");
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/^\/m\/[A-Z0-9]{5}$/);
    expect((await b.get(loc)).text).toContain(nameB);
    // joining again does not take a second seat
    expect((await b.post("/quick-join")).headers.get("location")).toBe(loc);
    // no callsign: bounced home
    expect((await new Client(baseUrl).post("/quick-join")).headers.get("location")).toBe("/");
  });

  it("two quick joins racing for the last seat never share a seat", async () => {
    await c.setCallsign(nameC);
    const fresh = [new Client(baseUrl), new Client(baseUrl)];
    const names = [uniqueCallsign("hx"), uniqueCallsign("hy")];
    await Promise.all(fresh.map((f, i) => f.setCallsign(names[i]!)));
    const code = await newMission(a);
    await a.post(`/m/${code}/seat`, { role: "flight" });
    await a.post(`/m/${code}/seat`, { role: "ground" });
    const locs = (await Promise.all(fresh.map((f) => f.post("/quick-join")))).map((r) => r.headers.get("location")!);
    locs.forEach((l) => expect(l).toMatch(/^\/m\/[A-Z0-9]{5}$/));
    // the lobby had one free seat, so at most one of them is in it
    expect(locs.filter((l) => l === `/m/${code}`).length).toBeLessThanOrEqual(1);
    for (let i = 0; i < 2; i++) expect((await fresh[i]!.get(locs[i]!)).text).toContain(names[i]!);
    if (locs[0] === locs[1]) {
      // same lobby: two distinct seats, both callsigns shown
      const text = (await a.get(locs[0]!)).text;
      expect(text).toContain(names[0]!);
      expect(text).toContain(names[1]!);
    }
  });
});
