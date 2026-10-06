import { html } from "hono/html";
import { db } from "../db/index.ts";
import { notHidden } from "../provenance.ts";
import { categoryChip } from "../categories.ts";
import { REGION_BY_SLUG } from "../regions.ts";
import { themeChips } from "../themes.ts";
import { statusBadge } from "../routes/projects.ts";
import type { Html } from "./layout.ts";

export type CardRow = {
  id: number; title: string; summary: string; status: string; recruiting: number; postcode: string | null; updated_at: string;
  lat: number | null; lon: number | null; locality: string | null; state: string | null; region: string | null; category: string | null; upvotes: number;
};

/** Base SELECT for project cards; append a WHERE built from `notHidden("project", "p.id")` and friends. */
export const CARD_SELECT = `SELECT p.id, p.title, p.summary, p.status, p.recruiting, p.postcode, p.updated_at, pc.lat, pc.lon, pc.locality, pc.state, pc.region, p.category,
  (SELECT COUNT(*) FROM upvotes uv WHERE uv.project_id = p.id) AS upvotes
  FROM projects p LEFT JOIN postcodes pc ON pc.postcode = p.postcode`;

/** Recruiting, visible, not-done projects matching extra WHERE conditions (written against p. and pc.). */
export function recruitingProjects(extra: string[], args: (string | number)[], limit = 50): CardRow[] {
  const where = [notHidden("project", "p.id"), "p.status IN ('open','in_progress')", "p.recruiting = 1", ...extra];
  return db.prepare(`${CARD_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.id DESC LIMIT ${limit}`).all(...args) as CardRow[];
}

const openSkills = db.prepare("SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? AND ps.filled_by IS NULL ORDER BY s.name");

/** One project card; `d` is the distance in km from the viewer's chosen postcode, if any. */
export function projectCard(r: CardRow, d: number | null): Html {
  const regionName = r.region ? REGION_BY_SLUG.get(r.region)?.name : null;
  return html`<article class="card project-card" id="project-card-${r.id}">
  <h2><a href="/projects/${r.id}">${r.title}</a></h2>
  <p class="badges">${statusBadge(r.status)} ${r.recruiting ? html`<span class="badge recruiting">Recruiting</span>` : ""} ${categoryChip(r.category)} ${themeChips(r.id)} <span class="upvote-count" title="Community upvotes">▲ ${r.upvotes}</span></p>
  <p>${r.summary}</p>
  <ul class="tags">${(openSkills.all(r.id) as { name: string }[]).map((s) => html`<li><a href="/?skill=${encodeURIComponent(s.name)}">${s.name}</a></li>`)}</ul>
  <p class="muted">${r.locality ? html`${r.locality}, ${r.state} ${r.postcode}` : ""}${regionName ? html` · <a href="/regions/${r.region}">${regionName}</a>` : ""}${d !== null ? html` · ${d < 1 ? "<1" : Math.round(d)} km away` : ""}</p>
</article>`;
}
