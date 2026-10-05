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
  async function post(path: string, fields: Record<string, string>, formPage = path) {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  return { req, post };
}

const pw = "correct horse battery";
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", { handle: `${name}_${run}`, password: pw })).status).toBe(302);
  return c;
}

const title = `Rocket stove ${run}`;
let pid = "";
let owner: Awaited<ReturnType<typeof signedUp>>;
const fields = (extra: Record<string, string> = {}) => ({ title, summary: "A stove", body: "Line one\n\nLine two", skills: "welding, Arduino", postcode: "2601", status: "open", recruiting: "1", ...extra });

it("redirects signed-out /projects/new to /login", async () => {
  const res = await client().req("/projects/new");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toMatch(/^\/login/);
});

it("creates a project with skills", async () => {
  owner = await signedUp("owner");
  const res = await owner.post("/projects/new", fields());
  expect(res.status).toBe(302);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/projects\/\d+$/);
  pid = loc.split("/")[2];
  const text = await (await owner.req(loc)).text();
  expect(text).toContain(title);
  expect(text).toContain("welding");
  expect(text).toContain("arduino");
});

it("filters by distance", async () => {
  const c = client();
  expect(await (await c.req("/?near=2601&km=25")).text()).toContain(title);
  expect(await (await c.req("/?near=6000&km=25")).text()).not.toContain(title);
});

it("filters by skill", async () => {
  expect(await (await client().req("/?skill=welding&near=")).text()).toContain(title);
});

it("escapes user input", async () => {
  const t = `<script>alert(1)</script>${run}`;
  const res = await owner.post("/projects/new", fields({ title: t }));
  const text = await (await owner.req(res.headers.get("location")!)).text();
  expect(text).not.toContain("<script>alert(1)");
  expect(text).toContain("&lt;script&gt;");
});

it("forbids non-owners from editing", async () => {
  const other = await signedUp("other");
  expect((await other.post(`/projects/${pid}/edit`, fields(), `/projects/new`)).status).toBe(403);
});

it("enforces status transitions", async () => {
  const edit = `/projects/${pid}/edit`;
  expect((await owner.post(edit, fields({ status: "in_progress" }))).status).toBe(302);
  expect((await owner.post(edit, fields({ status: "archived" }))).status).toBe(400);
  expect((await owner.post(edit, fields({ status: "done" }))).status).toBe(302);
  expect((await owner.post(edit, fields({ status: "open" }))).status).toBe(400);
});

it("is visible to a fresh session", async () => {
  const res = await client().req(`/projects/${pid}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(title);
});
