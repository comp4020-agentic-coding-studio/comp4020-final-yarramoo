import { db } from "./db/index.ts";
import { notHidden } from "./provenance.ts";

// Awards are earned from activity and computed on the fly from existing tables (there is no
// awards table, so they cannot drift and nobody can hand them out). Hidden content never counts.
// The whole set, each with its plain criterion:
//   first-build    Joined or started a project (any role)                      one-off
//   team-player    Member (not owner) of 1 / 3 / 10 projects                   bronze / silver / gold
//   finisher       On the team (any role) of projects marked done              one-off, shows the count
//   founder        Started a project that reached done                         one-off, shows the count
//   mentor         Answers marked "this helped" by others: 5 / 25 / 100        bronze / silver / gold
//   solved-it      Answers accepted by the asker: 1 / 10 / 50                  bronze / silver / gold
//   show-and-tell  Progress updates posted: 5 / 25                             bronze / silver
// Own helps/accepts do not count (the app forbids them for helps; accepts by the author of
// their own question are excluded here).

export type Award = { key: string; name: string; tier?: "bronze" | "silver" | "gold"; detail: string };

const TIERS = ["bronze", "silver", "gold"] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Highest tier whose threshold `n` reaches, or undefined if below the first. */
function tierFor(n: number, thresholds: number[]): Award["tier"] | undefined {
  let t: Award["tier"] | undefined;
  thresholds.forEach((min, i) => { if (n >= min) t = TIERS[i]; });
  return t;
}

const count = (sql: string, id: number) => (db.prepare(sql).get(id) as { n: number }).n;

export function awardsFor(userId: number): Award[] {
  const live = notHidden("project", "p.id");
  const projects = (extra: string) =>
    count(`SELECT COUNT(*) AS n FROM members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? AND ${live} ${extra}`, userId);
  const out: Award[] = [];

  const any = projects("");
  if (any >= 1) out.push({ key: "first-build", name: "First build", detail: "Joined or started a first project" });

  const joined = projects("AND m.role = 'member'");
  const teamTier = tierFor(joined, [1, 3, 10]);
  if (teamTier) out.push({ key: "team-player", name: "Team player", tier: teamTier, detail: `Member of ${plural(joined, "project")} started by others` });

  const finished = projects("AND p.status = 'done'");
  if (finished) out.push({ key: "finisher", name: "Finisher", detail: `On the team of ${plural(finished, "finished project")}` });

  const founded = projects("AND p.status = 'done' AND m.role = 'owner'");
  if (founded) out.push({ key: "founder", name: "Founder", detail: `Started ${plural(founded, "project")} that reached done` });

  const answerLive = `${notHidden("answer", "a.id")} AND ${notHidden("question", "a.question_id")}`;
  const helped = count(
    `SELECT COUNT(*) AS n FROM helped h JOIN answers a ON a.id = h.answer_id WHERE a.author_id = ? AND h.user_id <> a.author_id AND ${answerLive}`, userId);
  const mentor = tierFor(helped, [5, 25, 100]);
  if (mentor) out.push({ key: "mentor", name: "Mentor", tier: mentor, detail: `Answers marked helpful ${plural(helped, "time")}` });

  const accepted = count(
    `SELECT COUNT(*) AS n FROM questions q JOIN answers a ON a.id = q.accepted_answer_id WHERE a.author_id = ? AND q.author_id <> a.author_id AND ${answerLive}`, userId);
  const solved = tierFor(accepted, [1, 10, 50]);
  if (solved) out.push({ key: "solved-it", name: "Solved it", tier: solved, detail: `${plural(accepted, "answer")} accepted by the asker` });

  const updates = count(
    `SELECT COUNT(*) AS n FROM updates up JOIN projects p ON p.id = up.project_id WHERE up.author_id = ? AND ${notHidden("update", "up.id")} AND ${live}`, userId);
  const show = tierFor(updates, [5, 25]);
  if (show) out.push({ key: "show-and-tell", name: "Show and tell", tier: show, detail: `${plural(updates, "progress update")} posted` });

  return out;
}
