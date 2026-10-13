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
  async function post(path: string, fields: Record<string, string>, formPage = path) {
    const m = (await (await req(formPage)).text()).match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no csrf field on ${formPage}`);
    const body = new URLSearchParams(fields);
    body.set("_csrf", m[1]);
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  return { req, post };
}

const owner = client();
const titles = { canberra: `Region ACT ${run}`, queanbeyan: `Region Queanbeyan ${run}`, sydney: `Region Sydney ${run}`, wagga: `Region Wagga ${run}` };
const base = { summary: "s", body: "", skills: "", pledge: "1", category: "other" };

it("assigns projects to regions by postcode", async () => {
  expect((await owner.post("/signup", { handle: `regions_${run}`, password: "correct horse battery", dob: "1990-01-01", safety_ok: "1" })).status).toBe(302);
  const make = async (title: string, postcode: string) => {
    const res = await owner.post("/projects/new", { ...base, title, postcode }, "/projects/new");
    expect(res.status).toBe(302);
    return res.headers.get("location")!;
  };
  await make(titles.canberra, "2601");
  await make(titles.queanbeyan, "2620");
  await make(titles.sydney, "2000");
  await make(titles.wagga, "2650");
});

const listing = async (slug: string) => (await client().req(`/regions/${slug}`)).text();

it("puts 2601 and 2620 in canberra, 2000 in sydney, 2650 in regional-nsw", async () => {
  const cbr = await listing("canberra");
  expect(cbr).toContain(titles.canberra);
  expect(cbr).toContain(titles.queanbeyan);
  expect(cbr).not.toContain(titles.sydney);
  expect(await listing("sydney")).toContain(titles.sydney);
  const nsw = await listing("regional-nsw");
  expect(nsw).toContain(titles.wagga);
  expect(nsw).not.toContain(titles.canberra);
  expect(await listing("canberra")).not.toContain(titles.wagga);
});

it("filters browse by region", async () => {
  const text = await (await client().req("/?region=canberra&near=&go=1")).text();
  expect(text).toContain(titles.canberra);
  expect(text).not.toContain(titles.sydney);
  expect(await (await client().req("/?region=sydney&near=&go=1")).text()).toContain(titles.sydney);
});

it("a chosen region wins over near", async () => {
  const text = await (await client().req("/?region=canberra&near=2000&km=5&go=1")).text();
  expect(text).toContain(titles.canberra);
  expect(text).toContain("not applied");
});

it("shows region index and page with a lobbies section", async () => {
  expect((await client().req("/regions")).status).toBe(200);
  const res = await client().req("/regions/canberra");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<section id="lobbies">');
  expect((await client().req("/regions/nope")).status).toBe(404);
});

const crgTitle = `Rocket club build ${run}`;

it("lists rocketry projects and both club links on /c/rocketry", async () => {
  const res = await owner.post("/projects/new", { ...base, title: crgTitle, postcode: "2601", category: "rocketry" }, "/projects/new");
  expect(res.status).toBe(302);
  const text = await (await client().req("/c/rocketry")).text();
  expect(text).toContain(crgTitle);
  expect(text).toContain('href="https://crg.tidyhq.com/"');
  expect(text).toContain('href="https://nswrocketry.org.au/"');
  expect(text).toContain('rel="noopener" target="_blank"');
  expect(text).toContain('<section id="lobby">');
  expect(await (await client().req("/c/rocketry?region=sydney")).text()).not.toContain(crgTitle);
  expect(await (await client().req("/c/rocketry?region=canberra")).text()).toContain(crgTitle);
  expect(await (await client().req("/?category=rocketry&near=&go=1")).text()).toContain(crgTitle);
  expect(await (await client().req("/?category=robotics&near=&go=1")).text()).not.toContain(crgTitle);
  expect(await (await client().req("/regions/canberra?category=rocketry")).text()).toContain(crgTitle);
});

it("rejects a project without a valid category", async () => {
  const { category: _, ...fields } = { ...base, title: `No category ${run}`, postcode: "2601" };
  expect((await owner.post("/projects/new", fields, "/projects/new")).status).toBe(400);
  expect((await owner.post("/projects/new", { ...fields, category: "nope" }, "/projects/new")).status).toBe(400);
});

it("serves the category index and 404s unknown slugs", async () => {
  expect((await client().req("/c")).status).toBe(200);
  expect((await client().req("/c/nope")).status).toBe(404);
});
