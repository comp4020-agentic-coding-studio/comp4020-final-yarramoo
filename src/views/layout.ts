import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { csrfToken, currentUser } from "../auth.ts";
import { unreadCount } from "../notify.ts";
import { isAdmin } from "../provenance.ts";
import { themeFonts, themeOf } from "../routes/style.ts"; // TEMPORARY theme switcher

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Hidden CSRF input; include in every POST form. */
export function csrfField(c: Context): Html {
  return html`<input type="hidden" name="_csrf" value="${csrfToken(c)}">`;
}

/** Set a one-shot flash message shown on the next page render. */
export function flash(c: Context, msg: string, kind: "ok" | "error" = "ok"): void {
  setCookie(c, "flash", encodeURIComponent(`${kind}:${msg}`), { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 });
}

function takeFlash(c: Context): { kind: string; msg: string } | null {
  const v = getCookie(c, "flash");
  if (!v) return null;
  deleteCookie(c, "flash", { path: "/" });
  try {
    const s = decodeURIComponent(v);
    const i = s.indexOf(":");
    return { kind: s.slice(0, i) === "error" ? "error" : "ok", msg: s.slice(i + 1) };
  } catch { return null; }
}

/** Standard page shell. Returns a Response. */
export function page(c: Context, opts: { title: string; body: Html; status?: 200 | 400 | 403 | 404 | 409 | 422 | 500 }): Response | Promise<Response> {
  const user = currentUser(c);
  const f = takeFlash(c);
  const unread = user ? unreadCount(user.id) : 0;
  const nav = user
    ? html`<a href="/inbox">Inbox <span class="unread-count" data-count="${unread}"${unread ? "" : raw(" hidden")}>${unread}</span></a>
        <a href="/me">${user.display_name || user.handle}</a>
        <form method="post" action="/logout" class="inline">${csrfField(c)}<button type="submit" class="link">Log out</button></form>`
    : html`<a href="/signup">Sign up</a> <a href="/login">Log in</a>`;
  const theme = themeOf(c); // TEMPORARY theme switcher
  const fonts = themeFonts(theme);
  const seg = c.req.path.split("/")[1] || "home";
  const doc = html`<!doctype html>
<html lang="en-AU" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Makers Wanted</title>
<link rel="stylesheet" href="/public/style.css">
${fonts ? raw(`<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${fonts}">`) : raw("")}
${theme !== "plain" ? raw(`<link rel="stylesheet" href="/public/themes/${theme}.css">`) : raw("")}
</head>
<body data-page="${seg}"${user ? raw(` data-user-id="${user.id}"`) : raw("")}>
<header class="site">
  <a class="brand" href="/">Makers Wanted</a>
  <nav>
    <a href="/">Browse</a>
    <a href="/regions">Regions</a>
    <a href="/c">Categories</a>
    <a href="/updates">Updates</a>
    <a href="/questions">Questions</a>
    <a href="/resources">Resources</a>
    <a href="/philosophy">Why</a>
    <a href="/readme/">About</a>
    <a href="/style">Styles</a><!-- TEMPORARY: theme switcher -->
    ${isAdmin(user) ? html`<a href="/admin/signals">Admin</a>` : ""}
    ${nav}
  </nav>
</header>
${f ? html`<div class="flash ${f.kind}" role="status">${f.msg}</div>` : raw("")}
<main>${opts.body}</main>
<div id="activity" class="activity-region" data-live-topic="activity" data-live-mode="none">
  <button type="button" class="activity-pause link" aria-pressed="false" hidden>Pause activity</button>
  <div class="activity-list" aria-live="polite" role="log"></div>
</div>
${user ? html`<div hidden data-live-topic="user:${user.id}" data-live-mode="none"></div>` : ""}
<script src="/public/live.js" defer></script>
<script src="/public/activity.js" defer></script>
${user ? html`<script src="/public/notify.js" defer></script>` : ""}
</body>
</html>`;
  return c.html(doc, opts.status ?? 200);
}
