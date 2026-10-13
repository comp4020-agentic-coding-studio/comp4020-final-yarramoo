import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const url = (p: string) => new URL(p, baseUrl);

it("rejects signup of example_* handles without the seed header", async () => {
  const jar = new Map<string, string>();
  const get = await fetch(url("/signup"));
  for (const sc of get.headers.getSetCookie()) { const [kv] = sc.split(";"); jar.set(kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)); }
  const m = (await get.text()).match(/name="_csrf" value="([0-9a-f]+)"/);
  expect(m).toBeTruthy();
  const body = new URLSearchParams({ handle: `example_x${Date.now().toString(36)}`, password: "correct horse battery", dob: "1990-01-01", safety_ok: "1", _csrf: m![1] });
  const res = await fetch(url("/signup"), {
    method: "POST", body, redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "x-example-seed": "wrong" },
  });
  expect(res.status).toBe(400);
});
