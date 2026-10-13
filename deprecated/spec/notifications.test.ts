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
type C = Awaited<ReturnType<typeof signedUp>>;
async function openProject(c: C, title: string) {
  const res = await c.post("/projects/new", { title, summary: "s", body: "", skills: "welding", postcode: "2601", category: "other", pledge: "1" });
  const id = res.headers.get("location")!.split("/")[2];
  expect((await c.post(`/projects/${id}/edit`, { title, summary: "s", body: "", skills: "welding", postcode: "2601", category: "other", status: "open", recruiting: "1", pledge: "1" }, `/projects/${id}/edit`)).status).toBe(302);
  return id;
}
const unread = async (c: C) => Number((await (await c.req("/")).text()).match(/class="unread-count" data-count="(\d+)"/)![1]);
const SECRET = "secret-body-text-xyz";

let A: C;
let B: C;
let pid = "";
let aId = "";
let nid = "";

it("setup", async () => {
  A = await signedUp("ntA");
  B = await signedUp("ntB");
  pid = await openProject(A, `Notify ${run}`);
  aId = (await (await A.req("/me/requests")).text()).match(/data-user-id="(\d+)"/)![1];
});

it("B's join request lands in A's inbox and unread count; body is not in the text", async () => {
  expect(await unread(A)).toBe(0);
  expect((await B.post(`/projects/${pid}/requests`, { message: SECRET }, `/projects/${pid}`)).status).toBe(302);
  const inbox = await (await A.req("/inbox")).text();
  expect(inbox).toContain(`@ntb_${run} asked to join Notify ${run}`);
  expect(inbox).not.toContain(SECRET);
  expect(inbox).toContain('class="notification unread"');
  expect(await unread(A)).toBe(1);
  nid = inbox.match(/\/inbox\/(\d+)\/open/)![1];
});

it("real-time: a notification event arrives with data.unread", async () => {
  const D = await signedUp("ntD");
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
    expect((await D.post(`/projects/${pid}/requests`, { message: "live" }, `/projects/${pid}`)).status).toBe(302);
    await read(/"type":"notification"/, 1000);
    const m = buf.match(/"unread":(\d+)/)!;
    expect(Number(m[1])).toBeGreaterThanOrEqual(1);
  } finally {
    ac.abort();
  }
});

it("A accepting tells B (request-decided)", async () => {
  const reqs = await (await A.req(`/projects/${pid}/requests`)).text();
  const m = [...reqs.matchAll(/\/requests\/(\d+)\/accept/g)].map((x) => x[1]);
  const rid = m.sort((a, b) => Number(a) - Number(b))[0];
  expect((await A.post(`/projects/${pid}/requests/${rid}/accept`, {}, `/projects/${pid}/requests`)).status).toBe(302);
  const inbox = await (await B.req("/inbox")).text();
  expect(inbox).toContain(`Your request to join Notify ${run} was accepted`);
  expect(await unread(B)).toBe(1);
});

it("opening marks read and redirects to the project; others get 404", async () => {
  expect((await B.req(`/inbox/${nid}/open`)).status).toBe(404);
  const res = await A.req(`/inbox/${nid}/open`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/projects/${pid}/requests`);
  expect(await unread(A)).toBe(1);
});

it("mark all read zeroes the count", async () => {
  expect((await A.post("/inbox/read-all", {}, "/inbox")).status).toBe(302);
  expect(await unread(A)).toBe(0);
});

it("acting on your own content creates no notification", async () => {
  const before = await unread(A);
  const qres = await A.post("/questions/new", { title: `Own q ${run}`, body: "a body that is certainly long enough to pass", skills: "", pledge: "1" });
  expect(qres.status).toBe(302);
  const qpath = qres.headers.get("location")!;
  expect((await A.post(`${qpath}/answers`, { body: "answering my own question here", pledge: "1" }, qpath)).status).toBe(302);
  expect(await unread(A)).toBe(before);
  // B answering does notify A
  expect((await B.post(`${qpath}/answers`, { body: "B answers the question now", pledge: "1" }, qpath)).status).toBe(302);
  expect(await unread(A)).toBe(before + 1);
});
