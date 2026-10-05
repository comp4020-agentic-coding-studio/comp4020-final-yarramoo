import { html } from "hono/html";
import { db } from "./db/index.ts";
import type { TargetType } from "./provenance.ts";
import type { Html } from "./views/layout.ts";

export const REASONS = ["Harassment or abuse", "Unsafe behaviour at a meetup", "Scam or money request", "Under 18", "Spam", "Other"] as const;
export const REPORT_TYPES: readonly TargetType[] = ["project", "question", "answer", "update", "profile"];

export type Target = { userId: number; handle: string; url: string; label: string };

/** Who wrote the thing, and where it lives. Null if it doesn't exist. */
export function resolveTarget(type: string, id: number): Target | null {
  const one = (sql: string) => db.prepare(sql).get(id) as Record<string, string | number> | undefined;
  if (type === "project") {
    const r = one("SELECT p.title, p.owner_id AS uid, u.handle FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?");
    return r ? { userId: Number(r.uid), handle: String(r.handle), url: `/projects/${id}`, label: `project: ${r.title}` } : null;
  }
  if (type === "question") {
    const r = one("SELECT q.title, q.author_id AS uid, u.handle FROM questions q JOIN users u ON u.id = q.author_id WHERE q.id = ?");
    return r ? { userId: Number(r.uid), handle: String(r.handle), url: `/questions/${id}`, label: `question: ${r.title}` } : null;
  }
  if (type === "answer") {
    const r = one("SELECT a.question_id AS qid, a.author_id AS uid, u.handle FROM answers a JOIN users u ON u.id = a.author_id WHERE a.id = ?");
    return r ? { userId: Number(r.uid), handle: String(r.handle), url: `/questions/${r.qid}#answer-${id}`, label: "an answer" } : null;
  }
  if (type === "update") {
    const r = one("SELECT up.project_id AS pid, up.author_id AS uid, u.handle FROM updates up JOIN users u ON u.id = up.author_id WHERE up.id = ?");
    return r ? { userId: Number(r.uid), handle: String(r.handle), url: `/projects/${r.pid}#update-${id}`, label: "a progress update" } : null;
  }
  if (type === "profile") {
    const r = one("SELECT handle FROM users WHERE id = ?");
    return r ? { userId: id, handle: String(r.handle), url: `/u/${r.handle}`, label: "a profile" } : null;
  }
  return null;
}

/** Small "Report" link. Callers leave it out on the viewer's own content. */
export const reportLink = (type: TargetType, id: number): Html =>
  html`<a class="report-link" href="/report?type=${type}&amp;id=${id}" rel="nofollow">Report</a>`;
