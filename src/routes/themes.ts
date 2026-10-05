import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.ts";
import { notHidden } from "../provenance.ts";
import { REGION_BY_SLUG, regionSelect } from "../regions.ts";
import { THEMES, THEME_BY_SLUG } from "../themes.ts";
import { CARD_SELECT, projectCard, type CardRow } from "../views/cards.ts";
import { page } from "../views/layout.ts";

export const themes = new Hono();

themes.get("/t", (c) => {
  const counts = new Map(
    (db.prepare(
      `SELECT pt.theme, COUNT(*) AS n FROM project_themes pt JOIN projects p ON p.id = pt.project_id
       WHERE ${notHidden("project", "p.id")} GROUP BY pt.theme`,
    ).all() as { theme: string; n: number }[]).map((r) => [r.theme, r.n]),
  );
  return page(c, {
    title: "Themes",
    body: html`<h1>Themes</h1>
<p class="muted">Themes cut across categories. A project can carry up to three.</p>
<ul class="plain">${THEMES.map((t) => html`<li><a href="/t/${t.slug}">${t.name}</a> <span class="muted">${counts.get(t.slug) ?? 0} project${counts.get(t.slug) === 1 ? "" : "s"} · ${t.intro}</span></li>`)}</ul>`,
  });
});

themes.get("/t/:slug", (c) => {
  const t = THEME_BY_SLUG.get(c.req.param("slug"));
  if (!t) return page(c, { title: "Not found", body: html`<h1>No such theme</h1><p><a href="/t">All themes</a></p>`, status: 404 });
  const region = REGION_BY_SLUG.has(c.req.query("region") ?? "") ? c.req.query("region")! : "";
  const rows = db.prepare(
    `${CARD_SELECT} WHERE EXISTS (SELECT 1 FROM project_themes pt WHERE pt.project_id = p.id AND pt.theme = ?)
       AND ${notHidden("project", "p.id")} ${region ? "AND pc.region = ?" : ""}
     ORDER BY (p.status = 'done') DESC, upvotes DESC, p.updated_at DESC, p.id DESC LIMIT 50`,
  ).all(...(region ? [t.slug, region] : [t.slug])) as CardRow[];
  return page(c, {
    title: t.name,
    body: html`<h1>${t.name}</h1>
<p class="lead">${t.intro}</p>
${t.resources.length ? html`<h2>Resources</h2><ul class="plain">${t.resources.map((r) => html`<li><a href="${r.url}" rel="noopener" target="_blank">${r.name}</a> <span class="muted">${r.note}</span></li>`)}</ul>` : ""}
<form method="get" action="/t/${t.slug}" class="filters"><label>Region${regionSelect(region)}</label><button type="submit">Filter</button></form>
<h2>Exemplar projects</h2>
<p class="muted">Finished builds first, then by community upvotes.</p>
<div class="results">
${rows.length ? rows.map((r) => projectCard(r, null)) : html`<p class="empty">No projects carry this theme${region ? " in this region" : ""} yet. <a href="/projects/new">Start one</a>.</p>`}
</div>`,
  });
});
