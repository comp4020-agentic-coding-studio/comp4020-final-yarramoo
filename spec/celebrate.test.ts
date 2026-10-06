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
    if (!m) throw new Error(`no csrf on ${formPage}`);
    const body = new URLSearchParams({ ...fields, _csrf: m[1] });
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  return { req, post };
}

async function setup() {
  const c = client();
  const handle = `cel${run}${Math.random().toString(36).slice(2, 6)}`;
  const r = await c.post("/signup", { handle, password: "correct horse battery", dob: "1990-01-01", safety_ok: "1", display_name: handle, postcode: "2600" });
  expect(r.status).toBe(302);
  return c;
}

const fields = (title: string, extra: Record<string, string> = {}) => ({
  title, summary: "A celebration test project", body: "", skills: "", postcode: "2600", category: "other", pledge: "1", ...extra,
});

async function listenFeed() {
  const ac = new AbortController();
  const events: any[] = [];
  const res = await fetch(url("/events?topic=feed"), { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const e = JSON.parse(line.slice(5));
          if (e.type === "ready") ready(); else events.push(e);
        }
      }
    } catch { /* aborted */ }
  })();
  await readyP;
  const waitFor = async (pred: (e: any) => boolean, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 25)); }
    return undefined;
  };
  return { waitFor, close: () => ac.abort() };
}

it("celebrates a new project once, announces it live, and celebrates finishing once", async () => {
  const c = await setup();
  const title = `Celebrate ${run}${Math.random().toString(36).slice(2, 5)}`;
  const feed = await listenFeed();
  const created = await c.post("/projects/new", fields(title));
  expect(created.status).toBe(302);
  const loc = created.headers.get("location")!;
  const ev = await feed.waitFor((e) => e.type === "project-new" && String(e.html).includes(title));
  feed.close();
  expect(ev).toBeTruthy();

  expect(await (await c.req(loc)).text()).toContain('data-celebrate="posted"');
  expect(await (await c.req(loc)).text()).not.toContain("data-celebrate");

  // plain edit: no celebration
  const edit = (status: string) => c.post(`${loc}/edit`, fields(title, { status, recruiting: "1" }), `${loc}/edit`);
  expect((await edit("in_progress")).status).toBe(302);
  expect(await (await c.req(loc)).text()).not.toContain("data-celebrate");
  expect((await edit("in_progress")).status).toBe(302);
  expect(await (await c.req(loc)).text()).not.toContain("data-celebrate");

  expect((await edit("done")).status).toBe(302);
  expect(await (await c.req(loc)).text()).toContain('data-celebrate="finished"');
  expect(await (await c.req(loc)).text()).not.toContain("data-celebrate");
});
