import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.ts";
import { notHidden } from "../provenance.ts";
import { REGION_BY_SLUG, regionsByState } from "../regions.ts";
import { CATEGORIES, CATEGORY_BY_SLUG } from "../categories.ts";
import { page } from "../views/layout.ts";
import { projectCard, recruitingProjects } from "../views/cards.ts";

export const regions = new Hono();

regions.get("/regions", (c) => {
  const counts = new Map(
    (db.prepare(
      `SELECT pc.region, COUNT(*) AS n FROM projects p JOIN postcodes pc ON pc.postcode = p.postcode
       WHERE ${notHidden("project", "p.id")} AND p.status IN ('open','in_progress') AND p.recruiting = 1 GROUP BY pc.region`,
    ).all() as { region: string; n: number }[]).map((r) => [r.region, r.n]),
  );
  return page(c, {
    title: "Regions",
    body: html`<h1>Regions</h1>
<p class="muted">Capital-city metros and regional areas. Counts are projects currently recruiting.</p>
${regionsByState().map((g) => html`<section class="region-group"><h2>${g.state}</h2>
<ul class="plain">${g.regions.map((r) => html`<li><a href="/regions/${r.slug}">${r.name}</a> <span class="muted">${counts.get(r.slug) ?? 0} recruiting</span></li>`)}</ul></section>`)}`,
  });
});

regions.get("/regions/:slug", (c) => {
  const r = REGION_BY_SLUG.get(c.req.param("slug"));
  if (!r) return page(c, { title: "Not found", body: html`<h1>No such region</h1><p><a href="/regions">All regions</a></p>`, status: 404 });
  const cat = CATEGORY_BY_SLUG.has(c.req.query("category") ?? "") ? c.req.query("category")! : "";
  const cards = recruitingProjects(cat ? ["pc.region = ?", "COALESCE(p.category, 'other') = ?"] : ["pc.region = ?"], cat ? [r.slug, cat] : [r.slug]);
  return page(c, {
    title: r.name,
    body: html`<h1>${r.name}</h1>
<p class="muted"><a href="/regions">All regions</a> · <a href="/?region=${r.slug}&go=1&recruiting=all&status=any">Browse everything here, including finished projects</a></p>
<p class="chips" aria-label="Narrow by category"><a class="chip ${cat ? "" : "current"}" href="/regions/${r.slug}">All</a>${CATEGORIES.map((k) => html`<a class="chip ${k.slug === cat ? "current" : ""}" href="/regions/${r.slug}?category=${k.slug}">${k.name}</a>`)}</p>
<div class="results">
${cards.length ? cards.map((p) => projectCard(p, null)) : html`<p class="empty">No projects are recruiting here yet. <a href="/projects/new">Start one</a>.</p>`}
</div>
<section id="lobbies">
<!-- reserved for the next slice: lobbies for this region -->
</section>`,
  });
});
