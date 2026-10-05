import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const url = (p: string) => new URL(p, baseUrl);
const run = Date.now().toString(36);
const CAT = "garden-tech"; // teamSize 3
const LOBBY = `/lobbies/${CAT}/canberra`;

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
  async function post(path: string, fields: Record<string, string>, formPage = "/me") {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return { req, post, cookie };
}
type C = ReturnType<typeof client>;

const pw = "correct horse battery";
async function signedUp(name: string, postcode = "2601"): Promise<{ c: C; id: string; handle: string }> {
  const c = client();
  const handle = `${name}_${run}`;
  expect((await c.post("/signup", { handle, password: pw, postcode }, "/signup")).status).toBe(302);
  const id = (await (await c.req("/me/requests")).text()).match(/data-user-id="(\d+)"/)![1];
  return { c, id, handle };
}

let none: Awaited<ReturnType<typeof signedUp>>;
let syd: Awaited<ReturnType<typeof signedUp>>;
let u: Awaited<ReturnType<typeof signedUp>>[] = [];
let outsider: Awaited<ReturnType<typeof signedUp>>;
let pid = "";

it("joining needs a postcode and your own region", async () => {
  none = await signedUp("lbnone", "");
  syd = await signedUp("lbsyd", "2000");
  expect((await none.c.post(`${LOBBY}/join`, {})).status).toBe(400);
  expect((await syd.c.post(`${LOBBY}/join`, {})).status).toBe(403);
  expect((await syd.c.post("/lobbies/other/canberra/join", {})).status).toBe(404);
});

it("a note needs the pledge", async () => {
  u = [await signedUp("lb1"), await signedUp("lb2"), await signedUp("lb3")];
  expect((await u[0].c.post(`${LOBBY}/join`, { note: "I like tomatoes" })).status).toBe(400);
});

it("two joins form no team and the lobby shows 2 of 3", async () => {
  expect((await u[0].c.post(`${LOBBY}/join`, { note: "I like tomatoes", pledge: "1", skills: "plumbing" })).status).toBe(302);
  expect((await u[1].c.post(`${LOBBY}/join`, {})).status).toBe(302);
  expect((await u[1].c.post(`${LOBBY}/join`, {})).status).toBe(409);
  const page = await (await u[0].c.req(`/c/${CAT}`)).text();
  expect(page).toContain("2 of 3");
  expect(page).toContain(`@${u[0].handle}`);
  expect(await (await u[0].c.req("/lobbies")).text()).toContain("2 of 3 interested");
  expect(await (await u[0].c.req("/regions/canberra")).text()).toContain("2 of 3");
});

it("the third join forms a project with all three, pending a leader", async () => {
  const res = await u[2].c.post(`${LOBBY}/join`, {});
  expect(res.status).toBe(302);
  pid = res.headers.get("location")!.split("/")[2];
  const page = await (await u[1].c.req(`/projects/${pid}`)).text();
  expect(page).toContain("Electing a leader");
  for (const m of u) expect(page).toContain(`@${m.handle}`.slice(1));
  expect(page).toContain("Formed from the Garden tech lobby in Canberra");
  for (const m of u) expect(await (await m.c.req("/inbox")).text()).toContain("has formed: vote for a leader");
  expect(await (await u[0].c.req(`/c/${CAT}`)).text()).toContain("0 of 3");
});

it("the placeholder owner cannot edit while the vote is pending", async () => {
  expect((await u[0].c.req(`/projects/${pid}/edit`)).status).toBe(403);
  expect((await u[0].c.req(`/projects/${pid}/requests`)).status).toBe(403);
  expect(await (await u[0].c.req(`/projects/${pid}`)).text()).not.toContain(`/projects/${pid}/edit`);
});

it("a non-member cannot vote, and cannot vote for a non-member", async () => {
  outsider = await signedUp("lbout");
  expect((await outsider.c.post(`/projects/${pid}/vote`, { candidate: u[0].id }, `/projects/${pid}`)).status).toBe(403);
  expect((await u[0].c.post(`/projects/${pid}/vote`, { candidate: outsider.id }, `/projects/${pid}`)).status).toBe(400);
  expect(await (await outsider.c.req(`/projects/${pid}`)).text()).not.toContain('class="votes"');
});

it("a majority elects a leader (live), and a new majority transfers leadership", async () => {
  const vote = (who: number, cand: number) => u[who].c.post(`/projects/${pid}/vote`, { candidate: u[cand].id }, `/projects/${pid}`);
  const ac = new AbortController();
  const res = await fetch(url(`/events?topic=project:${pid}`), { signal: ac.signal });
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
    expect((await vote(0, 1)).status).toBe(302); // 1 of 3: no leader yet
    expect((await u[1].c.req(`/projects/${pid}/edit`)).status).toBe(403);
    expect(await (await u[1].c.req(`/projects/${pid}`)).text()).toContain("Electing a leader");
    expect((await vote(1, 1)).status).toBe(302); // 2 of 3 for u[1]
    await read(/"type":"leader"/, 1000);
    expect(buf).not.toContain("Electing a leader");
    expect((await u[1].c.req(`/projects/${pid}/edit`)).status).toBe(200);
    expect(await (await u[1].c.req(`/projects/${pid}`)).text()).not.toContain("Electing a leader");
    expect(await (await u[2].c.req("/inbox")).text()).toContain(`@${u[1].handle} is now the leader`);

    buf = "";
    expect((await vote(0, 2)).status).toBe(302); // 1 each: no majority, u[1] stays
    expect((await u[1].c.req(`/projects/${pid}/edit`)).status).toBe(200);
    expect((await vote(1, 2)).status).toBe(302); // 2 of 3 for u[2]
    await read(/"type":"leader"/, 1000);
    expect((await u[2].c.req(`/projects/${pid}/edit`)).status).toBe(200);
    expect((await u[1].c.req(`/projects/${pid}/edit`)).status).toBe(403);
    expect((await u[1].c.req(`/projects/${pid}/requests`)).status).toBe(403);
  } finally {
    ac.abort();
  }
});

it("lobby progress is live on the lobby topic", async () => {
  const a = await signedUp("lbl1");
  const ac = new AbortController();
  const res = await fetch(url(`/events?topic=lobby:${CAT}:canberra`), { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!re.test(buf) && Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
      if (r && !r.done) buf += dec.decode(r.value, { stream: true });
    }
    expect(buf).toMatch(re);
  };
  try {
    await until(/"type":"ready"/, 2000);
    expect((await a.c.post(`${LOBBY}/join`, {})).status).toBe(302);
    await until(/"type":"lobby"/, 1000);
    expect(buf).toContain("1 of 3");
  } finally {
    ac.abort();
    await a.c.post(`${LOBBY}/leave`, {});
  }
});
