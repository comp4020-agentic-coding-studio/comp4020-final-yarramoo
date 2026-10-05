import { Hono } from "hono";
import { html } from "hono/html";
import { currentUser, requireUser } from "../auth.ts";
import { publish } from "../bus.ts";
import { db, skillIds, tx } from "../db/index.ts";
import { lookupPostcode } from "../geo.ts";
import { joinSection, teamList } from "./requests.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";

export const projects = new Hono();

const str = (v: unknown) => (typeof v === "string" ? v : "");
const STATUSES = ["open", "in_progress", "done"] as const;
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", done: "Done" };
const NEXT: Record<string, string[]> = { open: ["in_progress"], in_progress: ["open", "done"], done: ["in_progress"] };

type Project = {
  id: number; owner_id: number; title: string; summary: string; body: string; status: string;
  recruiting: number; postcode: string | null; created_at: string; updated_at: string;
};
type Values = { title: string; summary: string; body: string; skills: string; postcode: string; status?: string; recruiting?: boolean };

export const statusBadge = (s: string) => html`<span class="badge status-${s}">${STATUS_LABEL[s] ?? s}</span>`;
const day = (s: string) => s.slice(0, 10);

function form(c: Parameters<typeof csrfField>[0], action: string, v: Values, edit: boolean, error?: string): Html {
  return html`<h1>${edit ? "Edit project" : "New project"}</h1>
${error ? html`<p class="error">${error}</p>` : ""}
<form method="post" action="${action}" class="stack wide">
  ${csrfField(c)}
  <label>Title<input name="title" required maxlength="100" value="${v.title}"></label>
  <label>Summary (one or two lines)<textarea name="summary" required rows="2" maxlength="280">${v.summary}</textarea></label>
  <label>Details<textarea name="body" rows="10" maxlength="10000">${v.body}</textarea></label>
  <label>Skills needed (comma-separated)<input name="skills" maxlength="300" value="${v.skills}" placeholder="welding, arduino"></label>
  <label>Postcode (AU)<input name="postcode" required inputmode="numeric" maxlength="4" value="${v.postcode}"></label>
  ${edit ? html`<label>Status<select name="status">${STATUSES.map((s) => html`<option value="${s}" ${v.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`)}</select></label>
  <label class="check"><input type="checkbox" name="recruiting" value="1" ${v.recruiting ? "checked" : ""}> Recruiting for more collaborators</label>` : ""}
  <button type="submit">${edit ? "Save changes" : "Create project"}</button>
</form>`;
}

/** Validate shared fields; returns error string or cleaned values. */
function readForm(b: Record<string, unknown>): { error: string } | { v: Values } {
  const v: Values = {
    title: str(b.title).trim(), summary: str(b.summary).trim(), body: str(b.body).replace(/\r\n/g, "\n").trim(),
    skills: str(b.skills), postcode: str(b.postcode).trim(),
  };
  if (!v.title || v.title.length > 100) return { error: "Title is required (100 characters max)." };
  if (!v.summary || v.summary.length > 280) return { error: "Summary is required (280 characters max)." };
  if (v.body.length > 10000) return { error: "Details must be 10,000 characters or fewer." };
  if (!lookupPostcode(v.postcode)) return { error: "Unknown postcode." };
  return { v };
}

projects.get("/projects/new", requireUser, (c) => {
  const u = currentUser(c)!;
  return page(c, { title: "New project", body: form(c, "/projects/new", { title: "", summary: "", body: "", skills: "", postcode: u.postcode ?? "" }, false) });
});

projects.post("/projects/new", requireUser, async (c) => {
  const u = currentUser(c)!;
  const b = await c.req.parseBody();
  const r = readForm(b);
  if ("error" in r) {
    const raw: Values = { title: str(b.title), summary: str(b.summary), body: str(b.body), skills: str(b.skills), postcode: str(b.postcode) };
    return page(c, { title: "New project", body: form(c, "/projects/new", raw, false, r.error), status: 400 });
  }
  const v = r.v;
  const id = tx(() => {
    const pid = Number(db.prepare("INSERT INTO projects (owner_id, title, summary, body, postcode) VALUES (?,?,?,?,?)").run(u.id, v.title, v.summary, v.body, v.postcode).lastInsertRowid);
    db.prepare("INSERT INTO members (project_id, user_id, role) VALUES (?,?,'owner')").run(pid, u.id);
    const ins = db.prepare("INSERT OR IGNORE INTO project_skills (project_id, skill_id) VALUES (?,?)");
    for (const sid of skillIds(v.skills)) ins.run(pid, sid);
    return pid;
  });
  publish("feed", { type: "project", data: { id } });
  flash(c, "Project created.");
  return c.redirect(`/projects/${id}`);
});

function load(idStr: string): Project | null {
  if (!/^\d{1,12}$/.test(idStr)) return null;
  return (db.prepare("SELECT * FROM projects WHERE id = ?").get(Number(idStr)) as Project | undefined) ?? null;
}
const notFound = (c: Parameters<typeof page>[0]) => page(c, { title: "Not found", body: html`<h1>No such project</h1><p><a href="/">Back to browse</a></p>`, status: 404 });

projects.get("/projects/:id", (c) => {
  const p = load(c.req.param("id"));
  if (!p) return notFound(c);
  const me = currentUser(c);
  const owner = db.prepare("SELECT handle, display_name FROM users WHERE id = ?").get(p.owner_id) as { handle: string; display_name: string | null };
  const place = p.postcode ? lookupPostcode(p.postcode) : null;
  const skills = db.prepare(
    "SELECT s.name, u.handle AS filled FROM project_skills ps JOIN skills s ON s.id = ps.skill_id LEFT JOIN users u ON u.id = ps.filled_by WHERE ps.project_id = ? ORDER BY s.name",
  ).all(p.id) as { name: string; filled: string | null }[];
  return page(c, {
    title: p.title,
    body: html`<article class="project">
<h1>${p.title}</h1>
<p class="badges">${statusBadge(p.status)} ${p.recruiting ? html`<span class="badge recruiting">Recruiting</span>` : html`<span class="badge muted-badge">Not recruiting</span>`}
${me && me.id === p.owner_id ? html` <a href="/projects/${p.id}/edit">Edit</a>` : ""}</p>
<p class="muted">${place ? html`${place.locality}, ${place.state} ${place.postcode} · ` : ""}by <a href="/u/${owner.handle}">${owner.display_name || owner.handle}</a> · created ${day(p.created_at)} · updated ${day(p.updated_at)}</p>
<p class="lead">${p.summary}</p>
${p.body ? html`<div class="body-text">${p.body}</div>` : ""}
<h2>Skills needed</h2>
${skills.length ? html`<ul class="skill-list">${skills.map((s) => html`<li class="${s.filled ? "filled" : "open"}"><strong>${s.name}</strong> ${s.filled ? html`filled by <a href="/u/${s.filled}">@${s.filled}</a>` : html`<span class="muted">open</span>`}</li>`)}</ul>` : html`<p class="muted">No skills listed.</p>`}
<h2>Team</h2>
${teamList(p.id)}
<!-- SLICE-HOOK 2a: ask-to-join -->
${joinSection(c, p)}
<!-- SLICE-HOOK 2b: progress updates -->
<section id="updates"></section>
</article>`,
  });
});

function editPage(c: Parameters<typeof csrfField>[0], p: Project, v: Values, error?: string, status?: 400): Response | Promise<Response> {
  return page(c, { title: "Edit project", body: form(c, `/projects/${p.id}/edit`, v, true, error), status });
}

projects.get("/projects/:id/edit", requireUser, (c) => {
  const p = load(c.req.param("id"));
  if (!p) return notFound(c);
  if (p.owner_id !== currentUser(c)!.id) return page(c, { title: "Forbidden", body: html`<h1>Only the owner can edit this project</h1>`, status: 403 });
  const skills = (db.prepare("SELECT s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ? ORDER BY s.name").all(p.id) as { name: string }[]).map((s) => s.name).join(", ");
  return editPage(c, p, { title: p.title, summary: p.summary, body: p.body, skills, postcode: p.postcode ?? "", status: p.status, recruiting: !!p.recruiting });
});

projects.post("/projects/:id/edit", requireUser, async (c) => {
  const p = load(c.req.param("id"));
  if (!p) return notFound(c);
  if (p.owner_id !== currentUser(c)!.id) return page(c, { title: "Forbidden", body: html`<h1>Only the owner can edit this project</h1>`, status: 403 });
  const b = await c.req.parseBody();
  const status = str(b.status);
  const recruiting = str(b.recruiting) === "1";
  const raw: Values = { title: str(b.title), summary: str(b.summary), body: str(b.body), skills: str(b.skills), postcode: str(b.postcode), status, recruiting };
  const r = readForm(b);
  if ("error" in r) return editPage(c, p, raw, r.error, 400);
  if (!(STATUSES as readonly string[]).includes(status)) return editPage(c, p, raw, "Invalid status.", 400);
  if (status !== p.status && !NEXT[p.status]!.includes(status)) {
    return editPage(c, p, raw, `Cannot move a project from ${STATUS_LABEL[p.status]} to ${STATUS_LABEL[status]}.`, 400);
  }
  const v = r.v;
  let kept: string[] = [];
  tx(() => {
    db.prepare("UPDATE projects SET title=?, summary=?, body=?, postcode=?, status=?, recruiting=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(v.title, v.summary, v.body, v.postcode, status, recruiting ? 1 : 0, p.id);
    const want = new Set(skillIds(v.skills));
    const have = db.prepare("SELECT ps.skill_id, ps.filled_by, s.name FROM project_skills ps JOIN skills s ON s.id = ps.skill_id WHERE ps.project_id = ?")
      .all(p.id) as { skill_id: number; filled_by: number | null; name: string }[];
    const haveIds = new Set(have.map((h) => h.skill_id));
    for (const h of have) {
      if (want.has(h.skill_id)) continue;
      if (h.filled_by) kept.push(h.name);
      else db.prepare("DELETE FROM project_skills WHERE project_id = ? AND skill_id = ?").run(p.id, h.skill_id);
    }
    for (const sid of want) if (!haveIds.has(sid)) db.prepare("INSERT INTO project_skills (project_id, skill_id) VALUES (?,?)").run(p.id, sid);
  });
  publish("feed", { type: "project", data: { id: p.id } });
  flash(c, kept.length ? `Saved. Kept filled skills that you removed: ${kept.join(", ")}.` : "Project saved.", "ok");
  return c.redirect(`/projects/${p.id}`);
});
