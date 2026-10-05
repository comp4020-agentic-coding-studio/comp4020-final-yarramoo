import { Hono } from "hono";
import { html } from "hono/html";
import { CATEGORIES, CATEGORY_BY_SLUG } from "../categories.ts";
import { db } from "../db/index.ts";
import { notHidden } from "../provenance.ts";
import { REGION_BY_SLUG, regionSelect } from "../regions.ts";
import { page } from "../views/layout.ts";
import { projectCard, recruitingProjects } from "../views/cards.ts";

export const categories = new Hono();

categories.get("/c", (c) => {
  const counts = new Map(
    (db.prepare(
      `SELECT COALESCE(p.category, 'other') AS category, COUNT(*) AS n FROM projects p
       WHERE ${notHidden("project", "p.id")} AND p.status IN ('open','in_progress') AND p.recruiting = 1 GROUP BY 1`,
    ).all() as { category: string; n: number }[]).map((r) => [r.category, r.n]),
  );
  return page(c, {
    title: "Categories",
    body: html`<h1>Categories</h1>
<p class="muted">Counts are projects currently recruiting.</p>
<ul class="plain">${CATEGORIES.map((k) => html`<li><a href="/c/${k.slug}">${k.name}</a> <span class="muted">${counts.get(k.slug) ?? 0} recruiting · ${k.description}</span></li>`)}</ul>`,
  });
});

categories.get("/c/:slug", (c) => {
  const k = CATEGORY_BY_SLUG.get(c.req.param("slug"));
  if (!k) return page(c, { title: "Not found", body: html`<h1>No such category</h1><p><a href="/c">All categories</a></p>`, status: 404 });
  const region = REGION_BY_SLUG.has(c.req.query("region") ?? "") ? c.req.query("region")! : "";
  const cards = recruitingProjects(
    ["COALESCE(p.category, 'other') = ?", ...(region ? ["pc.region = ?"] : [])],
    region ? [k.slug, region] : [k.slug],
  );
  return page(c, {
    title: k.name,
    body: html`<h1>${k.name}</h1>
<p class="lead">${k.description}</p>
${k.safety ? html`<p class="safety"><strong>Safety:</strong> ${k.safety}</p>` : ""}
${k.resources?.length ? html`<h2>Clubs and resources</h2>
<ul class="plain">${k.resources.map((r) => html`<li><a href="${r.url}" rel="noopener" target="_blank">${r.name}</a> <span class="muted">${r.note}</span></li>`)}</ul>` : ""}
<form method="get" action="/c/${k.slug}" class="filters"><label>Region${regionSelect(region)}</label><button type="submit">Filter</button></form>
<h2>Projects</h2>
<div class="results">
${cards.length ? cards.map((p) => projectCard(p, null)) : html`<p class="empty">No projects are recruiting in this category${region ? " and region" : ""} yet. <a href="/projects/new">Start one</a>.</p>`}
</div>
<section id="lobby">
<!-- reserved for the next slice: the lobby for this category -->
</section>`,
  });
});
