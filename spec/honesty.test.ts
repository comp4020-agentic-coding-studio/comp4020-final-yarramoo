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
  async function upload(path: string, fields: Record<string, string>, formPage: string) {
    const fd = new FormData();
    fd.set("_csrf", await csrf(formPage));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return req(path, { method: "POST", body: fd });
  }
  return { req, post, upload };
}
type C = ReturnType<typeof client>;

const pw = "correct horse battery";
async function signedUp(handle: string) {
  const c = client();
  expect((await c.post("/signup", { handle, password: pw })).status).toBe(302);
  return c;
}

type Items = { items: { type: string; id: number; label: string }[] };
const labels = async (c: C) => (await (await c.req("/provenance.json")).json()) as Items;
const labelOf = async (c: C, type: string, id: string) => (await labels(c)).items.find((i) => i.type === type && i.id === Number(id))?.label;

const prose = "word ".repeat(200); // 1000 chars
const title = `Honesty question ${run} about flux`;
let A: C;
let B: C;
let qid = "";

it("setup", async () => {
  A = await signedUp(`honA_${run}`);
  B = await signedUp(`honB_${run}`);
});

it("the pledge is required on questions, answers, projects and updates", async () => {
  const q = { title, body: prose, skills: "" };
  expect((await A.post("/questions/new", q)).status).toBe(400);
  const ok = await A.post("/questions/new", { ...q, pledge: "1" });
  expect(ok.status).toBe(302);
  qid = ok.headers.get("location")!.split("/")[2];

  const ans = (extra: Record<string, string>) => B.post(`/questions/${qid}/answers`, { body: "An answer in my own words.", ...extra }, `/questions/${qid}`);
  expect((await ans({})).status).toBe(400);
  expect((await ans({ pledge: "1" })).status).toBe(302);

  const proj = { title: `Pledge project ${run}`, summary: "s", body: "", skills: "", postcode: "2601", category: "other" };
  expect((await A.post("/projects/new", proj)).status).toBe(400);
  const p = await A.post("/projects/new", { ...proj, pledge: "1" });
  expect(p.status).toBe(302);
  const pid = p.headers.get("location")!.split("/")[2];
  expect((await A.post(`/projects/${pid}/edit`, { ...proj, status: "open", recruiting: "1" }, `/projects/${pid}/edit`)).status).toBe(400);

  const page = `/projects/${pid}`;
  expect((await A.upload(`${page}/updates`, { body: "Progress" }, page)).status).toBe(400);
  expect((await A.upload(`${page}/updates`, { body: "Progress", pledge: "1" }, page)).status).toBe(302);
});

it("forms carry the positive pledge and no AI wording", async () => {
  const text = await (await A.req("/questions/new")).text();
  expect(text).toContain("I wrote this in my own words.");
  expect(text).not.toContain("without AI");
});

it("a pasted-heavy answer leaves no public wording on the page", async () => {
  const res = await B.post(`/questions/${qid}/answers`, { body: prose, pledge: "1", prov_typed: "10", prov_pasted_prose: "900", prov_active_ms: "3000", prov_paste_events: "1", prov_deletions: "0" }, `/questions/${qid}`);
  expect(res.status).toBe(302);
  const text = (await (await A.req(`/questions/${qid}`)).text()).toLowerCase();
  expect(text).not.toContain("pasted text");
  expect(text).not.toContain("flag");
  expect(text).not.toContain("machine-written");
});

it("labels come from behaviour: pasted, typed, unknown", async () => {
  const post = async (fields: Record<string, string>) => {
    const res = await B.post(`/questions/${qid}/answers`, { body: prose, pledge: "1", ...fields }, `/questions/${qid}`);
    return res.headers.get("location")!.split("#answer-")[1];
  };
  const fast = await post({ prov_typed: "0", prov_pasted_prose: "1000", prov_active_ms: "3000", prov_paste_events: "1", prov_deletions: "0" });
  const slow = await post({ prov_typed: "1000", prov_pasted_prose: "0", prov_active_ms: "300000", prov_paste_events: "0", prov_deletions: "80" });
  const none = await post({});
  expect(await labelOf(A, "answer", fast)).toBe("pasted");
  expect(await labelOf(A, "answer", slow)).toBe("typed");
  expect(await labelOf(A, "answer", none)).toBe("unknown");
});

it("non-admins get 404 for /admin/signals", async () => {
  expect((await A.req("/admin/signals")).status).toBe(404);
  expect((await client().req("/admin/signals")).status).toBe(404);
});

it("admin review: hide, author sees a calm note, unhide restores", async () => {
  const admin = await signedUp(`admin_test_${run}`);
  if ((await admin.req("/admin/signals")).status === 404) {
    console.log("admin tests skipped: server was not started with ADMIN_HANDLES=admin_test_*");
    return;
  }
  const hid = await A.post("/questions/new", {
    title: `Hide me ${run} please`, body: prose, pledge: "1",
    prov_typed: "0", prov_pasted_prose: "1000", prov_active_ms: "2000", prov_paste_events: "1", prov_deletions: "0",
  });
  const id = hid.headers.get("location")!.split("/")[2];
  const listing = await (await admin.req("/admin/signals")).text();
  expect(listing).toContain(`href="/questions/${id}"`);

  expect((await admin.post(`/admin/signals/question/${id}/hide`, { show: "unreviewed" }, "/admin/signals")).status).toBe(302);
  expect((await B.req(`/questions/${id}`)).status).toBe(404);
  expect((await client().req(`/questions/${id}`)).status).toBe(404);
  const mine = await A.req(`/questions/${id}`);
  expect(mine.status).toBe(200);
  expect(await mine.text()).toContain("This post is under review.");
  expect(await (await B.req("/questions")).text()).not.toContain(`/questions/${id}"`);
  expect((await labels(B)).items.some((i) => i.type === "question" && i.id === Number(id))).toBe(false);
  expect(await (await admin.req("/admin/signals?show=hidden")).text()).toContain(`href="/questions/${id}"`);

  expect((await B.post(`/admin/signals/question/${id}/unhide`, {}, "/questions/new").catch(() => ({ status: 0 }))).status).not.toBe(302);
  expect((await admin.post(`/admin/signals/question/${id}/unhide`, { show: "hidden" }, "/admin/signals")).status).toBe(302);
  expect((await B.req(`/questions/${id}`)).status).toBe(200);
  expect(await (await B.req("/questions")).text()).toContain(`/questions/${id}"`);
  expect((await labels(B)).items.some((i) => i.type === "question" && i.id === Number(id))).toBe(true);
});
