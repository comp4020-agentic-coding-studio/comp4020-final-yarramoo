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
  async function post(path: string, fields: Record<string, string>, formPage = "/questions/new") {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await csrf(formPage));
    return req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return { req, post, cookie };
}
type C = ReturnType<typeof client>;

const pw = "correct horse battery";
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", { handle: `${name}_${run}`, password: pw }, "/signup")).status).toBe(302);
  return c;
}

let A: C;
let B: C;
let qid = "";
let aid = "";
const title = `How do I stop solder bridging ${run}`;
const code = "int x = 1;\nprintln(x);";
const qBody = `My iron tips keep bridging pads on a TQFP board, here is what I tried.\n\n\`\`\`c\n${code}\n\`\`\`\n\nAlso <script>alert(1)</script> appears in my log.`;

async function answer(c: C, body: string, extra: Record<string, string> = {}, pledge = true) {
  return c.post(`/questions/${qid}/answers`, { body, ...(pledge ? { pledge: "1" } : {}), ...extra }, `/questions/${qid}`);
}
const answerIds = (text: string) => [...text.matchAll(/<article class="answer[^"]*" id="answer-(\d+)"/g)].map((m) => m[1]);

it("setup: two users", async () => {
  A = await signedUp("boardA");
  B = await signedUp("boardB");
});

it("a question without the pledge is rejected with 400", async () => {
  const res = await A.post("/questions/new", { title, body: qBody, skills: "soldering" });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain(`value="${title}"`);
});

it("A posts a question; code is in <pre><code> and script is escaped", async () => {
  const res = await A.post("/questions/new", { title, body: qBody, skills: "soldering", pledge: "1" });
  expect(res.status).toBe(302);
  qid = res.headers.get("location")!.split("/")[2];
  const text = await (await A.req(`/questions/${qid}`)).text();
  expect(text).toContain(title);
  expect(text).toContain("<pre><code>int x = 1;\nprintln(x);</code></pre>");
  expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(text).not.toContain("<script>alert(1)");
});

it("the skill filter lists it, and it is unanswered", async () => {
  const text = await (await B.req("/questions?skill=soldering")).text();
  expect(text).toContain(title);
  expect(await (await B.req("/questions?skill=nonexistent-skill")).text()).not.toContain(title);
  expect(await (await B.req("/questions?unanswered=1&skill=soldering")).text()).toContain(title);
});

it("B answers (pledge required) and the answer appears", async () => {
  expect((await answer(B, "Use more flux and drag the iron.", {}, false)).status).toBe(400);
  const res = await answer(B, "Use more flux and drag the iron.");
  expect(res.status).toBe(302);
  aid = res.headers.get("location")!.split("#answer-")[1];
  const text = await (await A.req(`/questions/${qid}`)).text();
  expect(text).toContain("Use more flux and drag the iron.");
  expect(text).toContain("1 answer");
  expect(await (await B.req("/questions?skill=soldering")).text()).toContain("1 answer");
});

it("real-time: an answer event arrives on question:<id>", async () => {
  const ac = new AbortController();
  const res = await fetch(url(`/events?topic=question:${qid}`), { signal: ac.signal });
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
    expect((await answer(B, "A second answer, live.")).status).toBe(302);
    await read(/"type":"answer"/, 1000);
    expect(buf).toContain("A second answer, live.");
  } finally {
    ac.abort();
  }
});

it("A marks B's answer helped; B cannot mark their own", async () => {
  const res = await A.post(`/answers/${aid}/helped`, {}, `/questions/${qid}`);
  expect(res.status).toBe(302);
  expect(await (await A.req(`/questions/${qid}`)).text()).toContain("This helped (1)");
  expect((await B.post(`/answers/${aid}/helped`, {}, `/questions/${qid}`)).status).toBe(403);
});

it("only the author accepts; the accepted answer sorts first", async () => {
  const ids = answerIds(await (await A.req(`/questions/${qid}`)).text());
  const other = ids.find((i) => i !== aid)!;
  expect((await B.post(`/questions/${qid}/accept/${other}`, {}, `/questions/${qid}`)).status).toBe(403);
  expect((await A.post(`/questions/${qid}/accept/${other}`, {}, `/questions/${qid}`)).status).toBe(302);
  const text = await (await A.req(`/questions/${qid}`)).text();
  expect(answerIds(text)[0]).toBe(other);
  expect(text).toContain("Accepted");
  expect(await (await B.req("/questions?skill=soldering")).text()).toContain("Accepted");
});

it("pasted text inside ``` fences does not count as pasted prose", async () => {
  const body = `Here is my log, which I pasted.\n\n\`\`\`\n${"E".repeat(900)}\n\`\`\`\n`;
  const res = await answer(B, body, { prov_typed: "30", prov_pasted_prose: "0", prov_active_ms: "60000", prov_deletions: "5" });
  expect(res.status).toBe(302);
  const id = res.headers.get("location")!.split("#answer-")[1];
  const json = await (await A.req("/provenance.json")).json() as { items: { type: string; id: number; label: string }[] };
  expect(json.items.find((i) => i.type === "answer" && i.id === Number(id))?.label).toBe("typed");
});

it("without the script's fields the label is unknown", async () => {
  const res = await answer(B, "No script on this one at all.");
  const id = res.headers.get("location")!.split("#answer-")[1];
  const json = await (await A.req("/provenance.json")).json() as { items: { type: string; id: number; label: string }[] };
  expect(json.items.find((i) => i.type === "answer" && i.id === Number(id))?.label).toBe("unknown");
});

it("robots.txt is plain text", async () => {
  const res = await fetch(url("/robots.txt"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
});
