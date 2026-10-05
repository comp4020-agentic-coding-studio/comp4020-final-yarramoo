import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { currentUser, requireUser } from "../auth.ts";
import { publish } from "../bus.ts";
import { db, skillIds, tx } from "../db/index.ts";
import { provenanceBadge, provenanceLabel, readProvenance, renderBody, saveProvenance } from "../provenance.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";

export const board = new Hono();

const str = (v: unknown) => (typeof v === "string" ? v : "");
const day = (s: string) => s.slice(0, 10);
const FLAG_THRESHOLD = 3;
const PLEDGE_ERR = "Please tick the pledge: this site is for human-written text.";

type Q = {
  id: number; author_id: number; title: string; body: string; project_id: number | null; accepted_answer_id: number | null;
  created_at: string; handle: string; display_name: string | null; n_answers: number; n_helped: number;
};
type A = {
  id: number; question_id: number; author_id: number; body: string; created_at: string;
  handle: string; display_name: string | null; n_helped: number;
};

const Q_SQL = `SELECT q.*, u.handle, u.display_name,
  (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) AS n_answers,
  (SELECT COUNT(*) FROM helped h JOIN answers a ON a.id = h.answer_id WHERE a.question_id = q.id) AS n_helped
  FROM questions q JOIN users u ON u.id = q.author_id`;
const A_SQL = `SELECT a.*, u.handle, u.display_name, (SELECT COUNT(*) FROM helped h WHERE h.answer_id = a.id) AS n_helped
  FROM answers a JOIN users u ON u.id = a.author_id`;

const idOf = (s: string) => (/^\d{1,12}$/.test(s) ? Number(s) : null);
const loadQ = (id: number | null) => (id === null ? null : (db.prepare(`${Q_SQL} WHERE q.id = ?`).get(id) as Q | undefined) ?? null);
const loadA = (id: number | null) => (id === null ? null : (db.prepare(`${A_SQL} WHERE a.id = ?`).get(id) as A | undefined) ?? null);
const skillsOf = (qid: number) =>
  (db.prepare("SELECT s.name FROM question_skills qs JOIN skills s ON s.id = qs.skill_id WHERE qs.question_id = ? ORDER BY s.name").all(qid) as { name: string }[]).map((s) => s.name);
const who = (r: { handle: string; display_name: string | null }) => html`<a href="/u/${r.handle}">${r.display_name || r.handle}</a>`;

// ---------- question list ----------

/** One list entry. Same function for the page and for live "question" events. */
export function questionItem(q: Q): Html {
  const skills = skillsOf(q.id);
  return html`<article class="q-item" data-provenance="${provenanceLabel("question", q.id)}">
  <h2><a href="/questions/${q.id}">${q.title}</a></h2>
  <p class="muted q-meta">by ${who(q)} · ${day(q.created_at)} · ${q.n_answers} ${q.n_answers === 1 ? "answer" : "answers"} · helped ${q.n_helped}
  ${q.accepted_answer_id ? html`<span class="badge status-done">Accepted</span>` : q.n_answers > 0 ? html`<span class="badge status-in_progress">Answered</span>` : ""}
  ${provenanceBadge("question", q.id)}</p>
  ${skills.length ? html`<ul class="tags">${skills.map((s) => html`<li><a href="/questions?skill=${encodeURIComponent(s)}">${s}</a></li>`)}</ul>` : ""}
</article>`;
}

board.get("/questions", (c) => {
  const skill = str(c.req.query("skill")).trim().toLowerCase();
  const unanswered = c.req.query("unanswered") === "1";
  const where: string[] = [];
  const args: string[] = [];
  if (skill) {
    where.push("q.id IN (SELECT qs.question_id FROM question_skills qs JOIN skills s ON s.id = qs.skill_id WHERE s.name = ?)");
    args.push(skill);
  }
  if (unanswered) where.push("NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id)");
  const rows = db.prepare(`${Q_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY q.created_at DESC, q.id DESC LIMIT 200`).all(...args) as Q[];
  return page(c, {
    title: "Questions",
    body: html`<h1>Questions</h1>
<p>Stuck on a build? Ask people who have been there. <a href="/questions/new">Ask a question</a></p>
<form method="get" action="/questions" class="filters">
  <label>Skill<input name="skill" value="${skill}" placeholder="e.g. soldering"></label>
  <label class="check"><input type="checkbox" name="unanswered" value="1" ${unanswered ? "checked" : ""}> Unanswered only</label>
  <button type="submit">Filter</button>
</form>
${rows.length ? "" : html`<p class="muted">No questions match.</p>`}
<div id="question-list" class="q-list" data-live-topic="feed" data-live-target="#question-list" data-live-mode="prepend">${rows.map(questionItem)}</div>`,
  });
});

// ---------- ask ----------

type QValues = { title: string; body: string; skills: string; project: string };

function myProjects(uid: number) {
  return db.prepare(
    `SELECT DISTINCT p.id, p.title FROM projects p LEFT JOIN members m ON m.project_id = p.id AND m.user_id = ?
     WHERE p.owner_id = ? OR m.user_id IS NOT NULL ORDER BY p.title`,
  ).all(uid, uid) as { id: number; title: string }[];
}

function askPage(c: Context, v: QValues, error?: string) {
  const me = currentUser(c)!;
  const projs = myProjects(me.id);
  return page(c, {
    title: "Ask a question",
    status: error ? 400 : 200,
    body: html`<h1>Ask a question</h1>
<p class="lead">Ask with what you've tried: the specific bench, the failure, and a link to a photo if you have one.</p>
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<form method="post" action="/questions/new" class="stack wide">
  ${csrfField(c)}
  <label>Title<input name="title" required minlength="10" maxlength="150" value="${v.title}"></label>
  <label>Question<textarea name="body" required rows="10" minlength="30" maxlength="10000" data-provenance>${v.body}</textarea></label>
  <label>Skills (comma separated)<input name="skills" value="${v.skills}" placeholder="soldering, arduino"></label>
  <label>About a project (optional)
    <select name="project"><option value="">None</option>${projs.map((p) => html`<option value="${p.id}" ${String(p.id) === v.project ? "selected" : ""}>${p.title}</option>`)}</select>
  </label>
  <label class="check"><input type="checkbox" name="pledge" value="1" required> I wrote this myself, without AI.</label>
  <button type="submit">Post question</button>
</form>
<script src="/public/provenance.js" defer></script>`,
  });
}

board.get("/questions/new", requireUser, (c) => askPage(c, { title: "", body: "", skills: "", project: str(c.req.query("project")) }));

board.post("/questions/new", requireUser, async (c) => {
  const me = currentUser(c)!;
  const b = await c.req.parseBody();
  const v: QValues = { title: str(b.title).trim(), body: str(b.body).replace(/\r\n?/g, "\n").trim(), skills: str(b.skills), project: str(b.project) };
  if (v.title.length < 10 || v.title.length > 150) return askPage(c, v, "Title must be 10 to 150 characters.");
  if (v.body.length < 30 || v.body.length > 10000) return askPage(c, v, "The question must be 30 to 10,000 characters.");
  if (!str(b.pledge)) return askPage(c, v, PLEDGE_ERR);
  let projectId: number | null = null;
  if (v.project) {
    projectId = idOf(v.project);
    if (projectId === null || !myProjects(me.id).some((p) => p.id === projectId)) return askPage(c, v, "Pick one of your own projects, or none.");
  }
  const prov = readProvenance(b, v.body);
  const id = tx(() => {
    const r = db.prepare("INSERT INTO questions (author_id, title, body, project_id) VALUES (?,?,?,?)").run(me.id, v.title, v.body, projectId);
    const qid = Number(r.lastInsertRowid);
    for (const sid of skillIds(v.skills)) db.prepare("INSERT OR IGNORE INTO question_skills (question_id, skill_id) VALUES (?,?)").run(qid, sid);
    saveProvenance("question", qid, prov);
    return qid;
  });
  publish("feed", { type: "question", html: String(questionItem(loadQ(id)!)) });
  return c.redirect(`/questions/${id}`);
});

// ---------- question page ----------

type CardOpts = { c?: Context; viewer?: number | null; qAuthor: number; accepted: boolean; flagged?: boolean; helpedByMe?: boolean };

/**
 * One answer card. With `c` (a real viewer) it carries per-user forms. Without it (live events,
 * rendered once for everybody) it carries no forms at all: the helped count is a link to the
 * question page, where the viewer's own buttons live. So live HTML never needs a CSRF token.
 */
export function answerCard(a: A, o: CardOpts): Html {
  const label = provenanceLabel("answer", a.id);
  let actions: Html;
  if (!o.c || !o.viewer) {
    actions = o.c
      ? html`<span class="muted">Helped (${a.n_helped})</span>`
      : html`<a href="/questions/${a.question_id}#answer-${a.id}">Helped (${a.n_helped})</a>`;
  } else {
    const mine = o.viewer === a.author_id;
    actions = html`
${mine ? html`<span class="muted">Helped (${a.n_helped})</span>` : html`<form method="post" action="/answers/${a.id}/helped" class="inline">${csrfField(o.c)}<button type="submit" class="${o.helpedByMe ? "on" : "ghost"}" aria-pressed="${o.helpedByMe ? "true" : "false"}">This helped (${a.n_helped})</button></form>`}
${o.viewer === o.qAuthor ? html`<form method="post" action="/questions/${a.question_id}/accept/${a.id}" class="inline">${csrfField(o.c)}<button type="submit" class="ghost">${o.accepted ? "Unaccept" : "Accept"}</button></form>` : ""}
${mine ? "" : o.flagged ? html`<span class="muted">Flagged — thanks</span>` : html`<form method="post" action="/flags" class="inline">${csrfField(o.c)}<input type="hidden" name="target_type" value="answer"><input type="hidden" name="target_id" value="${a.id}"><button type="submit" class="link">Flag as machine-written</button></form>`}`;
  }
  return html`<article class="answer${o.accepted ? " accepted" : ""}" id="answer-${a.id}" data-provenance="${label}">
  <p class="muted q-meta">${o.accepted ? html`<span class="badge status-done">Accepted</span> ` : ""}${who(a)} · ${day(a.created_at)} ${provenanceBadge("answer", a.id)}</p>
  ${renderBody(a.body)}
  <p class="answer-actions">${actions}</p>
</article>`;
}

/** Generic (viewer-less) card for an answer, as sent over the bus. */
function genericCard(aid: number): string {
  const a = loadA(aid)!;
  const q = loadQ(a.question_id)!;
  return String(answerCard(a, { qAuthor: q.author_id, accepted: q.accepted_answer_id === a.id }));
}

function questionPage(c: Context, q: Q, o: { answerBody?: string; error?: string; status?: 400 } = {}) {
  const me = currentUser(c);
  const skills = skillsOf(q.id);
  const project = q.project_id ? (db.prepare("SELECT id, title FROM projects WHERE id = ?").get(q.project_id) as { id: number; title: string } | undefined) : undefined;
  const answers = db.prepare(`${A_SQL} WHERE a.question_id = ? ORDER BY (a.id = ?) DESC, n_helped DESC, a.id ASC`).all(q.id, q.accepted_answer_id ?? -1) as A[];
  const helpedSet = new Set(me ? (db.prepare("SELECT h.answer_id FROM helped h JOIN answers a ON a.id = h.answer_id WHERE a.question_id = ? AND h.user_id = ?").all(q.id, me.id) as { answer_id: number }[]).map((r) => r.answer_id) : []);
  const flagged = (type: string, id: number) => !!me && !!db.prepare("SELECT 1 FROM flags WHERE target_type = ? AND target_id = ? AND user_id = ?").get(type, id, me.id);
  const qFlag = !me || me.id === q.author_id ? "" : flagged("question", q.id)
    ? html`<span class="muted">Flagged — thanks</span>`
    : html`<form method="post" action="/flags" class="inline">${csrfField(c)}<input type="hidden" name="target_type" value="question"><input type="hidden" name="target_id" value="${q.id}"><button type="submit" class="link">Flag as machine-written</button></form>`;
  return page(c, {
    title: q.title,
    status: o.status,
    body: html`<article class="question" data-provenance="${provenanceLabel("question", q.id)}">
<h1>${q.title}</h1>
<p class="muted q-meta">asked by ${who(q)} · ${day(q.created_at)} ${provenanceBadge("question", q.id)}</p>
${project ? html`<p>About the project <a href="/projects/${project.id}">${project.title}</a></p>` : ""}
${skills.length ? html`<ul class="tags">${skills.map((s) => html`<li><a href="/questions?skill=${encodeURIComponent(s)}">${s}</a></li>`)}</ul>` : ""}
${renderBody(q.body)}
<p class="answer-actions">${qFlag}</p>
</article>
<h2>${answers.length} ${answers.length === 1 ? "answer" : "answers"}</h2>
<div id="answers" data-live-topic="question:${q.id}" data-live-target="#answers" data-live-mode="append">${answers.map((a) =>
      answerCard(a, { c, viewer: me?.id ?? null, qAuthor: q.author_id, accepted: q.accepted_answer_id === a.id, flagged: flagged("answer", a.id), helpedByMe: helpedSet.has(a.id) }))}</div>
<h2>Your answer</h2>
${me ? html`${o.error ? html`<p class="error" role="alert">${o.error}</p>` : ""}
<form method="post" action="/questions/${q.id}/answers" class="stack wide">
  ${csrfField(c)}
  <label>Answer<textarea name="body" required rows="8" minlength="10" maxlength="10000" data-provenance>${o.answerBody ?? ""}</textarea></label>
  <label class="check"><input type="checkbox" name="pledge" value="1" required> I wrote this myself, without AI.</label>
  <button type="submit">Post answer</button>
</form>
<script src="/public/provenance.js" defer></script>` : html`<p><a href="/login?next=${encodeURIComponent(`/questions/${q.id}`)}">Log in</a> to answer.</p>`}`,
  });
}

const notFound = (c: Context) => page(c, { title: "Not found", body: html`<h1>No such question</h1><p><a href="/questions">Back to questions</a></p>`, status: 404 });

board.get("/questions/:id", (c) => {
  const q = loadQ(idOf(c.req.param("id")));
  return q ? questionPage(c, q) : notFound(c);
});

board.post("/questions/:id/answers", requireUser, async (c) => {
  const q = loadQ(idOf(c.req.param("id")));
  if (!q) return notFound(c);
  const me = currentUser(c)!;
  const b = await c.req.parseBody();
  const body = str(b.body).replace(/\r\n?/g, "\n").trim();
  if (body.length < 10 || body.length > 10000) return questionPage(c, q, { answerBody: body, error: "The answer must be 10 to 10,000 characters.", status: 400 });
  if (!str(b.pledge)) return questionPage(c, q, { answerBody: body, error: PLEDGE_ERR, status: 400 });
  const prov = readProvenance(b, body);
  const aid = tx(() => {
    const r = db.prepare("INSERT INTO answers (question_id, author_id, body) VALUES (?,?,?)").run(q.id, me.id, body);
    saveProvenance("answer", Number(r.lastInsertRowid), prov);
    return Number(r.lastInsertRowid);
  });
  publish(`question:${q.id}`, { type: "answer", html: genericCard(aid) });
  return c.redirect(`/questions/${q.id}#answer-${aid}`);
});

// ---------- helped / accept / flag ----------

function announceChange(aid: number): void {
  const a = loadA(aid);
  if (a) publish(`question:${a.question_id}`, { type: "answer-changed", html: genericCard(aid), data: { target: `#answer-${aid}` } });
}

board.post("/answers/:id/helped", requireUser, (c) => {
  const a = loadA(idOf(c.req.param("id")));
  if (!a) return notFound(c);
  const me = currentUser(c)!;
  if (a.author_id === me.id) return page(c, { title: "Not allowed", body: html`<h1>You can't mark your own answer as helpful</h1><p><a href="/questions/${a.question_id}">Back</a></p>`, status: 403 });
  tx(() => {
    const del = db.prepare("DELETE FROM helped WHERE answer_id = ? AND user_id = ?").run(a.id, me.id);
    if (!del.changes) db.prepare("INSERT INTO helped (answer_id, user_id) VALUES (?,?)").run(a.id, me.id);
  });
  announceChange(a.id);
  return c.redirect(`/questions/${a.question_id}#answer-${a.id}`);
});

board.post("/questions/:id/accept/:aid", requireUser, (c) => {
  const q = loadQ(idOf(c.req.param("id")));
  if (!q) return notFound(c);
  if (q.author_id !== currentUser(c)!.id) return page(c, { title: "Not allowed", body: html`<h1>Only the question's author can accept an answer</h1>`, status: 403 });
  const a = loadA(idOf(c.req.param("aid")));
  if (!a || a.question_id !== q.id) return notFound(c);
  const next = q.accepted_answer_id === a.id ? null : a.id;
  db.prepare("UPDATE questions SET accepted_answer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(next, q.id);
  if (q.accepted_answer_id && q.accepted_answer_id !== a.id) announceChange(q.accepted_answer_id);
  announceChange(a.id);
  return c.redirect(`/questions/${q.id}#answer-${a.id}`);
});

board.post("/flags", requireUser, async (c) => {
  const me = currentUser(c)!;
  const b = await c.req.parseBody();
  const type = str(b.target_type);
  const tid = idOf(str(b.target_id));
  if ((type !== "question" && type !== "answer") || tid === null) return c.text("Bad flag", 400);
  const t = type === "question"
    ? (db.prepare("SELECT id AS qid, author_id FROM questions WHERE id = ?").get(tid) as { qid: number; author_id: number } | undefined)
    : (db.prepare("SELECT question_id AS qid, author_id FROM answers WHERE id = ?").get(tid) as { qid: number; author_id: number } | undefined);
  if (!t) return notFound(c);
  if (t.author_id === me.id) return page(c, { title: "Not allowed", body: html`<h1>You can't flag your own post</h1>`, status: 403 });
  tx(() => {
    db.prepare("INSERT OR IGNORE INTO flags (target_type, target_id, user_id, reason) VALUES (?,?,?,?)").run(type, tid, me.id, str(b.reason).slice(0, 500) || null);
    const n = (db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM flags WHERE target_type = ? AND target_id = ?").get(type, tid) as { n: number }).n;
    // Backend-only signal; never rendered as such.
    if (n >= FLAG_THRESHOLD) {
      db.prepare("INSERT INTO provenance (target_type, target_id, pledged, potentially_ai) VALUES (?,?,1,1) ON CONFLICT (target_type, target_id) DO UPDATE SET potentially_ai = 1").run(type, tid);
    }
  });
  flash(c, "Flagged — thanks.", "ok");
  return c.redirect(type === "answer" ? `/questions/${t.qid}#answer-${tid}` : `/questions/${t.qid}`);
});

// ---------- project page section ----------

export function questionsSection(projectId: number): Html {
  const qs = db.prepare("SELECT id, title FROM questions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 20").all(projectId) as { id: number; title: string }[];
  return html`<h2 id="questions">Questions about this project</h2>
${qs.length ? html`<ul>${qs.map((q) => html`<li><a href="/questions/${q.id}">${q.title}</a></li>`)}</ul>` : html`<p class="muted">No questions yet.</p>`}
<p><a href="/questions/new?project=${projectId}">Ask a question about this project</a></p>`;
}

// ---------- scraping signals ----------

const POLICY = "This site is for human-written text. AI-written posts are not allowed. Each question and answer carries an honest, non-authoritative provenance label (typed, pasted, unknown).";

board.get("/robots.txt", (c) =>
  c.text(`# Makers Wanted is a place for human-written text.
# Posts here are written by people, for people, and AI-written posts are not allowed.
# Please do not use this content to train generative models or to generate replacement text.
# A provenance label for each question and answer is published at /provenance.json.

User-agent: *
Allow: /
`));

board.get("/provenance.json", (c) => {
  const rows = db.prepare(
    `SELECT type, id, qid, created_at FROM (
       SELECT 'question' AS type, id, id AS qid, created_at FROM questions
       UNION ALL SELECT 'answer', id, question_id, created_at FROM answers
     ) ORDER BY created_at DESC, id DESC LIMIT 500`,
  ).all() as { type: "question" | "answer"; id: number; qid: number; created_at: string }[];
  return c.json({
    policy: POLICY,
    items: rows.map((r) => ({
      type: r.type, id: r.id,
      url: r.type === "question" ? `/questions/${r.id}` : `/questions/${r.qid}#answer-${r.id}`,
      label: provenanceLabel(r.type, r.id),
      created_at: r.created_at,
    })),
  });
});
