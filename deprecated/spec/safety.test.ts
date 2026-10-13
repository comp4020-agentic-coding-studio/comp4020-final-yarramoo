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
// Today's date in Sydney, as the server sees it, shifted by whole years.
const sydney = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const yearsAgo = (n: number, dayOffset = 0) => {
  const d = new Date(`${Number(sydney.slice(0, 4)) - n}${sydney.slice(4)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};
const signupFields = (name: string, extra: Record<string, string> = {}) => ({ handle: `${name}_${run}`, password: pw, dob: "1990-01-01", safety_ok: "1", ...extra });
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", signupFields(name), "/signup")).status).toBe(302);
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

it("/safety is public and carries the emergency number and the eSafety link", async () => {
  const res = await client().req("/safety");
  expect(res.status).toBe(200);
  const t = await res.text();
  expect(t).toContain("000");
  expect(t).toContain("https://www.esafety.gov.au/key-topics/staying-safe/online-dating");
  expect(t).toContain('href="/safety"'); // footer link
});

it("signup: 17 is refused, 18 today is fine, missing dob or unticked box is refused", async () => {
  const c = client();
  const minor = await c.post("/signup", signupFields("kid", { dob: yearsAgo(18, 1) }), "/signup");
  expect(minor.status).toBe(400);
  expect(await minor.text()).toContain("/safety#young-people");
  expect((await client().post("/signup", signupFields("kid2", { dob: yearsAgo(17) }), "/signup")).status).toBe(400);
  expect((await client().post("/signup", signupFields("adult18", { dob: yearsAgo(18) }), "/signup")).status).toBe(302);
  const noDob = signupFields("nodob") as Record<string, string>;
  delete noDob.dob;
  expect((await client().post("/signup", noDob, "/signup")).status).toBe(400);
  const noTick = signupFields("notick") as Record<string, string>;
  delete noTick.safety_ok;
  expect((await client().post("/signup", noTick, "/signup")).status).toBe(400);
  expect((await client().post("/signup", signupFields("future", { dob: yearsAgo(-1) }), "/signup")).status).toBe(400);
  expect((await client().post("/signup", signupFields("ancient", { dob: yearsAgo(121) }), "/signup")).status).toBe(400);
  const f = await client().req("/signup");
  expect(await f.text()).toContain('name="dob"');
});

it("no date of birth is ever shown back to anyone", async () => {
  const dob = "1987-06-05";
  const c = client();
  expect((await c.post("/signup", signupFields("dobless", { dob }), "/signup")).status).toBe(302);
  for (const p of ["/me", `/u/dobless_${run}`]) {
    const t = await (await c.req(p)).text();
    expect(t).not.toContain(dob);
    expect(t).not.toMatch(/date of birth|birthday/i);
  }
});

let A: C;
let B: C;
let ADMIN: C;
let pid = "";

it("setup", async () => {
  A = await signedUp("sfA");
  B = await signedUp("sfB");
  ADMIN = await signedUp("admin_test_sf");
  pid = await openProject(A, `Safety ${run}`);
});

it("report: B reports A's project; admin sees it and is notified; duplicates and own content are refused", async () => {
  const form = await B.req(`/report?type=project&id=${pid}`);
  expect(form.status).toBe(200);
  expect(await form.text()).toContain("Harassment or abuse");
  expect(await (await B.req(`/projects/${pid}`)).text()).toContain("/report?type=project");
  expect(await (await A.req(`/projects/${pid}`)).text()).not.toContain("/report?type=project");

  expect((await A.post("/report", { type: "project", id: pid, reason: "Spam" }, `/report?type=project&id=${pid}`)).status).toBe(403);
  expect((await B.post("/report", { type: "project", id: pid, reason: "Nonsense" }, `/report?type=project&id=${pid}`)).status).toBe(403);
  const ok = await B.post("/report", { type: "project", id: pid, reason: "Scam or money request", details: "PRIVATE-DETAIL" }, `/report?type=project&id=${pid}`);
  expect(ok.status).toBe(302);
  expect(ok.headers.get("location")).toBe(`/projects/${pid}`);
  expect((await B.post("/report", { type: "project", id: pid, reason: "Spam" }, `/report?type=project&id=${pid}`)).status).toBe(409);

  // No public trace.
  expect(await (await A.req(`/projects/${pid}`)).text()).not.toContain("PRIVATE-DETAIL");
  expect((await B.req("/admin/reports")).status).toBe(404);

  const adminPage = await ADMIN.req("/admin/reports");
  if (adminPage.status === 404) return; // server not started with ADMIN_HANDLES=admin_test_*
  const t = await adminPage.text();
  expect(t).toContain("PRIVATE-DETAIL");
  expect(t).toContain(`/projects/${pid}`);
  expect(t).toContain(`@sfb_${run}`);
  expect(await (await ADMIN.req("/inbox")).text()).toContain("safety report");
  const rid = t.match(new RegExp(`/admin/reports/(\\d+)/resolve`))![1];
  expect((await ADMIN.post(`/admin/reports/${rid}/resolve`, {}, "/admin/reports")).status).toBe(302);
});

it("block: A blocks B; B can't ask to join, B's answers stay silent and fold away for A; unblock restores", async () => {
  const bHandle = `sfb_${run}`;
  const aHandle = `sfa_${run}`;
  expect(await (await A.req(`/u/${bHandle}`)).text()).toContain(`/u/${bHandle}/block`);
  expect(await (await A.req(`/u/${aHandle}`)).text()).not.toContain("/block");
  expect((await A.post(`/u/${bHandle}/block`, {}, `/u/${bHandle}`)).status).toBe(302);
  expect(await (await A.req(`/u/${bHandle}`)).text()).toContain(`/u/${bHandle}/unblock`);

  const denied = await B.post(`/projects/${pid}/requests`, { message: "hello" }, `/projects/${pid}`);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain("can&#39;t request to join this project");

  const q = await A.post("/questions/new", { title: `Blocked question ${run}`, body: "A question body that is long enough to pass validation.", skills: "", pledge: "1" }, "/questions/new");
  const qid = q.headers.get("location")!.split("/")[2];
  const before = await unread(A);
  const ans = await B.post(`/questions/${qid}/answers`, { body: "B's answer, long enough to be valid.", pledge: "1" }, `/questions/${qid}`);
  expect(ans.status).toBe(302);
  expect(await unread(A)).toBe(before);
  const viewed = await (await A.req(`/questions/${qid}`)).text();
  expect(viewed).toContain("Hidden: you blocked this member");
  expect(viewed).toMatch(/<details class="blocked-hidden">[\s\S]*B&#39;s answer|<details class="blocked-hidden">[\s\S]*B's answer/);
  expect(await (await B.req(`/questions/${qid}`)).text()).not.toContain("Hidden: you blocked");
  expect(await (await A.req("/")).text()).toMatch(/data-blocked-ids="\d+"/);

  expect((await A.post(`/u/${bHandle}/unblock`, {}, `/u/${bHandle}`)).status).toBe(302);
  expect((await B.post(`/projects/${pid}/requests`, { message: "hello again" }, `/projects/${pid}`)).status).toBe(302);
  expect(await (await A.req(`/questions/${qid}`)).text()).not.toContain("Hidden: you blocked this member");
  await B.post(`/questions/${qid}/answers`, { body: "Another answer, long enough.", pledge: "1" }, `/questions/${qid}`);
  expect(await unread(A)).toBeGreaterThan(before);
});
