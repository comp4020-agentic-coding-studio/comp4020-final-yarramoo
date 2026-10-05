import { Hono } from "hono";
import { html } from "hono/html";
import { currentUser, endSession, hashPassword, requireUser, safeNext, startSession, verifyPassword } from "../auth.ts";
import { db, skillIds, tx } from "../db/index.ts";
import { lookupPostcode } from "../geo.ts";
import { csrfField, flash, page, type Html } from "../views/layout.ts";

export const accounts = new Hono();

const HANDLE = /^[a-z0-9_-]{3,24}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const field = (label: string, input: Html) => html`<label>${label}${input}</label>`;

function signupForm(c: Parameters<typeof csrfField>[0], v: { handle?: string; postcode?: string } = {}, error?: string): Html {
  return html`<h1>Sign up</h1>
${error ? html`<p class="error">${error}</p>` : ""}
<form method="post" action="/signup" class="stack">
  ${csrfField(c)}
  ${field("Handle (3–24 chars: a-z, 0-9, _ or -)", html`<input name="handle" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_\\-]+" autocomplete="username" value="${v.handle ?? ""}">`)}
  ${field("Password (8+ characters)", html`<input name="password" type="password" required minlength="8" autocomplete="new-password">`)}
  ${field("Postcode (optional, AU)", html`<input name="postcode" inputmode="numeric" maxlength="4" value="${v.postcode ?? ""}">`)}
  <button type="submit">Create account</button>
</form>
<p>Already have an account? <a href="/login">Log in</a>.</p>`;
}

accounts.get("/signup", (c) => (currentUser(c) ? c.redirect("/me") : page(c, { title: "Sign up", body: signupForm(c) })));

accounts.post("/signup", async (c) => {
  const b = await c.req.parseBody();
  const handle = str(b.handle).trim().toLowerCase();
  const pw = str(b.password);
  const postcode = str(b.postcode).trim();
  const fail = (msg: string, status: 400 | 409 = 400) =>
    page(c, { title: "Sign up", body: signupForm(c, { handle, postcode }, msg), status });
  if (!HANDLE.test(handle)) return fail("Handle must be 3–24 characters: letters, digits, _ or -.");
  if (pw.length < 8) return fail("Password must be at least 8 characters.");
  if (postcode && !lookupPostcode(postcode)) return fail("Unknown postcode.");
  if (db.prepare("SELECT 1 FROM users WHERE handle = ?").get(handle)) return fail("That handle is taken.", 409);
  let id: number;
  try {
    id = Number(db.prepare("INSERT INTO users (handle, pw_hash, display_name, postcode) VALUES (?,?,?,?)").run(handle, hashPassword(pw), handle, postcode || null).lastInsertRowid);
  } catch {
    return fail("That handle is taken.", 409);
  }
  startSession(c, id);
  flash(c, "Welcome! Your account is ready.");
  return c.redirect("/me");
});

function loginForm(c: Parameters<typeof csrfField>[0], next: string, error?: string): Html {
  return html`<h1>Log in</h1>
${error ? html`<p class="error">${error}</p>` : ""}
<form method="post" action="/login" class="stack">
  ${csrfField(c)}
  <input type="hidden" name="next" value="${next}">
  ${field("Handle", html`<input name="handle" required autocomplete="username">`)}
  ${field("Password", html`<input name="password" type="password" required autocomplete="current-password">`)}
  <button type="submit">Log in</button>
</form>
<p>No account? <a href="/signup">Sign up</a>.</p>`;
}

accounts.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  return currentUser(c) ? c.redirect(next) : page(c, { title: "Log in", body: loginForm(c, next) });
});

// Precomputed so unknown handles cost the same as wrong passwords.
const DUMMY = hashPassword("dummy-password");

accounts.post("/login", async (c) => {
  const b = await c.req.parseBody();
  const next = safeNext(str(b.next));
  const row = db.prepare("SELECT id, pw_hash FROM users WHERE handle = ?").get(str(b.handle).trim().toLowerCase()) as { id: number; pw_hash: string } | undefined;
  const ok = verifyPassword(str(b.password), row?.pw_hash ?? DUMMY) && !!row;
  if (!ok || !row) return page(c, { title: "Log in", body: loginForm(c, next, "Wrong handle or password."), status: 400 });
  startSession(c, row.id);
  return c.redirect(next);
});

accounts.post("/logout", (c) => {
  endSession(c);
  return c.redirect("/");
});

type Me = { display_name: string | null; bio: string | null; postcode: string | null };
const skillsOf = (id: number) =>
  (db.prepare("SELECT s.name FROM user_skills us JOIN skills s ON s.id = us.skill_id WHERE us.user_id = ? ORDER BY s.name").all(id) as { name: string }[]).map((r) => r.name);

accounts.get("/me", requireUser, (c) => {
  const u = currentUser(c)!;
  return page(c, { title: "Your profile", body: meForm(c, u as Me & { id: number; handle: string }, skillsOf(u.id).join(", ")) });
});

function meForm(c: Parameters<typeof csrfField>[0], u: Me & { id: number; handle: string }, skills: string, error?: string): Html {
  return html`<h1>Your profile</h1>
<p><a href="/u/${u.handle}">View public profile (@${u.handle})</a></p>
${error ? html`<p class="error">${error}</p>` : ""}
<form method="post" action="/me" class="stack">
  ${csrfField(c)}
  ${field("Display name", html`<input name="display_name" maxlength="60" value="${u.display_name ?? ""}">`)}
  ${field("Bio", html`<textarea name="bio" rows="4" maxlength="1000">${u.bio ?? ""}</textarea>`)}
  ${field("Postcode (AU)", html`<input name="postcode" inputmode="numeric" maxlength="4" value="${u.postcode ?? ""}">`)}
  ${field("Skills (comma-separated)", html`<input name="skills" maxlength="300" value="${skills}">`)}
  <button type="submit">Save</button>
</form>`;
}

accounts.post("/me", requireUser, async (c) => {
  const u = currentUser(c)!;
  const b = await c.req.parseBody();
  const display = str(b.display_name).trim().slice(0, 60) || u.handle;
  const bio = str(b.bio).trim().slice(0, 1000);
  const postcode = str(b.postcode).trim();
  const skills = str(b.skills);
  if (postcode && !lookupPostcode(postcode)) {
    return page(c, { title: "Your profile", body: meForm(c, { ...u, display_name: display, bio, postcode }, skills, "Unknown postcode."), status: 400 });
  }
  tx(() => {
    db.prepare("UPDATE users SET display_name = ?, bio = ?, postcode = ? WHERE id = ?").run(display, bio, postcode || null, u.id);
    db.prepare("DELETE FROM user_skills WHERE user_id = ?").run(u.id);
    const ins = db.prepare("INSERT OR IGNORE INTO user_skills (user_id, skill_id) VALUES (?,?)");
    for (const sid of skillIds(skills)) ins.run(u.id, sid);
  });
  flash(c, "Profile saved.");
  return c.redirect("/me");
});

accounts.get("/u/:handle", (c) => {
  const u = db.prepare("SELECT id, handle, display_name, bio, postcode FROM users WHERE handle = ?").get(c.req.param("handle").toLowerCase()) as
    | { id: number; handle: string; display_name: string | null; bio: string | null; postcode: string | null } | undefined;
  if (!u) return page(c, { title: "Not found", body: html`<h1>No such user</h1>`, status: 404 });
  const place = u.postcode ? lookupPostcode(u.postcode) : null;
  const skills = skillsOf(u.id);
  return page(c, {
    title: u.display_name || u.handle,
    body: html`<h1>${u.display_name || u.handle}</h1>
<p class="muted">@${u.handle}${place ? html` · ${place.locality}, ${place.state} ${place.postcode}` : ""}</p>
${u.bio ? html`<p class="bio">${u.bio}</p>` : ""}
${skills.length ? html`<h2>Skills</h2><ul class="tags">${skills.map((s) => html`<li>${s}</li>`)}</ul>` : ""}
<!-- SLICE-HOOK: later slices list this user's projects (owned and joined) here. -->
<section id="user-projects"></section>`,
  });
});
