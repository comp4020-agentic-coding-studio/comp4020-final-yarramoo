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
  async function upload(path: string, text: string, files: { name: string; type: string; data: Uint8Array }[], formPage: string, pledge = true) {
    const fd = new FormData();
    fd.set("_csrf", await csrf(formPage));
    fd.set("body", text);
    if (pledge) fd.set("pledge", "1");
    for (const f of files) fd.append("photos", new File([f.data as BlobPart], f.name, { type: f.type }));
    return req(path, { method: "POST", body: fd });
  }
  return { req, post, upload };
}

const pw = "correct horse battery";
async function signedUp(name: string) {
  const c = client();
  expect((await c.post("/signup", { handle: `${name}_${run}`, password: pw })).status).toBe(302);
  return c;
}

// Minimal valid 1x1 PNG.
const png = (): { name: string; type: string; data: Uint8Array } => ({
  name: "dot.png",
  type: "image/png",
  data: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64")),
});

const title = `Updates project ${run}`;
let pid = "";
let page = "";
let owner: Awaited<ReturnType<typeof signedUp>>;
let other: Awaited<ReturnType<typeof signedUp>>;
const text = `Welded the frame ${run}`;

it("sets up an owner and a non-member", async () => {
  owner = await signedUp("upown");
  other = await signedUp("upother");
  const res = await owner.post("/projects/new", { title, summary: "s", body: "", skills: "", postcode: "2601", category: "other", pledge: "1" });
  expect(res.status).toBe(302);
  pid = res.headers.get("location")!.split("/")[2];
  page = `/projects/${pid}`;
});

it("owner posts an update with a photo; it shows with a servable image", async () => {
  const res = await owner.upload(`${page}/updates`, text, [png()], page);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${page}#updates`);
  const html = await (await owner.req(page)).text();
  expect(html).toContain(text);
  const m = html.match(/<img src="(\/uploads\/[0-9a-f]{32}\.png)"/);
  expect(m).toBeTruthy();
  expect(html).toMatch(/width="1" height="1"/);
  const img = await fetch(url(m![1]));
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect(img.headers.get("x-content-type-options")).toBe("nosniff");
});

it("non-members get 403 and no form", async () => {
  const res = await other.upload(`${page}/updates`, "nope", [], page);
  expect(res.status).toBe(403);
  expect(await (await other.req(page)).text()).not.toContain('id="update-form"');
});

it("rejects a text file named .png", async () => {
  const bad = { name: "evil.png", type: "image/png", data: new TextEncoder().encode("not an image at all") };
  expect((await owner.upload(`${page}/updates`, "x", [bad], page)).status).toBe(400);
});

it("rejects more than 6 files", async () => {
  expect((await owner.upload(`${page}/updates`, "x", Array.from({ length: 7 }, png), page)).status).toBe(400);
});

it("rejects a file over 2 MB", async () => {
  const big = png();
  const data = new Uint8Array(2 * 1024 * 1024 + 1);
  data.set(big.data);
  expect((await owner.upload(`${page}/updates`, "x", [{ ...big, data }], page)).status).toBe(400);
});

it("lists the update on /updates", async () => {
  const html = await (await fetch(url("/updates"))).text();
  expect(html).toContain(title);
  expect(html).toContain('data-live-topic="feed"');
});

it("escapes markup in the body", async () => {
  const res = await owner.upload(`${page}/updates`, "<script>alert(1)</script>", [], page);
  expect(res.status).toBe(302);
  const html = await (await owner.req(page)).text();
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)");
});

it("rejects path traversal and unknown names under /uploads", async () => {
  expect((await fetch(url("/uploads/..%2f..%2fetc%2fpasswd"))).status).toBe(404);
  expect((await fetch(url("/uploads/../etc/passwd"))).status).toBe(404);
  expect((await fetch(url(`/uploads/${"0".repeat(32)}.png`))).status).toBe(404);
});

it("pushes a project-topic event when an update is posted", async () => {
  const ac = new AbortController();
  const res = await fetch(url(`/events?topic=project:${pid}`), { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp) => {
    while (!re.test(buf)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buf += dec.decode(value);
    }
  };
  await until(/"type":"ready"/);
  const got = until(/"type":"update"/);
  expect((await owner.upload(`${page}/updates`, `live ${run}`, [png()], page)).status).toBe(302);
  await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("no event in 1000ms")), 1000))]);
  expect(buf).toContain(`live ${run}`);
  ac.abort();
});
