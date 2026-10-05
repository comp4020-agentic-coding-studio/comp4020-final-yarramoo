import { Hono } from "hono";
import { html } from "hono/html";
import { currentUser } from "../auth.ts";
import { db } from "../db/index.ts";
import { bbox, haversineKm, lookupPostcode } from "../geo.ts";
import { notHidden } from "../provenance.ts";
import { page } from "../views/layout.ts";
import { projectCard, CARD_SELECT, type CardRow } from "../views/cards.ts";
import { REGION_BY_SLUG, regionSelect } from "../regions.ts";

export const browse = new Hono();

const KMS = ["5", "10", "25", "50", "100", "any"];
const STATUS_OPTS = [["", "Open + in progress"], ["open", "Open"], ["in_progress", "In progress"], ["done", "Done"], ["any", "Any"]];

browse.get("/", (c) => {
  const me = currentUser(c);
  const q = c.req.query();
  const skill = (q.skill ?? "").trim().toLowerCase();
  const status = ["open", "in_progress", "done", "any"].includes(q.status ?? "") ? q.status! : "";
  const submitted = "go" in q;
  const recruitingOnly = submitted ? q.recruiting !== "all" : true;
  const nearRaw = "near" in q ? (q.near ?? "").trim() : (me?.postcode ?? "");
  const region = REGION_BY_SLUG.has(q.region ?? "") ? q.region! : "";
  const origin = nearRaw && !region ? lookupPostcode(nearRaw) : null; // a chosen region wins over near/km
  const km = KMS.includes(q.km ?? "") ? q.km! : "25";
  const limitKm = origin && km !== "any" ? Number(km) : null;

  const where: string[] = [notHidden("project", "p.id")];
  const args: (string | number)[] = [];
  if (status === "") where.push("p.status IN ('open','in_progress')");
  else if (status !== "any") { where.push("p.status = ?"); args.push(status); }
  if (recruitingOnly) where.push("p.recruiting = 1");
  if (skill) {
    where.push("EXISTS (SELECT 1 FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = p.id AND s.name = ?)");
    args.push(skill);
  }
  if (region) { where.push("pc.region = ?"); args.push(region); }
  if (origin && limitKm !== null) {
    const b = bbox(origin.lat, origin.lon, limitKm);
    where.push("pc.lat BETWEEN ? AND ? AND pc.lon BETWEEN ? AND ?");
    args.push(b.minLat, b.maxLat, b.minLon, b.maxLon);
  }
  const rows = db.prepare(
    `${CARD_SELECT}
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.updated_at DESC, p.id DESC LIMIT 500`,
  ).all(...args) as CardRow[];

  let cards = rows.map((r) => ({ r, d: origin && r.lat !== null && r.lon !== null ? haversineKm(origin, { lat: r.lat, lon: r.lon! }) : null }));
  if (limitKm !== null) cards = cards.filter((x) => x.d !== null && x.d <= limitKm);
  if (origin) cards.sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));
  cards = cards.slice(0, 50);

  const allSkills = db.prepare("SELECT name FROM skills ORDER BY name").all() as { name: string }[];

  return page(c, {
    title: "Browse",
    body: html`<h1>Browse projects</h1>
<form method="get" action="/" class="filters">
  <input type="hidden" name="go" value="1">
  <label>Skill<input name="skill" list="skill-names" value="${skill}" placeholder="any"></label>
  <label>Status<select name="status">${STATUS_OPTS.map(([v, l]) => html`<option value="${v}" ${v === status ? "selected" : ""}>${l}</option>`)}</select></label>
  <label>Region${regionSelect(region)}</label>
  <label>Near postcode<input name="near" inputmode="numeric" maxlength="4" value="${nearRaw}" placeholder="any"></label>
  <label>Distance<select name="km">${KMS.map((k) => html`<option value="${k}" ${k === km ? "selected" : ""}>${k === "any" ? "Any" : k + " km"}</option>`)}</select></label>
  <label class="check"><input type="checkbox" name="recruiting" value="all" ${recruitingOnly ? "" : "checked"}> Include not recruiting</label>
  <button type="submit">Filter</button>
  <datalist id="skill-names">${allSkills.map((s) => html`<option value="${s.name}"></option>`)}</datalist>
</form>
${region && nearRaw ? html`<p class="muted">Showing ${REGION_BY_SLUG.get(region)!.name}; the postcode and distance filters are not applied.</p>` : ""}
${nearRaw && !region && !origin ? html`<p class="error">Unknown postcode "${nearRaw}"; showing projects from anywhere.</p>` : ""}
<div class="results" data-live-topic="feed">
${cards.length ? cards.map(({ r, d }) => projectCard(r, d)) : html`<p class="empty">No projects match these filters. <a href="/projects/new">Start one</a>.</p>`}
</div>`,
  });
});
