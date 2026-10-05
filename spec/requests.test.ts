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
  async function post(path: string, fields: Record<string, string>, formPage = "/projects/new") {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return { req, post, cookie };
}

const pw = "correct horse battery";
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", { handle: `${name}_${run}`, password: pw, dob: "1990-01-01", safety_ok: "1" }, "/signup")).status).toBe(302);
  return c;
}
async function newProject(c: Awaited<ReturnType<typeof signedUp>>, title: string) {
  const res = await c.post("/projects/new", { title, summary: "s", body: "", skills: "welding", postcode: "2601", category: "other", pledge: "1" });
  expect(res.status).toBe(302);
  return res.headers.get("location")!.split("/")[2];
}

let A: Awaited<ReturnType<typeof signedUp>>;
let B: Awaited<ReturnType<typeof signedUp>>;
let p1 = "";
let p2 = "";
let aId = "";
let rid = "";

it("setup: A owns two recruiting projects", async () => {
  A = await signedUp("reqA");
  B = await signedUp("reqB");
  // new projects are created not recruiting; turn recruiting on via edit
  for (const t of ["One", "Two"]) {
    const id = await newProject(A, `Req ${t} ${run}`);
    const res = await A.post(`/projects/${id}/edit`, { title: `Req ${t} ${run}`, summary: "s", body: "", skills: "welding", postcode: "2601", category: "other", status: "open", recruiting: "1", pledge: "1" }, `/projects/${id}/edit`);
    expect(res.status).toBe(302);
    if (t === "One") p1 = id; else p2 = id;
  }
  aId = (await (await A.req("/me/requests")).text()).match(/data-user-id="(\d+)"/)![1];
});

it("signed-out visitors are told to log in", async () => {
  expect(await (await client().req(`/projects/${p1}`)).text()).toContain("Log in to ask to join");
});

it("B asks to join with skill welding; a duplicate is rejected", async () => {
  const page = await (await B.req(`/projects/${p1}`)).text();
  const sid = page.match(/<option value="(\d+)">welding<\/option>/)![1];
  const res = await B.post(`/projects/${p1}/requests`, { skill_id: sid, message: "I weld." }, `/projects/${p1}`);
  expect(res.status).toBe(302);
  expect(await (await B.req(`/projects/${p1}`)).text()).toContain("Your request is pending");
  const dup = await B.post(`/projects/${p1}/requests`, { skill_id: sid, message: "again" }, `/projects/${p1}`);
  expect(dup.status).toBe(409);
});

it("A's inbox lists B; B cannot open it", async () => {
  const inbox = await (await A.req(`/projects/${p1}/requests`)).text();
  expect(inbox).toContain(`@reqb_${run}`);
  expect(inbox).toContain("I weld.");
  rid = inbox.match(/\/requests\/(\d+)\/accept/)![1];
  expect((await B.req(`/projects/${p1}/requests`)).status).toBe(403);
  expect((await B.post(`/projects/${p1}/requests/${rid}/accept`, {}, `/projects/${p1}`)).status).toBe(403);
});

it("the owner is told how many requests are pending", async () => {
  expect(await (await A.req(`/projects/${p1}`)).text()).toMatch(/id="pending-count">1</);
});

it("escapes request messages in the inbox", async () => {
  const C = await signedUp("reqC");
  const res = await C.post(`/projects/${p2}/requests`, { message: "<script>alert(1)</script>" }, `/projects/${p2}`);
  expect(res.status).toBe(302);
  const inbox = await (await A.req(`/projects/${p2}/requests`)).text();
  expect(inbox).not.toContain("<script>alert(1)");
  expect(inbox).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

it("real-time: A receives a request event on user:<A>", async () => {
  const D = await signedUp("reqD");
  const ac = new AbortController();
  const res = await fetch(url(`/events?topic=user:${aId}`), { headers: { cookie: A.cookie() }, signal: ac.signal });
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
    expect((await D.post(`/projects/${p2}/requests`, { message: "live one" }, `/projects/${p2}`)).status).toBe(302);
    await read(/"type":"request"/, 1000);
    expect(buf).toContain("live one");
  } finally {
    ac.abort();
  }
});

it("accepting adds B to the team and fills welding; decided requests can't be re-decided", async () => {
  const res = await A.post(`/projects/${p1}/requests/${rid}/accept`, {}, `/projects/${p1}/requests`);
  expect(res.status).toBe(302);
  const text = await (await A.req(`/projects/${p1}`)).text();
  expect(text).toMatch(new RegExp(`id="team"[\\s\\S]*reqb_${run}`));
  expect(text).toContain(`filled by <a href="/u/reqb_${run}">@reqb_${run}</a>`);
  const mine = await (await B.req(`/projects/${p1}`)).text();
  expect(mine).toContain("You're on this team");
  expect(mine).not.toContain("Your request is pending");
  const inbox = await (await A.req(`/projects/${p1}/requests`)).text();
  expect(inbox).toMatch(/id="pending"[^>]*><\/ul>/);
  expect((await A.post(`/projects/${p1}/requests/${rid}/decline`, {}, `/projects/${p1}/requests`)).status).toBe(409);
  expect(await (await B.req("/me/requests")).text()).toContain("accepted");
});

it("a requester can withdraw a pending request", async () => {
  const E = await signedUp("reqE");
  await E.post(`/projects/${p2}/requests`, { message: "hmm" }, `/projects/${p2}`);
  const page = await (await E.req(`/projects/${p2}`)).text();
  const m = page.match(/\/requests\/(\d+)\/withdraw/)!;
  expect((await E.post(`/projects/${p2}/requests/${m[1]}/withdraw`, {}, `/projects/${p2}`)).status).toBe(302);
  expect(await (await E.req("/me/requests")).text()).toContain("withdrawn");
});
