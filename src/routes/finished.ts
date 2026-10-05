import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.ts";
import { categoryChip } from "../categories.ts";
import { notHidden } from "../provenance.ts";
import { REGION_BY_SLUG } from "../regions.ts";
import { themeChips } from "../themes.ts";
import { page, type Html } from "../views/layout.ts";

export const finished = new Hono();

type Row = { id: number; title: string; category: string | null; region: string | null; finished_at: string; upvotes: number };

const SELECT = `SELECT p.id, p.title, p.category, pc.region, p.finished_at,
    (SELECT COUNT(*) FROM upvotes uv WHERE uv.project_id = p.id) AS upvotes
  FROM projects p LEFT JOIN postcodes pc ON pc.postcode = p.postcode`;
const VISIBLE = `p.status = 'done' AND p.finished_at IS NOT NULL AND ${notHidden("project", "p.id")}`;

const photoOf = db.prepare(`SELECT ph.update_id, ph.path, ph.width, ph.height FROM photos ph JOIN updates up ON up.id = ph.update_id
  WHERE ph.project_id = ? AND ${notHidden("update", "up.id")} ORDER BY ph.id DESC LIMIT 1`);
const lastUpdate = db.prepare(`SELECT up.body FROM updates up WHERE up.project_id = ? AND ${notHidden("update", "up.id")} ORDER BY up.id DESC LIMIT 1`);
const teamOf = db.prepare("SELECT u.handle FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.rowid LIMIT 8");

const excerptOf = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + "…" : t;
};

/** One finished-build entry: photo first, then title, chips, excerpt of the final update, team and date. */
export function finishedCard(r: Row): Html {
  const photo = photoOf.get(r.id) as { update_id: number; path: string; width: number | null; height: number | null } | undefined;
  const last = lastUpdate.get(r.id) as { body: string } | undefined;
  const excerpt = last ? excerptOf(last.body) : "";
  const team = teamOf.all(r.id) as { handle: string }[];
  const region = r.region ? REGION_BY_SLUG.get(r.region) : undefined;
  return html`<article class="feed-card finished-card" id="fin-${r.id}">
${photo ? html`<a class="feed-photo" href="/projects/${r.id}#update-${photo.update_id}"><img src="/uploads/${photo.path}" ${photo.width && photo.height ? html`width="${photo.width}" height="${photo.height}"` : ""} loading="lazy" alt="Photo of ${r.title}"></a>` : ""}
<div class="feed-text">
<h2><a href="/projects/${r.id}">${r.title}</a></h2>
<p class="badges">${categoryChip(r.category)} ${region ? html`<a class="chip" href="/regions/${region.slug}">${region.name}</a>` : ""} ${themeChips(r.id)}</p>
${excerpt ? html`<p class="feed-body">${excerpt}</p>` : ""}
<p class="muted update-meta">Finished <time datetime="${r.finished_at.replace(" ", "T")}Z">${r.finished_at.slice(0, 10)}</time>${team.length ? html` · ${team.map((t, i) => html`${i ? ", " : ""}<a href="/u/${t.handle}">@${t.handle}</a>`)}` : ""}</p>
<p class="muted finished-votes" title="Community upvotes">▲ ${r.upvotes}</p>
</div>
</article>`;
}

/** Latest finished builds, newest first. */
export function recentFinished(limit: number, offset = 0): Row[] {
  return db.prepare(`${SELECT} WHERE ${VISIBLE} ORDER BY p.finished_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(limit, offset) as Row[];
}

/** The card for one just-finished project, or null if it is hidden or not done. */
export function finishedCardById(id: number): Html | null {
  const r = db.prepare(`${SELECT} WHERE p.id = ? AND ${VISIBLE}`).get(id) as Row | undefined;
  return r ? finishedCard(r) : null;
}

/** "Recently finished" strip for the browse page; prepends live when a project finishes. */
export function finishedStrip(): Html {
  const rows = recentFinished(4);
  return html`<section class="finished-section" aria-labelledby="finished-h">
<h2 id="finished-h">Recently finished <a class="more" href="/finished">See all</a></h2>
<p class="muted finished-empty" ${rows.length ? "hidden" : ""}>Nothing finished yet.</p>
<div class="finished-strip" data-live-topic="feed" data-live-types="finished" data-live-mode="prepend">${rows.map(finishedCard)}</div>
</section>`;
}

const PAGE = 30;

finished.get("/finished", (c) => {
  const n = /^\d{1,6}$/.test(c.req.query("page") ?? "") ? Math.max(1, Number(c.req.query("page"))) : 1;
  const rows = recentFinished(PAGE + 1, (n - 1) * PAGE);
  const more = rows.length > PAGE;
  return page(c, {
    title: "Finished builds",
    body: html`<h1>Finished builds</h1>
<p class="muted">Projects their teams have marked done, newest first.</p>
<div class="feed-grid finished-grid" data-live-topic="feed" data-live-types="finished" data-live-mode="prepend">
${rows.slice(0, PAGE).map(finishedCard)}
</div>
${rows.length ? "" : html`<p class="empty muted">${n > 1 ? "No more finished builds." : "Nothing has been finished yet."}</p>`}
<p class="pager">${n > 1 ? html`<a href="/finished${n > 2 ? `?page=${n - 1}` : ""}">Newer</a>` : ""} ${more ? html`<a href="/finished?page=${n + 1}">Older</a>` : ""}</p>`,
  });
});
