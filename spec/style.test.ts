// TEMPORARY: covers the theme switcher (src/routes/style.ts).
import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const url = (p: string) => new URL(p, baseUrl);
const THEMES = ["plain", "pegboard", "enamel", "notebook", "blend", "raw", "hobbyist"];

async function csrfAndCookies(): Promise<{ csrf: string; cookie: string }> {
  const res = await fetch(url("/style"));
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const m = (await res.text()).match(/name="_csrf" value="([0-9a-f]+)"/);
  if (!m) throw new Error("no csrf");
  return { csrf: m[1], cookie };
}

async function choose(theme: string): Promise<string> {
  const { csrf, cookie } = await csrfAndCookies();
  const res = await fetch(url("/style"), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ _csrf: csrf, theme }),
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/style");
  const set = res.headers.getSetCookie().find((c) => c.startsWith("theme="));
  expect(set).toMatch(/Max-Age=31536000/i);
  expect(set).toMatch(/SameSite=Lax/i);
  return [cookie, set!.split(";")[0]].filter(Boolean).join("; ");
}

it("GET /style lists all seven options", async () => {
  const res = await fetch(url("/style"));
  expect(res.status).toBe(200);
  const body = await res.text();
  for (const t of THEMES) expect(body).toContain(`name="theme" value="${t}"`);
});

it("POST /style without _csrf is 403", async () => {
  const res = await fetch(url("/style"), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ theme: "notebook" }),
  });
  expect(res.status).toBe(403);
});

it("a chosen theme is applied to later pages", async () => {
  const cookie = await choose("notebook");
  const body = await (await fetch(url("/"), { headers: { cookie } })).text();
  expect(body).toContain('data-theme="notebook"');
  expect(body).toContain("/public/themes/notebook.css");
});

it("an invalid theme falls back to plain", async () => {
  const cookie = await choose("../../etc/passwd");
  const body = await (await fetch(url("/"), { headers: { cookie } })).text();
  expect(body).toContain('data-theme="plain"');
  expect(body).not.toContain("/public/themes/");
});

it("each theme stylesheet is served as CSS", async () => {
  for (const t of THEMES.filter((x) => x !== "plain")) {
    const res = await fetch(url(`/public/themes/${t}.css`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
  }
});
