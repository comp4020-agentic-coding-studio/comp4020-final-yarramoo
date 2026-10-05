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

type P = { id: number; handle: string; owner_id: number; title: string; summary: string; body: string; postcode: string; category: string | null; status: string; recruiting: number };
const project = (id: number) =>
  q<P>(`SELECT p.id, u.handle, p.owner_id, p.title, p.summary, p.body, p.postcode, p.category, p.status, p.recruiting
        FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?`, id)[0]!;
const pending = (pid: number) =>
  q<{ id: number; user_id: number }>(`SELECT id, user_id FROM join_requests WHERE project_id = ? AND status = 'pending' ORDER BY id`, pid);

async function edit(id: number, status: string, recruiting: boolean, category = project(id).category ?? "other") {
  const p = project(id);
  const skills = q<{ name: string }>(
    `SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? ORDER BY s.name`, id,
  ).map((s) => s.name).join(", ");
  const text = p.summary.length + p.body.length;
  const c = await as(p.handle);
  await c.post(`/projects/${id}/edit`, {
    title: p.title, summary: p.summary, body: p.body, skills, postcode: p.postcode, category,
    status, recruiting: recruiting ? "1" : "", pledge: "1",
    prov_typed: String(Math.floor(text * 0.7)), prov_pasted_prose: "0", prov_active_ms: String(text * 250),
    prov_paste_events: "0", prov_deletions: String(Math.floor(text * 0.05)),
  }, `/projects/${id}/edit`, new RegExp(`^/projects/${id}$`), `edit project ${id} -> ${status}`);
  console.log(`project ${id} -> ${status}, recruiting=${recruiting}`);
}

/** Sensible category for a seeded project, from its title. */
function categoryFor(title: string): string {
  const rules: [RegExp, string][] = [
    [/ham radio|radio restoration|vintage radio/i, "radio"], [/home automation/i, "home-automation"],
    [/greenhouse|garden|watering/i, "garden-tech"], [/bike|bicycle/i, "bikes"], [/3d print/i, "3d-printing"],
    [/rocket/i, "rocketry"], [/robot/i, "robotics"], [/workbench|wood|timber/i, "woodwork"],
    [/weld|drill press|cnc|metal|lathe|steel/i, "metalwork"], [/arduino|lora|pcb|amp\b|laser|solder|circuit|electronic/i, "electronics"],
  ];
  return rules.find(([re]) => re.test(title))?.[1] ?? "other";
}

const ROCKET_PROJECTS = [
  { handle: "sparky_jo", postcode: "2601", title: "Model rocket altimeter payload", skills: "arduino, soldering", summary: "Fly a small barometric altimeter on a mid-power rocket and log the flight." },
  { handle: "bench_dave", postcode: "2602", title: "Launch rail and ignition box", skills: "welding, electronics", summary: "A portable launch rail with a safe key-switch ignition box for club launches." },
  { handle: "weld_sam", postcode: "2000", title: "Dual-deploy recovery bay", skills: "3d printing, arduino", summary: "Design a dual-deploy electronics bay for a certified high-power rocket." },
];

async function createRocket(r: (typeof ROCKET_PROJECTS)[number]) {
  const c = await as(r.handle);
  const text = r.summary.length;
  await c.post("/projects/new", {
    title: r.title, summary: r.summary, body: "", skills: r.skills, postcode: r.postcode, category: "rocketry", pledge: "1",
    prov_typed: String(Math.floor(text * 0.7)), prov_pasted_prose: "0", prov_active_ms: String(text * 250),
    prov_paste_events: "0", prov_deletions: String(Math.floor(text * 0.05)),
  }, "/projects/new", /^\/projects\/\d+$/, `create ${r.title}`);
  const id = q<{ id: number }>(`SELECT p.id FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.title = ? AND u.handle = ?`, r.title, r.handle)[0]!.id;
  console.log(`created rocketry project ${id}: ${r.title}`);
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

// Lobbies: 3 Canberra users wait in rocketry (teamSize 5); 3 more fill robotics (teamSize 3), which forms
// a team that then votes in a leader. Each step checks the DB first, so re-runs do nothing.
const LOBBY_REGION = "canberra";
const ROCKET_WAITING = ["sparky_jo", "bench_dave", "weld_sam"];
const ROBOT_TEAM = ["etch_maya", "crank_lee", "solder_pat"];

async function ensureRegion(handle: string) {
  const u = q<{ postcode: string | null; display_name: string | null; background: string | null; interests: string | null; region: string | null; id: number }>(
    `SELECT u.id, u.postcode, u.display_name, u.background, u.interests, pc.region FROM users u LEFT JOIN postcodes pc ON pc.postcode = u.postcode WHERE u.handle = ?`, handle,
  )[0]!;
  if (u.region === LOBBY_REGION) return;
  const skills = q<{ name: string }>(`SELECT s.name FROM user_skills us JOIN skills s ON s.id = us.skill_id WHERE us.user_id = ?`, u.id).map((s) => s.name).join(", ");
  await (await as(handle)).post("/me", {
    display_name: u.display_name ?? handle, background: u.background ?? "", interests: u.interests ?? "", postcode: "2601", skills,
  }, "/me", /^\/me$|^\/u\//, `set ${handle} postcode`);
  console.log(`${handle} postcode -> 2601`);
}

async function joinLobbyAs(handle: string, category: string, loc: RegExp) {
  if (q(`SELECT 1 FROM lobby_members l JOIN users u ON u.id = l.user_id WHERE u.handle = ? AND l.category = ? AND l.region = ?`, handle, category, LOBBY_REGION).length) return;
  await ensureRegion(handle);
  await (await as(handle)).post(`/lobbies/${category}/${LOBBY_REGION}/join`, {}, `/c/${category}`, loc, `${handle} joins ${category} lobby`);
  console.log(`${handle} joined ${category}:${LOBBY_REGION}`);
}

async function seedLobbies() {
  for (const h of ROCKET_WAITING) await joinLobbyAs(h, "rocketry", new RegExp(`^/c/rocketry$`));
  const formed = () => q<{ id: number; leader_pending: number }>(`SELECT id, leader_pending FROM projects WHERE formed_from_lobby = ?`, `robotics:${LOBBY_REGION}`)[0];
  if (!formed()) for (const h of ROBOT_TEAM) await joinLobbyAs(h, "robotics", /^\/(c\/robotics|projects\/\d+)$/);
  const team = formed();
  if (!team) throw new Error("robotics lobby did not form a team");
  if (team.leader_pending) {
    const ids = new Map(q<{ id: number; handle: string }>(`SELECT id, handle FROM users WHERE handle IN (${ROBOT_TEAM.map(() => "?").join(",")})`, ...ROBOT_TEAM).map((u) => [u.handle, u.id]));
    const pick = ROBOT_TEAM[1]!;
    for (const h of ROBOT_TEAM.slice(0, 2)) {
      await (await as(h)).post(`/projects/${team.id}/vote`, { candidate: String(ids.get(pick)) }, `/projects/${team.id}`, new RegExp(`^/projects/${team.id}$`), `${h} votes for ${pick}`);
      console.log(`${h} voted for ${pick}`);
    }
  }
}

async function main() {
  // 0. Categories: give every seeded project with no category one, as its owner, via the edit form.
  const uncategorised = q<{ id: number; title: string }>(
    `SELECT p.id, p.title FROM projects p JOIN users u ON u.id = p.owner_id WHERE u.handle IN (${marks}) AND p.category IS NULL ORDER BY p.id`, ...HANDLES,
  );
  for (const p of uncategorised) {
    const cat = categoryFor(p.title);
    const cur = project(p.id);
    await edit(p.id, cur.status, !!cur.recruiting, cat);
    console.log(`project ${p.id} category -> ${cat}`);
  }
  for (const r of ROCKET_PROJECTS) {
    if (!q(`SELECT 1 FROM projects WHERE title = ?`, r.title).length) await createRocket(r);
  }

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
  await seedLobbies();
  console.log("top-up complete");
}

main().catch((e) => {
  console.error("Top-up failed:", e);
  process.exit(1);
});
