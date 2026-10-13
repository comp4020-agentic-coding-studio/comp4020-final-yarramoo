import { announce } from "./activity.ts";
import { CATEGORY_BY_SLUG } from "./categories.ts";
import { db, skillIds, tx } from "./db/index.ts";
import { notify, short } from "./notify.ts";
import { REGION_BY_SLUG } from "./regions.ts";

// Interest lobbies: people join a (category, region) lobby; at the category's teamSize a team forms
// as a project. The team then votes in a leader, who becomes the project's owner_id. Until then
// owner_id is a placeholder and `leader_pending` = 1.

/** THE owner gate. Every "owner only" permission goes through this so a pending leader vote blocks all of them. */
export function canLead(p: { owner_id: number; leader_pending?: number }, userId: number | null | undefined): boolean {
  return userId != null && p.owner_id === userId && !p.leader_pending;
}

/** Region slug of a postcode, or null if unknown. */
export function regionOfPostcode(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const r = db.prepare("SELECT region FROM postcodes WHERE postcode = ?").get(postcode) as { region: string | null } | undefined;
  return r?.region && REGION_BY_SLUG.has(r.region) ? r.region : null;
}

export type LobbyMember = { user_id: number; handle: string; note: string | null; skills: string | null };

export function lobbyMembers(category: string, region: string): LobbyMember[] {
  return db.prepare(
    `SELECT l.user_id, u.handle, l.note, l.skills FROM lobby_members l JOIN users u ON u.id = l.user_id
     WHERE l.category = ? AND l.region = ? ORDER BY l.joined_at, l.rowid`,
  ).all(category, region) as LobbyMember[];
}

export const inLobby = (category: string, region: string, userId: number) =>
  !!db.prepare("SELECT 1 FROM lobby_members WHERE category = ? AND region = ? AND user_id = ?").get(category, region, userId);

/** Non-empty lobbies, optionally narrowed. */
export function lobbyCounts(where: { category?: string; region?: string } = {}): { category: string; region: string; n: number }[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (where.category) { conds.push("category = ?"); args.push(where.category); }
  if (where.region) { conds.push("region = ?"); args.push(where.region); }
  return db.prepare(`SELECT category, region, COUNT(*) AS n FROM lobby_members ${conds.length ? "WHERE " + conds.join(" AND ") : ""} GROUP BY category, region ORDER BY region, category`)
    .all(...args) as { category: string; region: string; n: number }[];
}

type Hook = (category: string, region: string) => void;
let progressPublisher: Hook = () => {};
/** The routes module registers how to render the live fragment (keeps HTML out of this file). */
export function setLobbyPublisher(fn: Hook): void { progressPublisher = fn; }

/** Add a member; if the lobby is now full, form the team. Returns the new project id when one formed. */
export function joinLobby(category: string, region: string, userId: number, note: string | null, skills: string | null): { projectId: number | null } {
  const k = CATEGORY_BY_SLUG.get(category)!;
  const r = REGION_BY_SLUG.get(region)!;
  const formed = tx(() => {
    db.prepare("INSERT INTO lobby_members (category, region, user_id, note, skills) VALUES (?,?,?,?,?)").run(category, region, userId, note, skills);
    const all = lobbyMembers(category, region);
    if (all.length < k.teamSize!) return null;
    const team = all.slice(0, k.teamSize!);
    const first = team[0]!;
    const pc = (db.prepare("SELECT postcode FROM users WHERE id = ?").get(first.user_id) as { postcode: string | null }).postcode;
    const title = `${k.name} team · ${r.name}`;
    const line = `Formed from the ${k.name} lobby in ${r.name}. Your leader can write the project description.`;
    const pid = Number(db.prepare(
      "INSERT INTO projects (owner_id, title, summary, body, status, recruiting, postcode, category, leader_pending, formed_from_lobby) VALUES (?,?,?,?, 'in_progress', 0, ?,?, 1, ?)",
    ).run(first.user_id, title, line, line, pc, category, `${category}:${region}`).lastInsertRowid);
    const addMember = db.prepare("INSERT INTO members (project_id, user_id, role) VALUES (?,?,?)");
    const addSkill = db.prepare("INSERT OR IGNORE INTO project_skills (project_id, skill_id, filled_by) VALUES (?,?,?)");
    const del = db.prepare("DELETE FROM lobby_members WHERE category = ? AND region = ? AND user_id = ?");
    for (const m of team) {
      addMember.run(pid, m.user_id, m.user_id === first.user_id ? "owner" : "member");
      if (m.skills) for (const sid of skillIds(m.skills)) addSkill.run(pid, sid, m.user_id);
      del.run(category, region, m.user_id);
    }
    return { pid, ids: team.map((m) => m.user_id), title };
  });
  if (formed) {
    for (const id of formed.ids) {
      notify(id, "team-formed", { text: `Your team ${short(formed.title)} has formed: vote for a leader`, href: `/projects/${formed.pid}` });
    }
    announce("team-formed", { projectId: formed.pid });
  }
  progressPublisher(category, region);
  return { projectId: formed?.pid ?? null };
}

export function leaveLobby(category: string, region: string, userId: number): boolean {
  const n = Number(db.prepare("DELETE FROM lobby_members WHERE category = ? AND region = ? AND user_id = ?").run(category, region, userId).changes);
  if (n) progressPublisher(category, region);
  return n > 0;
}

// ---- leader vote ----

export type Tally = { members: { id: number; handle: string; display_name: string | null; votes: number }[]; votesByVoter: Map<number, number>; n: number };

export function tally(pid: number): Tally {
  const members = db.prepare(
    `SELECT u.id, u.handle, u.display_name,
       (SELECT COUNT(*) FROM leader_votes v WHERE v.project_id = m.project_id AND v.candidate_id = u.id
          AND EXISTS (SELECT 1 FROM members vm WHERE vm.project_id = m.project_id AND vm.user_id = v.voter_id)) AS votes
     FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.joined_at, u.id`,
  ).all(pid) as Tally["members"];
  const votesByVoter = new Map((db.prepare("SELECT voter_id, candidate_id FROM leader_votes WHERE project_id = ?").all(pid) as { voter_id: number; candidate_id: number }[]).map((v) => [v.voter_id, v.candidate_id]));
  return { members, votesByVoter, n: members.length };
}

/**
 * Apply a vote and recompute. Leader = the member holding a strict majority of current members'
 * votes; with no majority the current leader (or none) stays. Returns the new leader id if leadership changed.
 */
export function castVote(pid: number, voter: number, candidate: number): { changedTo: number | null } {
  const changedTo = tx(() => {
    db.prepare(
      "INSERT INTO leader_votes (project_id, voter_id, candidate_id) VALUES (?,?,?) ON CONFLICT (project_id, voter_id) DO UPDATE SET candidate_id = excluded.candidate_id, voted_at = CURRENT_TIMESTAMP",
    ).run(pid, voter, candidate);
    const t = tally(pid);
    const win = t.members.find((m) => m.votes * 2 > t.n);
    if (!win) return null;
    const p = db.prepare("SELECT owner_id, leader_pending FROM projects WHERE id = ?").get(pid) as { owner_id: number; leader_pending: number };
    if (p.owner_id === win.id && !p.leader_pending) return null;
    db.prepare("UPDATE projects SET owner_id = ?, leader_pending = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(win.id, pid);
    db.prepare("UPDATE members SET role = CASE WHEN user_id = ? THEN 'owner' ELSE 'member' END WHERE project_id = ?").run(win.id, pid);
    return win.id;
  });
  return { changedTo };
}

/** Tell members about a new leader (persistent notification). */
export function notifyElected(pid: number, leaderId: number): void {
  const p = db.prepare("SELECT title FROM projects WHERE id = ?").get(pid) as { title: string };
  const h = (db.prepare("SELECT handle FROM users WHERE id = ?").get(leaderId) as { handle: string }).handle;
  const ms = db.prepare("SELECT user_id FROM members WHERE project_id = ?").all(pid) as { user_id: number }[];
  for (const m of ms) notify(m.user_id, "leader-elected", { text: `@${h} is now the leader of ${short(p.title)}`, href: `/projects/${pid}` });
}
