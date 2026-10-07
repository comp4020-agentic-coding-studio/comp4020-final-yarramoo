import { exampleBadge } from "../examples.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { currentUser, requireUser } from "../auth.ts";
import { announce } from "../activity.ts";
import { publish } from "../bus.ts";
import { blockedIds, collapsed } from "../blocks.ts";
import { notify, short } from "../notify.ts";
import { reportLink } from "../reports.ts";
import { db, tx } from "../db/index.ts";
import { isAdmin, isHidden, notHidden, PLEDGE_ERR, pledgeField, readProvenance, saveProvenance, UNDER_REVIEW } from "../provenance.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";

export const updates = new Hono();

const UPLOAD_DIR = join(process.env.DATA_DIR ?? "/data", "uploads");
const MAX_FILES = 6;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_BODY = 5000;
const MAX_REQUEST = 14 * 1024 * 1024;
const FILE_RE = /^[0-9a-f]{32}\.(jpg|png|webp)$/;
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Mounted in server.ts before the global CSRF guard (which buffers the body), so oversize uploads are cut off early. */
export const updatesBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST,
  onError: (c) => c.text("Upload too large", 413),
});

type Img = { ext: "jpg" | "png" | "webp"; width: number | null; height: number | null };

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Sniff magic bytes and read dimensions from the header. Returns null if not a supported image. */
export function sniffImage(b: Uint8Array): Img | null {
  try {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1]!;
        if (m === 0xff) { o++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = u16be(b, o + 5), w = u16be(b, o + 7);
          return { ext: "jpg", width: w || null, height: h || null };
        }
        o += 2 + u16be(b, o + 2);
      }
      return { ext: "jpg", width: null, height: null };
    }
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
      if (b.length >= 24 && ascii(b, 12, 4) === "IHDR") return { ext: "png", width: u32be(b, 16) || null, height: u32be(b, 20) || null };
      return { ext: "png", width: null, height: null };
    }
    if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
      const kind = b.length >= 16 ? ascii(b, 12, 4) : "";
      if (kind === "VP8X" && b.length >= 30) return { ext: "webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
      if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
        const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
        return { ext: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (kind === "VP8 " && b.length >= 30) return { ext: "webp", width: (u16le(b, 26) & 0x3fff) || null, height: (u16le(b, 28) & 0x3fff) || null };
      return { ext: "webp", width: null, height: null };
    }
  } catch { /* fall through */ }
  return null;
}

export type UpdateRow = { id: number; project_id: number; author_id: number; body: string; created_at: string; handle: string; display_name: string | null; project_title: string };
export type PhotoRow = { path: string; width: number | null; height: number | null };

const when = (s: string) => html`<time datetime="${s.replace(" ", "T")}Z">${s.slice(0, 16)} UTC</time>`;

const imgs = (row: UpdateRow, photos: PhotoRow[]) =>
  photos.map((p) => html`<img src="/uploads/${p.path}" ${p.width && p.height ? html`width="${p.width}" height="${p.height}"` : ""} loading="lazy" alt="Progress photo for ${row.project_title}">`);

/** One timeline entry (project page). */
export function updateCard(row: UpdateRow, photos: PhotoRow[], review = false, reportable = false): Html {
  return html`<article class="update-card" id="update-${row.id}">
<p class="muted update-meta"><a href="/u/${row.handle}">${row.display_name || row.handle}</a>${exampleBadge(row.handle)} · ${when(row.created_at)}${reportable ? html` · ${reportLink("update", row.id)}` : ""}</p>
${review ? UNDER_REVIEW : ""}
${row.body ? html`<div class="body-text">${row.body}</div>` : ""}
${photos.length ? html`<div class="photo-grid n${Math.min(photos.length, 4)}">${imgs(row, photos)}</div>` : ""}
</article>`;
}

/** One card in the cross-project inspiration feed: photos first. */
export function feedCard(row: UpdateRow, photos: PhotoRow[]): Html {
  return html`<article class="feed-card">
${photos.length ? html`<a class="feed-photo" href="/projects/${row.project_id}#update-${row.id}">${imgs(row, photos.slice(0, 1))}${photos.length > 1 ? html`<span class="photo-count">+${photos.length - 1}</span>` : ""}</a>` : ""}
<div class="feed-text">
<h2><a href="/projects/${row.project_id}">${row.project_title}</a></h2>
${row.body ? html`<p class="feed-body">${row.body.length > 240 ? row.body.slice(0, 240) + "…" : row.body}</p>` : ""}
<p class="muted update-meta"><a href="/u/${row.handle}">${row.display_name || row.handle}</a>${exampleBadge(row.handle)} · ${when(row.created_at)}</p>
</div>
</article>`;
}

const ROW_SQL = `SELECT up.id, up.project_id, up.author_id, up.body, up.created_at, u.handle, u.display_name, p.title AS project_title
  FROM updates up JOIN users u ON u.id = up.author_id JOIN projects p ON p.id = up.project_id`;
const photosOf = (id: number) =>
  db.prepare("SELECT path, width, height FROM photos WHERE update_id = ? ORDER BY id").all(id) as PhotoRow[];

function isTeam(projectId: number, userId: number): boolean {
  return !!db.prepare("SELECT 1 FROM members WHERE project_id = ? AND user_id = ?").get(projectId, userId);
}

/** HTML for the project page's progress-updates section (the <section id="updates"> element itself). */
export function updatesSection(c: Context, project: { id: number }): Html {
  const me = currentUser(c);
  const admin = isAdmin(me);
  const blocked = blockedIds(me?.id);
  const rows = (db.prepare(`${ROW_SQL} WHERE up.project_id = ? ORDER BY up.id DESC LIMIT 100`).all(project.id) as UpdateRow[])
    .filter((r) => !isHidden("update", r.id) || admin || r.author_id === me?.id);
  const canPost = !!me && isTeam(project.id, me.id);
  return html`<section id="updates">
<h2>Progress updates</h2>
${canPost ? html`<form method="post" action="/projects/${project.id}/updates" enctype="multipart/form-data" class="stack wide update-form" id="update-form">
  ${csrfField(c)}
  <label>What's new?<textarea name="body" required rows="3" maxlength="${MAX_BODY}" data-provenance></textarea></label>
  <label>Photos (up to ${MAX_FILES}, 2 MB each)<input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple></label>
  <div class="preview-strip" id="preview-strip" aria-live="polite"></div>
  ${pledgeField}
  <button type="submit">Post update</button>
</form>
<script src="/public/provenance.js" defer></script>
<script src="/public/resize.js" defer></script>` : ""}
<div id="timeline" data-live-topic="project:${project.id}" data-live-target="#timeline" data-live-mode="prepend">
${rows.map((r) => {
  const card = updateCard(r, photosOf(r.id), isHidden("update", r.id), r.author_id !== me?.id);
  return blocked.has(r.author_id) ? collapsed(card) : card;
})}
</div>
${rows.length ? "" : html`<p class="muted">No updates yet.</p>`}
</section>`;
}

const fail = (c: Context, msg: string, status: 400 | 403 | 404) =>
  page(c, { title: "Update not posted", body: html`<h1>Update not posted</h1><p class="error">${msg}</p><p><a href="javascript:history.back()">Go back</a></p>`, status });

updates.post("/projects/:id/updates", requireUser, async (c) => {
  const idStr = c.req.param("id");
  if (!/^\d{1,12}$/.test(idStr)) return fail(c, "No such project.", 404);
  const pid = Number(idStr);
  const project = db.prepare("SELECT id, title FROM projects WHERE id = ?").get(pid) as { id: number; title: string } | undefined;
  if (!project) return fail(c, "No such project.", 404);
  const me = currentUser(c)!;
  if (!isTeam(pid, me.id)) return fail(c, "Only the project's owner and team members can post updates.", 403);

  const form = await c.req.formData();
  const body = String(form.get("body") ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return fail(c, "Please write something.", 400);
  if (body.length > MAX_BODY) return fail(c, `Updates are limited to ${MAX_BODY} characters.`, 400);
  if (!form.get("pledge")) return fail(c, PLEDGE_ERR, 400);
  const prov = readProvenance(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")), body);
  const files = form.getAll("photos").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > MAX_FILES) return fail(c, `At most ${MAX_FILES} photos per update.`, 400);

  const saved: { name: string; img: Img; data: Uint8Array }[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE) return fail(c, "Each photo must be 2 MB or smaller.", 400);
    const data = new Uint8Array(await f.arrayBuffer());
    const img = sniffImage(data);
    if (!img) return fail(c, "Only JPEG, PNG or WebP images are accepted.", 400);
    saved.push({ name: `${randomBytes(16).toString("hex")}.${img.ext}`, img, data });
  }
  mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const s of saved) writeFileSync(join(UPLOAD_DIR, s.name), s.data);

  const uid = tx(() => {
    const id = Number(db.prepare("INSERT INTO updates (project_id, author_id, body) VALUES (?,?,?)").run(pid, me.id, body).lastInsertRowid);
    const ins = db.prepare("INSERT INTO photos (update_id, project_id, path, width, height) VALUES (?,?,?,?,?)");
    for (const s of saved) ins.run(id, pid, s.name, s.img.width, s.img.height);
    saveProvenance("update", id, prov);
    db.prepare("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pid);
    return id;
  });
  const row = db.prepare(`${ROW_SQL} WHERE up.id = ?`).get(uid) as UpdateRow;
  const photos = photosOf(uid);
  publish(`project:${pid}`, { type: "update", html: String(updateCard(row, photos)) });
  publish("feed", { type: "update-feed", html: String(feedCard(row, photos)) });
  announce("update-posted", { projectId: pid, updateId: uid, photos: photos.length, actorId: me.id });
  if (!isHidden("project", pid) && !isHidden("update", uid)) {
    const team = db.prepare("SELECT user_id AS id FROM members WHERE project_id = ? UNION SELECT owner_id FROM projects WHERE id = ?").all(pid, pid) as { id: number }[];
    for (const t of team) notify(t.id, "project-update", { text: `New update on ${short(project.title)}`, href: `/projects/${pid}#update-${uid}`, actorId: me.id });
  }
  flash(c, "Update posted.");
  return c.redirect(`/projects/${pid}#updates`);
});

updates.get("/uploads/:file", (c) => {
  const name = c.req.param("file");
  if (!FILE_RE.test(name)) return c.notFound();
  let data: Buffer;
  try { data = readFileSync(join(UPLOAD_DIR, name)); } catch { return c.notFound(); }
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": MIME[name.slice(name.lastIndexOf(".") + 1)]!,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

updates.get("/updates", (c) => {
  const rows = db.prepare(`${ROW_SQL} WHERE EXISTS (SELECT 1 FROM photos ph WHERE ph.update_id = up.id) AND ${notHidden("update", "up.id")} AND ${notHidden("project", "up.project_id")} ORDER BY up.id DESC LIMIT 30`).all() as UpdateRow[];
  return page(c, {
    title: "Inspiration",
    body: html`<h1>Inspiration</h1>
<p class="muted">Recent progress from projects around the site.</p>
<div id="feed-list" class="feed-grid" data-live-topic="feed" data-live-target="#feed-list" data-live-types="update-feed" data-live-mode="prepend">
${rows.map((r) => feedCard(r, photosOf(r.id)))}
</div>
${rows.length ? "" : html`<p class="empty muted">No photo updates yet.</p>`}`,
  });
});
