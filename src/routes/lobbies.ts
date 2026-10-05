import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { currentUser, requireUser } from "../auth.ts";
import { publish } from "../bus.ts";
import { CATEGORIES, CATEGORY_BY_SLUG } from "../categories.ts";
import { db } from "../db/index.ts";
import {
  castVote, inLobby, joinLobby, leaveLobby, lobbyCounts, lobbyMembers, notifyElected, regionOfPostcode, setLobbyPublisher, tally,
} from "../lobbies.ts";
import { PLEDGE_ERR } from "../provenance.ts";
import { REGION_BY_SLUG } from "../regions.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";
import { teamInner } from "./requests.ts";

export const lobbies = new Hono();

const str = (v: unknown) => (typeof v === "string" ? v : "");
const deny = (c: Context, msg: string, status: 400 | 403 | 404 | 409 = 400, extra?: Html) =>
  page(c, { title: "Not allowed", body: html`<h1>${msg}</h1>${extra ?? ""}<p><a href="/lobbies">All lobbies</a></p>`, status });

const slugs = (category: string, region: string) => `${category}-${region}`;

// ---- fragments ----

/** Public progress for one lobby (count, bar, who is waiting). This is the live-replaceable part. */
export function lobbyProgressInner(category: string, region: string): Html {
  const k = CATEGORY_BY_SLUG.get(category)!;
  const ms = lobbyMembers(category, region);
  const need = k.teamSize!;
  return html`<p class="lobby-count"><strong>${ms.length} of ${need}</strong> interested</p>
<div class="lobby-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${ms.length}"><span style="width:${Math.min(100, Math.round((ms.length / need) * 100))}%"></span></div>
${ms.length ? html`<p class="muted lobby-waiting">Waiting: ${ms.map((m, i) => html`${i ? ", " : ""}<a href="/u/${m.handle}">@${m.handle}</a>`)}</p>` : html`<p class="muted lobby-waiting">Nobody yet.</p>`}`;
}

export function lobbyProgress(category: string, region: string): Html {
  return html`<div class="lobby-progress" id="lobby-progress-${slugs(category, region)}" data-live-topic="lobby:${category}:${region}">${lobbyProgressInner(category, region)}</div>`;
}

setLobbyPublisher((category, region) => {
  publish(`lobby:${category}:${region}`, { type: "lobby", html: String(lobbyProgressInner(category, region)), data: { category, region, count: lobbyMembers(category, region).length } });
});

type Me = NonNullable<ReturnType<typeof currentUser>>;

/** Join/leave controls for the signed-in viewer on one lobby; `full` adds note and skills fields. */
function lobbyControls(c: Context, me: Me | null, category: string, region: string, back: string, full: boolean): Html {
  const r = REGION_BY_SLUG.get(region)!;
  if (!me) return html`<p><a href="/login?next=${back}">Log in to join this lobby</a></p>`;
  const mine = regionOfPostcode(me.postcode);
  if (!me.postcode || !mine) return html`<p class="muted">Add your postcode on <a href="/me">your profile</a> to join a lobby in your region.</p>`;
  if (inLobby(category, region, me.id)) {
    return html`<form method="post" action="/lobbies/${category}/${region}/leave" class="inline">${csrfField(c)}<input type="hidden" name="back" value="${back}"><button type="submit" class="secondary">Leave lobby</button></form>`;
  }
  if (mine !== region) return html`<p class="muted">You can only join lobbies in your own region (${REGION_BY_SLUG.get(mine)!.name}), not ${r.name}.</p>`;
  return html`<form method="post" action="/lobbies/${category}/${region}/join" class="stack lobby-join">${csrfField(c)}<input type="hidden" name="back" value="${back}">
${full ? html`<label>What you'd like to do (optional)<input name="note" maxlength="280"></label>
<label>Skills you'd bring (comma-separated, optional)<input name="skills" maxlength="300" placeholder="soldering, cad"></label>
<label class="check"><input type="checkbox" name="pledge" value="1"> I wrote this note in my own words.</label>` : ""}
<p class="muted help">Teams meet in person: see our <a href="/safety">safety page</a>.</p>
<button type="submit">I'm interested</button></form>`;
}

/** The `#lobby` section on /c/:slug. */
export function categoryLobbySection(c: Context, categorySlug: string, regionQuery: string): Html {
  const k = CATEGORY_BY_SLUG.get(categorySlug)!;
  if (!k.teamSize) return html`<section id="lobby"></section>`;
  const me = currentUser(c);
  const region = REGION_BY_SLUG.has(regionQuery) ? regionQuery : regionOfPostcode(me?.postcode) ?? "";
  const back = `/c/${k.slug}${regionQuery ? `?region=${regionQuery}` : ""}`;
  const others = lobbyCounts({ category: k.slug }).filter((l) => l.region !== region);
  return html`<section id="lobby">
<h2>Interest lobby</h2>
<p class="muted">Nobody needs a project to start. Say you're interested; when ${k.teamSize} people in a region are, a team forms and votes in a leader.</p>
${region ? html`<h3>${REGION_BY_SLUG.get(region)!.name}</h3>${lobbyProgress(k.slug, region)}${lobbyControls(c, me, k.slug, region, back, true)}`
    : me ? html`<p class="muted">Add your postcode on <a href="/me">your profile</a> to join the lobby for your region.</p>`
    : html`<p><a href="/login?next=${back}">Log in</a> to join the lobby for your region.</p>`}
${others.length ? html`<h3>Other regions</h3><ul class="plain">${others.map((l) => html`<li><a href="/c/${k.slug}?region=${l.region}">${REGION_BY_SLUG.get(l.region)!.name}</a> <span class="muted">${l.n} of ${k.teamSize} interested</span></li>`)}</ul>` : ""}
</section>`;
}

/** The `#lobbies` section on /regions/:slug. */
export function regionLobbiesSection(c: Context, regionSlug: string): Html {
  const me = currentUser(c);
  const mine = regionOfPostcode(me?.postcode);
  const back = `/regions/${regionSlug}`;
  return html`<section id="lobbies">
<h2>Interest lobbies</h2>
<p class="muted">Say you're interested in a category; when enough people in ${REGION_BY_SLUG.get(regionSlug)!.name} are, a team forms. <a href="/lobbies">All lobbies</a></p>
<ul class="lobby-list">${CATEGORIES.filter((k) => k.teamSize).map((k) => html`<li class="lobby-row"><h3><a href="/c/${k.slug}">${k.name}</a></h3>${lobbyProgress(k.slug, regionSlug)}
${me && mine === regionSlug ? lobbyControls(c, me, k.slug, regionSlug, back, false) : ""}</li>`)}</ul>
${me && mine === regionSlug ? html`<p class="muted">Want to add a note or skills? Use the lobby form on the category page.</p>` : ""}
</section>`;
}

// ---- routes ----

lobbies.get("/lobbies", (c) => {
  const rows = lobbyCounts();
  const byRegion = new Map<string, typeof rows>();
  for (const l of rows) byRegion.set(l.region, [...(byRegion.get(l.region) ?? []), l]);
  return page(c, {
    title: "Lobbies",
    body: html`<h1>Lobbies</h1>
<p class="muted">People who are interested in a category in their region. When enough join, a team forms. Join from a <a href="/c">category</a> page.</p>
${byRegion.size ? [...byRegion].map(([region, ls]) => html`<section><h2><a href="/regions/${region}">${REGION_BY_SLUG.get(region)?.name ?? region}</a></h2>
<ul class="plain">${ls.map((l) => html`<li><a href="/c/${l.category}?region=${region}">${CATEGORY_BY_SLUG.get(l.category)?.name ?? l.category}</a> <span class="muted">${l.n} of ${CATEGORY_BY_SLUG.get(l.category)?.teamSize} interested</span></li>`)}</ul></section>`)
      : html`<p class="empty">No lobbies are waiting yet. Start one from a category page.</p>`}`,
  });
});

const backPath = (b: unknown, fallback: string) => {
  const s = str(b);
  return /^\/(c|regions)\/[a-z0-9-]+(\?region=[a-z-]+)?$/.test(s) ? s : fallback;
};

lobbies.post("/lobbies/:category/:region/join", requireUser, async (c) => {
  const me = currentUser(c)!;
  const k = CATEGORY_BY_SLUG.get(c.req.param("category"));
  const region = c.req.param("region");
  if (!k || !k.teamSize || !REGION_BY_SLUG.has(region)) return deny(c, "No such lobby", 404);
  const b = await c.req.parseBody();
  const mine = regionOfPostcode(me.postcode);
  if (!mine) return deny(c, "Add your postcode to join a lobby", 400, html`<p>Set it on <a href="/me">your profile</a>, then come back.</p>`);
  if (mine !== region) return deny(c, "You can only join lobbies in your own region", 403);
  const note = str(b.note).replace(/\r\n/g, "\n").trim();
  if (note.length > 280) return deny(c, "Your note is 280 characters at most");
  if (note && !str(b.pledge)) return deny(c, PLEDGE_ERR);
  const skills = str(b.skills).trim().slice(0, 300);
  if (inLobby(k.slug, region, me.id)) return deny(c, "You're already in this lobby", 409);
  const r = joinLobby(k.slug, region, me.id, note || null, skills || null);
  if (r.projectId) {
    flash(c, "Your team has formed. Vote for a leader.");
    return c.redirect(`/projects/${r.projectId}`);
  }
  flash(c, "You're on the list.");
  return c.redirect(backPath(b.back, `/c/${k.slug}`));
});

lobbies.post("/lobbies/:category/:region/leave", requireUser, async (c) => {
  const me = currentUser(c)!;
  const k = CATEGORY_BY_SLUG.get(c.req.param("category"));
  const region = c.req.param("region");
  if (!k || !k.teamSize || !REGION_BY_SLUG.has(region)) return deny(c, "No such lobby", 404);
  const b = await c.req.parseBody();
  if (!leaveLobby(k.slug, region, me.id)) return deny(c, "You aren't in this lobby", 409);
  flash(c, "You left the lobby.");
  return c.redirect(backPath(b.back, `/c/${k.slug}`));
});

// ---- leader vote ----

type P = { id: number; owner_id: number; leader_pending: number; formed_from_lobby: string | null };

function leaderBanner(p: P): Html {
  if (p.leader_pending) return html`<p id="leader-banner" class="leader-banner pending" role="status"><strong>Electing a leader.</strong> Nobody can edit the project or decide join requests until the team has one.</p>`;
  const h = db.prepare("SELECT handle FROM users WHERE id = ?").get(p.owner_id) as { handle: string };
  return html`<p id="leader-banner" class="leader-banner" role="status">Leader: <a href="/u/${h.handle}">@${h.handle}</a></p>`;
}

/** Project page: the leader banner (public) and the vote (members only). Empty for projects not formed from a lobby. */
export function leaderSection(c: Context, p: P): Html {
  if (!p.formed_from_lobby) return html``;
  const me = currentUser(c);
  const t = tally(p.id);
  const isMember = !!me && t.members.some((m) => m.id === me.id);
  const mine = me ? t.votesByVoter.get(me.id) : undefined;
  return html`<section id="leader-vote" data-project="${p.id}" data-live-topic="project:${p.id}" data-live-mode="none">
<h2>Team leader</h2>
${leaderBanner(p)}
${isMember ? html`<p class="muted">Each member has one vote and can change it at any time. A leader needs more than half the team's votes.</p>
<ul class="votes">${t.members.map((m) => html`<li data-candidate="${m.id}" class="${mine === m.id ? "voted" : ""}"><a href="/u/${m.handle}">${m.display_name || m.handle}</a>
<span class="vote-count" data-votes>${m.votes} vote${m.votes === 1 ? "" : "s"}</span>
<form method="post" action="/projects/${p.id}/vote" class="inline">${csrfField(c)}<input type="hidden" name="candidate" value="${m.id}"><button type="submit" class="${mine === m.id ? "" : "secondary"}" ${mine === m.id ? "aria-pressed=\"true\"" : ""}>${mine === m.id ? "Your vote" : "Vote"}</button></form></li>`)}</ul>`
    : html`<p class="muted">Only team members can see and cast votes.</p>`}
<script src="/public/lobbies.js" defer></script>
</section>`;
}

lobbies.post("/projects/:id/vote", requireUser, async (c) => {
  const me = currentUser(c)!;
  const ids = c.req.param("id");
  const p = /^\d{1,12}$/.test(ids) ? (db.prepare("SELECT id, title, owner_id, leader_pending, formed_from_lobby FROM projects WHERE id = ?").get(Number(ids)) as (P & { title: string }) | undefined) : undefined;
  if (!p || !p.formed_from_lobby) return deny(c, "No such team vote", 404);
  if (!db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, me.id)) return deny(c, "Only team members can vote", 403);
  const cs = str((await c.req.parseBody()).candidate);
  const cand = /^\d{1,12}$/.test(cs) ? Number(cs) : 0;
  if (!db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(p.id, cand)) return deny(c, "Vote for someone on the team");
  const { changedTo } = castVote(p.id, me.id, cand);
  const t = tally(p.id);
  const counts: Record<string, number> = Object.fromEntries(t.members.map((m) => [String(m.id), m.votes]));
  for (const m of t.members) {
    publish(`user:${m.id}`, { type: "votes", data: { project: p.id, counts, mine: t.votesByVoter.get(m.id) ?? null } });
  }
  if (changedTo !== null) {
    const now = db.prepare("SELECT id, owner_id, leader_pending, formed_from_lobby FROM projects WHERE id = ?").get(p.id) as P;
    publish(`project:${p.id}`, { type: "leader", html: String(leaderBanner(now)), data: { target: "#leader-banner", project: p.id } });
    publish(`project:${p.id}`, { type: "team", html: String(await teamInner(p.id)) });
    notifyElected(p.id, changedTo);
  }
  flash(c, "Vote recorded.");
  return c.redirect(`/projects/${p.id}`);
});
