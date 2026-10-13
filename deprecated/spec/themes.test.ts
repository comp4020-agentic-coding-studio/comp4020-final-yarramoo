import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const url = (p: string) => new URL(p, baseUrl);
const run = Date.now().toString(36);

function client() {
  const jar = new Map<string, string>();
  async function req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url(path), { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const [k, v] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
      if (v === "" || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    return res;
  }
  async function csrf(path: string): Promise<string> {
    const m = (await (await req(path)).text()).match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no csrf field on ${path}`);
    return m[1];
  }
  /** Fields may repeat: pass an array of values for a repeated key. */
  async function post(path: string, fields: Record<string, string | string[]>, formPage = path) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  return { req, post, cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}

const pw = "correct horse battery";
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", { handle: `${name}_${run}`, password: pw, dob: "1990-01-01", safety_ok: "1" })).status).toBe(302);
  return c;
}

const base = (title: string, extra: Record<string, string | string[]> = {}) => ({
  title, summary: "A themed build", body: "", skills: "", postcode: "2601", category: "electronics", pledge: "1", ...extra,
});
async function create(c: Awaited<ReturnType<typeof signedUp>>, title: string, themes: string[]) {
  const res = await c.post("/projects/new", base(title, { themes }));
  expect(res.status).toBe(302);
  return res.headers.get("location")!.split("/")[2];
}
const setStatus = (c: Awaited<ReturnType<typeof signedUp>>, id: string, title: string, status: string, themes: string[]) =>
  c.post(`/projects/${id}/edit`, base(title, { themes, status, recruiting: "1" }), `/projects/${id}/edit`);

const titleA = `Retro C64 ${run}`;
let owner: Awaited<ReturnType<typeof signedUp>>;
let voter: Awaited<ReturnType<typeof signedUp>>;
let pidA = "";

it("creates a project with 2 themes; chips shown and listed on /t/retro-computing", async () => {
  owner = await signedUp("thown");
  voter = await signedUp("thvote");
  pidA = await create(owner, titleA, ["retro-computing", "repair-and-reuse"]);
  const text = await (await owner.req(`/projects/${pidA}`)).text();
  expect(text).toContain('href="/t/retro-computing"');
  expect(text).toContain('href="/t/repair-and-reuse"');
  expect(await (await voter.req("/t/retro-computing")).text()).toContain(titleA);
  expect(await (await voter.req("/t")).text()).toContain("Retro computing");
});

it("rejects 4 themes and unknown themes", async () => {
  const four = await owner.post("/projects/new", base(`Too many ${run}`, { themes: ["retro-computing", "repair-and-reuse", "open-hardware", "citizen-science"] }));
  expect(four.status).toBe(400);
  const bad = await owner.post("/projects/new", base(`Bad theme ${run}`, { themes: ["nonsense"] }), "/projects/new");
  expect(bad.status).toBe(400);
});

it("toggles an upvote 0 -> 1 -> 0 and forbids upvoting your own project", async () => {
  const count = async (c: typeof voter) => (await (await c.req(`/projects/${pidA}`)).text()).match(/id="upvote-count">(\d+)</)![1];
  expect(await count(voter)).toBe("0");
  expect((await voter.post(`/projects/${pidA}/upvote`, {}, `/projects/${pidA}`)).status).toBe(302);
  expect(await count(voter)).toBe("1");
  expect(await (await voter.req(`/projects/${pidA}`)).text()).toContain('aria-pressed="true"');
  expect((await voter.post(`/projects/${pidA}/upvote`, {}, `/projects/${pidA}`)).status).toBe(302);
  expect(await count(voter)).toBe("0");
  expect((await owner.post(`/projects/${pidA}/upvote`, {}, `/projects/${pidA}`)).status).toBe(403);
});

it("ranks a done project before an open one with more upvotes", async () => {
  const done = `Done ranking ${run}`;
  const open = `Open ranking ${run}`;
  const d = await create(owner, done, ["assistive-tech"]);
  const o = await create(owner, open, ["assistive-tech"]);
  expect((await setStatus(owner, d, done, "in_progress", ["assistive-tech"])).status).toBe(302);
  expect((await setStatus(owner, d, done, "done", ["assistive-tech"])).status).toBe(302);
  expect((await voter.post(`/projects/${o}/upvote`, {}, `/projects/${o}`)).status).toBe(302);
  const text = await (await voter.req("/t/assistive-tech")).text();
  expect(text.indexOf(done)).toBeGreaterThan(-1);
  expect(text.indexOf(open)).toBeGreaterThan(-1);
  expect(text.indexOf(done)).toBeLessThan(text.indexOf(open));
  expect((await voter.req("/t/nope")).status).toBe(404);
});

it("moving to done lists it on /finished with a live event; reopening removes it", async () => {
  const t = `Finish me ${run}`;
  const id = await create(owner, t, ["open-hardware"]);
  expect((await setStatus(owner, id, t, "in_progress", ["open-hardware"])).status).toBe(302);
  const ac = new AbortController();
  const res = await fetch(url("/events?topic=feed"), { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const read = async (until: RegExp, ms: number) => {
    const deadline = Date.now() + ms;
    while (!until.test(buf)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${until}; got ${buf}`);
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
      if (r === null) continue;
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
    }
  };
  try {
    await read(/"type":"ready"/, 2000);
    expect((await setStatus(owner, id, t, "done", ["open-hardware"])).status).toBe(302);
    await read(/"type":"finished"/, 1000);
    expect(buf).toContain(t);
  } finally {
    ac.abort();
  }
  expect(await (await voter.req("/finished")).text()).toContain(t);
  expect(await (await voter.req("/")).text()).toContain(t); // newest finished is in the browse strip
  expect((await setStatus(owner, id, t, "in_progress", ["open-hardware"])).status).toBe(302);
  expect(await (await voter.req("/finished")).text()).not.toContain(t);
});
