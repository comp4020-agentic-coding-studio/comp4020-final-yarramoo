import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { Client, uniqueCallsign } from "./helpers.ts";

const baseUrl = inject("baseUrl");

describe("crew profiles", () => {
  const a = new Client(baseUrl);
  const name = uniqueCallsign("cx");
  const fresh = uniqueCallsign("cy");
  let live = "";
  let done = "";

  async function seated(): Promise<string> {
    const code = (await a.post("/missions")).headers.get("location")!.replace("/m/", "");
    for (const role of ["flight", "propulsion", "ground"]) expect((await a.post(`/m/${code}/seat`, { role })).status).toBe(303);
    expect((await a.act(code, { role: "flight", type: "start" })).body.ok).toBe(true);
    return code;
  }

  beforeAll(async () => {
    expect((await a.setCallsign(name)).status).toBe(303);
    expect((await new Client(baseUrl).setCallsign(fresh)).status).toBe(303);
    live = await seated();
    done = await seated();
    expect((await a.act(done, { role: "flight", type: "scrub" })).body.ok).toBe(true);
  });
  afterAll(async () => {
    await a.act(live, { role: "flight", type: "scrub" }).catch(() => {});
    a.closeStreams();
  });

  it("a new callsign has a profile with nothing flown; unknown is 404; lookup ignores case", async () => {
    const { res, text } = await a.get(`/crew/${fresh}`);
    expect(res.status).toBe(200);
    expect(text).toMatch(/id="flown">0</);
    expect((await a.get(`/crew/${fresh.toUpperCase()}`)).res.status).toBe(200);
    expect((await a.get("/crew/nobody_here_zz")).res.status).toBe(404);
    expect((await a.get("/crew/%3Cscript%3E")).res.status).toBe(404);
  });

  it("a scrubbed mission shows as flown, scrubbed and linked; the live one is absent", async () => {
    const { res, text } = await a.get(`/crew/${name}`);
    expect(res.status).toBe(200);
    expect(text).toMatch(/id="flown">1</);
    expect(text).toContain("1 scrubbed");
    expect(text).toContain(`href="/missions/${done}"`);
    expect(text).not.toContain(live);
    expect(text).toContain("Seats are attributed to whoever held them");
  });

  it("/crew lists them once, and a garbage sort falls back to the default", async () => {
    const { res, text } = await a.get("/crew?sort=%27%3Cb%3E");
    expect(res.status).toBe(200);
    expect(text).toContain("<title>Crew");
    expect(text.split(`<td><a class="callsign" href="/crew/${name}">`).length - 1).toBe(1);
    expect(text).not.toContain(`href="/crew/${fresh}"`);
    expect((await a.get("/crew?sort=spoke")).text).toContain(`href="/crew/${name}"`);
  });

  it("renders labels as text and links the header callsign", async () => {
    const { text } = await a.get(`/crew/${name}`);
    expect(text).not.toMatch(/<script(?![^>]*src)/i);
    expect(text).toContain("Kestrel-1");
    expect(text).toContain(`id="callsign" data-callsign="${name}" href="/crew/${name}"`);
  });
});
