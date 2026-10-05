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

/** Collects `activity` events from the SSE stream until closed. */
async function listen() {
  const ac = new AbortController();
  const events: any[] = [];
  const res = await fetch(url("/events?topic=activity"), { signal: ac.signal });
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
  return { events, waitFor, close: () => ac.abort() };
}

async function signedUp() {
  const c = client();
  const handle = `act_${run}_${Math.random().toString(36).slice(2, 6)}`;
  const r = await c.post("/signup", { handle, password: "correct horse battery", display_name: handle, postcode: "2600" });
  expect(r.status).toBeLessThan(400);
  return c;
}

const MARK = `SECRETBODY${run}`;
const fields = (title: string, status?: string) => ({
  title, summary: "A short summary", body: `${MARK} long details`, skills: "welding", postcode: "2600", category: "other", pledge: "1",
  ...(status ? { status, recruiting: "1" } : {}),
});

it("announces posted and finished (once), without body text", async () => {
  const c = await signedUp();
  const l = await listen();
  try {
    const title = `Activity project ${run}`;
    const r = await c.post("/projects/new", fields(title));
    expect(r.status).toBe(302);
    const id = r.headers.get("location")!.split("/").pop()!;
    const posted = await l.waitFor((e) => e.data?.kind === "project-posted" && e.data.text.includes(title));
    expect(posted).toBeTruthy();
    expect(posted.data.text).toContain(title);

    expect((await c.post(`/projects/${id}/edit`, fields(title, "in_progress"), `/projects/${id}/edit`)).status).toBe(302);
    expect(await l.waitFor((e) => e.data?.kind === "project-started" && e.data.text.includes(title))).toBeTruthy();
    expect((await c.post(`/projects/${id}/edit`, fields(title, "done"), `/projects/${id}/edit`)).status).toBe(302);
    expect(await l.waitFor((e) => e.data?.kind === "project-finished" && e.data.text.includes(title))).toBeTruthy();
    expect((await c.post(`/projects/${id}/edit`, fields(title, "done"), `/projects/${id}/edit`)).status).toBe(302);
    await new Promise((r) => setTimeout(r, 300));
    expect(l.events.filter((e) => e.data?.kind === "project-finished" && e.data.text.includes(title))).toHaveLength(1);
    expect(JSON.stringify(l.events)).not.toContain(MARK);
  } finally { l.close(); }
});

it("serves /resources with external links", async () => {
  const res = await fetch(url("/resources"));
  expect(res.status).toBe(200);
  const text = await res.text();
  const links = text.match(/<a href="https?:\/\/[^"]+" rel="noopener"/g) ?? [];
  expect(links.length).toBeGreaterThanOrEqual(8);
});
