#!/usr/bin/env node
// Idempotent top-up for a dev DB seeded by scripts/seed-dev.ts when the status
// and join-request steps silently failed. Drives the running dev server over
// HTTP as the real owners, and reads .data/app.db read-only to decide what is left.
//   node scripts/seed-dev-topup.ts
import { DatabaseSync } from "node:sqlite";

const APP_URL = process.env.APP_URL || "http://localhost:8080";
const { hostname } = new URL(APP_URL);
if (hostname !== "localhost" && hostname !== "127.0.0.1") {
  console.error(`SAFETY GUARD: APP_URL host must be localhost or 127.0.0.1, got "${hostname}".`);
  process.exit(1);
}
const PASSWORD = "devpassword123";
const HANDLES = [
  "sparky_jo", "bench_dave", "weld_sam", "etch_maya", "crank_lee", "solder_pat",
  "drill_chris", "paint_alex", "solder_bee", "radio_kim", "repairbot_max", "maker_taylor",
];
const DB_PATH = process.env.DB_PATH || ".data/app.db";
const marks = HANDLES.map(() => "?").join(",");

const q = <T>(sql: string, ...args: (string | number)[]) => {
  const d = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return d.prepare(sql).all(...args) as T[];
  } finally {
    d.close();
  }
};

class Client {
  jar = new Map<string, string>();
  handle: string;
  constructor(handle: string) {
    this.handle = handle;
  }
  async req(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(new URL(path, APP_URL), { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const i = kv.indexOf("=");
      const [k, v] = [kv.slice(0, i).trim(), kv.slice(i + 1)];
      if (v === "" || attrs.some((a) => /max-age=0/i.test(a))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async csrf(page: string) {
    const m = (await (await this.req(page)).text()).match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no csrf field on ${page}`);
    return m[1];
  }
  /** POST a form and require a 302 (to a path matching `loc`); throw with the body otherwise. */
  async post(path: string, fields: Record<string, string>, formPage: string, loc: RegExp, what: string) {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await this.csrf(formPage));
    const res = await this.req(path, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const location = res.headers.get("location") ?? "";
    if (res.status !== 302 || !loc.test(location)) {
      throw new Error(`${what}: expected 302 to ${loc}, got ${res.status} location=${location || "(none)"}\n${(await res.text()).slice(0, 2000)}`);
    }
  }
}

const clients = new Map<string, Client>();
async function as(handle: string) {
  let c = clients.get(handle);
  if (c) return c;
  c = new Client(handle);
  await c.post("/login", { handle, password: PASSWORD, next: "/" }, "/login", /^\//, `login ${handle}`);
  clients.set(handle, c);
  return c;
}

type P = { id: number; handle: string; owner_id: number; title: string; summary: string; body: string; postcode: string; status: string; recruiting: number };
const project = (id: number) =>
  q<P>(`SELECT p.id, u.handle, p.owner_id, p.title, p.summary, p.body, p.postcode, p.status, p.recruiting
        FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?`, id)[0]!;
const pending = (pid: number) =>
  q<{ id: number; user_id: number }>(`SELECT id, user_id FROM join_requests WHERE project_id = ? AND status = 'pending' ORDER BY id`, pid);

async function edit(id: number, status: string, recruiting: boolean) {
  const p = project(id);
  const skills = q<{ name: string }>(
    `SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? ORDER BY s.name`, id,
  ).map((s) => s.name).join(", ");
  const text = p.summary.length + p.body.length;
  const c = await as(p.handle);
  await c.post(`/projects/${id}/edit`, {
    title: p.title, summary: p.summary, body: p.body, skills, postcode: p.postcode,
    status, recruiting: recruiting ? "1" : "", pledge: "1",
    prov_typed: String(Math.floor(text * 0.7)), prov_pasted_prose: "0", prov_active_ms: String(text * 250),
    prov_paste_events: "0", prov_deletions: String(Math.floor(text * 0.05)),
  }, `/projects/${id}/edit`, new RegExp(`^/projects/${id}$`), `edit project ${id} -> ${status}`);
  console.log(`project ${id} -> ${status}, recruiting=${recruiting}`);
}

async function decide(pid: number, rid: number, verb: "accept" | "decline") {
  const c = await as(project(pid).handle);
  await c.post(`/projects/${pid}/requests/${rid}/${verb}`, {}, `/projects/${pid}/requests`,
    new RegExp(`^/projects/${pid}/requests$`), `${verb} request ${rid} on project ${pid}`);
  console.log(`${verb}ed request ${rid} on project ${pid}`);
}

/** New join request from some other seeded user, optionally for an open skill; returns the request id. */
async function addRequest(pid: number, withSkill: boolean, msg: string) {
  const p = project(pid);
  const taken = new Set(q<{ user_id: number }>(
    `SELECT user_id FROM members WHERE project_id = ? UNION SELECT user_id FROM join_requests WHERE project_id = ?`, pid, pid,
  ).map((r) => r.user_id));
  const cand = q<{ id: number; handle: string }>(`SELECT id, handle FROM users WHERE handle IN (${marks})`, ...HANDLES)
    .filter((u) => !taken.has(u.id));
  if (!cand.length) throw new Error(`no free requester for project ${pid}`);
  const who = cand[pid % cand.length]!;
  const open = q<{ skill_id: number }>(`SELECT skill_id FROM project_skills WHERE project_id = ? AND filled_by IS NULL ORDER BY skill_id`, pid);
  if (withSkill && !open.length) throw new Error(`project ${pid} has no open skill`);
  const c = await as(who.handle);
  await c.post(`/projects/${pid}/requests`, { skill_id: withSkill ? String(open[0]!.skill_id) : "", message: msg },
    `/projects/${pid}`, new RegExp(`^/projects/${pid}$`), `join request ${who.handle} -> ${pid}`);
  const rid = q<{ id: number }>(`SELECT id FROM join_requests WHERE project_id = ? AND user_id = ? AND status = 'pending'`, pid, who.id)[0]!.id;
  console.log(`${who.handle} asked to join project ${pid}${withSkill ? " (with skill)" : ""}`);
  return rid;
}

const filled = (pid: number) =>
  q<{ n: number }>(`SELECT COUNT(*) n FROM project_skills WHERE project_id = ? AND filled_by IS NOT NULL`, pid)[0]!.n;

async function main() {
  const inProgress = q<{ id: number }>(
    `SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.handle IN (${marks}) AND p.status = 'in_progress' ORDER BY p.recruiting DESC, p.id`,
    ...HANDLES,
  ).map((r) => r.id);
  const doneNow = q<{ n: number }>(
    `SELECT COUNT(*) n FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.handle IN (${marks}) AND p.status = 'done'`, ...HANDLES,
  )[0]!.n;

  // 1. Finish 3 in-progress projects (recruiting ones first, so they have pending requests to resolve).
  const toFinish = inProgress.slice(0, Math.max(0, 3 - doneNow));
  for (const id of toFinish) {
    if (!filled(id)) await decide(id, await addRequest(id, true, "I can cover this skill for the build."), "accept");
    for (const r of pending(id)) await decide(id, r.id, "accept");
    await edit(id, "done", false);
  }

  // 2. Projects that stay in progress: one new skill-filling teammate each, so there are more teams.
  const stay = inProgress.filter((id) => !toFinish.includes(id)).slice(0, 2);
  for (const id of stay) {
    if (filled(id)) continue;
    const p = project(id);
    if (!p.recruiting) await edit(id, "in_progress", true); // requests need recruiting on
    await decide(id, await addRequest(id, true, "Happy to take on this part of the build."), "accept");
    if (!p.recruiting) await edit(id, "in_progress", false);
  }

  // 3. Remaining pending requests on seeded projects: decline 2 in total, accept the rest.
  let declined = q<{ n: number }>(
    `SELECT COUNT(*) n FROM join_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = p.owner_id
     WHERE u.handle IN (${marks}) AND r.status = 'declined'`, ...HANDLES,
  )[0]!.n;
  const rest = q<{ id: number; project_id: number }>(
    `SELECT r.id, r.project_id FROM join_requests r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = p.owner_id
     WHERE u.handle IN (${marks}) AND r.status = 'pending' ORDER BY r.id`, ...HANDLES,
  );
  for (const r of rest) {
    if (declined < 2) {
      await decide(r.project_id, r.id, "decline");
      declined++;
    } else await decide(r.project_id, r.id, "accept");
  }
  console.log("top-up complete");
}

main().catch((e) => {
  console.error("Top-up failed:", e);
  process.exit(1);
});
