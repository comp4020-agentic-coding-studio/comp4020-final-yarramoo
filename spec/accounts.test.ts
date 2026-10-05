import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const url = (p: string) => new URL(p, baseUrl);
const run = Date.now().toString(36);

// Minimal cookie jar so each test acts as its own browser.
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
    const html = await (await req(path)).text();
    const m = html.match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no csrf field on ${path}`);
    return m[1];
  }
  async function post(path: string, fields: Record<string, string>, formPage = path, withCsrf = true) {
    const body = new URLSearchParams(fields);
    if (withCsrf) body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  return { req, post, jar };
}

const pw = "correct horse battery";

it("signs up, shows handle on /me, logs out, rejects wrong password, logs in", async () => {
  const handle = `alice_${run}`;
  const c = client();
  const res = await c.post("/signup", { handle, password: pw, postcode: "2600" });
  expect(res.status).toBe(302);
  expect(c.jar.has("sid")).toBe(true);
  expect(await (await c.req("/me")).text()).toContain(handle);

  const out = await c.post("/logout", {}, "/me");
  expect(out.status).toBe(302);
  expect((await c.req("/me")).status).toBe(302);

  const bad = await c.post("/login", { handle, password: "wrong-password" }, "/login");
  expect(bad.status).toBe(400);
  expect(c.jar.has("sid")).toBe(false);

  const good = await c.post("/login", { handle, password: pw, next: "/me" }, "/login");
  expect(good.status).toBe(302);
  expect(good.headers.get("location")).toBe("/me");
  expect(await (await c.req("/me")).text()).toContain(handle);
});

it("rejects POSTs without a CSRF token", async () => {
  const c = client();
  const res = await c.post("/signup", { handle: `nocsrf_${run}`, password: pw }, "/signup", false);
  expect(res.status).toBe(403);
  const prof = await c.req(`/u/nocsrf_${run}`);
  expect(prof.status).toBe(404);
});

it("rejects a duplicate handle", async () => {
  const handle = `dupe_${run}`;
  expect((await client().post("/signup", { handle, password: pw })).status).toBe(302);
  expect((await client().post("/signup", { handle: handle.toUpperCase(), password: pw })).status).toBe(409);
});

it("does not redirect to off-site next", async () => {
  const handle = `next_${run}`;
  await client().post("/signup", { handle, password: pw });
  const c = client();
  const res = await c.post("/login", { handle, password: pw, next: "//evil.example" }, "/login");
  expect(res.headers.get("location")).toBe("/");
});
