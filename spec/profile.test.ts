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
  expect((await c.post("/signup", { handle, password: pw, dob: "1990-01-01", safety_ok: "1" })).status).toBe(302);
  return c;
}


const text = (r: Response) => r.text();
const qFields = (t: string) => ({ title: t, body: "A question body long enough to pass the minimum length check.", skills: "", pledge: "1" });
const pf = (extra: Record<string, string> = {}) => ({ display_name: "Pat", postcode: "", skills: "", background: "", interests: "", ...extra });

it("saves background and interests with a pledge and shows them escaped", async () => {
  const handle = `prof_${run}`;
  const c = await signedUp(handle);
  const bg = "Studied <script>alert(1)</script> engineering";
  expect((await c.post("/me", pf({ background: bg, interests: "kilns" }))).status).toBe(400);
  expect((await c.post("/me", pf({ background: bg, interests: "kilns", pledge: "1" }), "/me")).status).toBe(302);
  const me = await text(await c.req("/me"));
  expect(me).toContain("what you've studied");
  expect(me).toContain("data-provenance");
  const pub = await text(await client().req(`/u/${handle}`));
  expect(pub).toContain("Studied &lt;script&gt;alert(1)&lt;/script&gt; engineering");
  expect(pub).not.toContain("<script>alert(1)");
  expect(pub).toContain("kilns");
  expect(pub).not.toMatch(/<img/i);
  // unchanged text needs no pledge; changing it does
  expect((await c.post("/me", pf({ background: bg, interests: "kilns", display_name: "Pat 2" }), "/me")).status).toBe(302);
  expect((await c.post("/me", pf({ background: bg + " more", interests: "kilns" }), "/me")).status).toBe(400);
});

it("awards: founder and first build from a finished project", async () => {
  const handle = `founder_${run}`;
  const c = await signedUp(handle);
  const f = { title: `Award project ${run}`, summary: "s", body: "", skills: "", postcode: "2601", category: "other", pledge: "1" };
  const res = await c.post("/projects/new", f);
  const pid = res.headers.get("location")!.split("/")[2];
  const edit = `/projects/${pid}/edit`;
  expect((await c.post(edit, { ...f, status: "in_progress", recruiting: "1" })).status).toBe(302);
  expect((await c.post(edit, { ...f, status: "done", recruiting: "1" })).status).toBe(302);
  const pub = await text(await client().req(`/u/${handle}`));
  expect(pub).toContain("award-founder");
  expect(pub).toContain("Founder");
  expect(pub).toContain("First build");
  expect(pub).toContain("Finisher");
  expect(pub).not.toContain("Team player");
});

let solver: C;
let asker: C;
let solverHandle = "";
let qid = "";
let aid = "";

it("awards: an accepted answer earns Solved it", async () => {
  solverHandle = `solver_${run}`;
  solver = await signedUp(solverHandle);
  asker = await signedUp(`asker_${run}`);
  const q = await asker.post("/questions/new", qFields(`Which glaze for kiln ${run}?`));
  qid = q.headers.get("location")!.split("/")[2];
  const a = await solver.post(`/questions/${qid}/answers`, { body: "Use the cone six glaze.", pledge: "1" }, `/questions/${qid}`);
  aid = a.headers.get("location")!.split("#answer-")[1];
  expect(await text(await client().req(`/u/${solverHandle}`))).not.toContain("Solved it");
  expect((await asker.post(`/questions/${qid}/accept/${aid}`, {}, `/questions/${qid}`)).status).toBe(302);
  const pub = await text(await client().req(`/u/${solverHandle}`));
  expect(pub).toContain("Solved it");
  expect(pub).toContain("1 answer accepted");
  expect(pub).toContain("Recent answers");
  expect(pub).toContain(`Which glaze for kiln ${run}?`);
});

it("awards: hidden content does not count (admin path)", async () => {
  const admin = await signedUp(`admin_test_prof_${run}`);
  if ((await admin.req("/admin/signals")).status === 404) {
    console.log("hidden-award test skipped: server was not started with ADMIN_HANDLES=admin_test_*");
    return;
  }
  expect((await admin.post(`/admin/signals/answer/${aid}/hide`, { show: "unreviewed" }, "/admin/signals")).status).toBe(302);
  const pub = await text(await client().req(`/u/${solverHandle}`));
  expect(pub).not.toContain("Solved it");
  expect(pub).not.toContain(`Which glaze for kiln ${run}?`);
});
