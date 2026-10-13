import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { csrfToken, currentUser } from "../auth.ts";
import { blockedIds } from "../blocks.ts";
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

/** Set a one-shot celebration (own action) played by celebrate.js on the next page render. */
export function celebrate(c: Context, kind: "posted" | "finished"): void {
  setCookie(c, "celebrate", kind, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 });
}

function takeCelebrate(c: Context): "posted" | "finished" | null {
  const v = getCookie(c, "celebrate");
  if (!v) return null;
  deleteCookie(c, "celebrate", { path: "/" });
  return v === "posted" || v === "finished" ? v : null;
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
  const cel = takeCelebrate(c);
  const unread = user ? unreadCount(user.id) : 0;
  const path = c.req.path;
  const link = (href: string, label: string): Html => {
    const cur = href === "/" ? path === "/" : path === href || path.startsWith(href.endsWith("/") ? href : href + "/");
    return html`<a href="${href}"${cur ? raw(' aria-current="page"') : ""}>${label}</a>`;
  };
  const account = user
    ? html`${link("/me", user.display_name || user.handle)}
        ${isAdmin(user) ? link("/admin/signals", "Admin") : ""}
        <form method="post" action="/logout" class="inline">${csrfField(c)}<button type="submit" class="link">Log out</button></form>`
    : html`${link("/signup", "Sign up")} ${link("/login", "Log in")}`;
  const inbox = user
    ? html`<a class="nav-inbox" href="/inbox"${path === "/inbox" ? raw(' aria-current="page"') : ""}>Inbox <span class="unread-count" data-count="${unread}"${unread ? "" : raw(" hidden")}>${unread}</span></a>`
    : "";
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
<body data-page="${seg}"${cel ? raw(` data-celebrate="${cel}"`) : raw("")}${user ? raw(` data-user-id="${user.id}" data-blocked-ids="${[...blockedIds(user.id)].join(",")}"`) : raw("")}>
<header class="site">
  <a class="brand" href="/">Makers Wanted</a>
  <nav aria-label="Main">
    <details class="menu" open>
      <summary>Menu</summary>
      <div class="menu-body">
        ${link("/", "Browse")}
        ${link("/lobbies", "Lobbies")}
        ${link("/questions", "Questions")}
        ${link("/finished", "Finished")}
        ${link("/updates", "Updates")}
        <details class="group"><summary>Explore</summary><div class="panel">
          ${link("/regions", "Regions")}
          ${link("/c", "Categories")}
          ${link("/t", "Themes")}
          ${link("/resources", "Resources")}
        </div></details>
        <details class="group"><summary>About</summary><div class="panel">
          ${link("/philosophy", "Why")}
          ${link("/safety", "Safety")}
          ${link("/readme/", "About")}
          ${link("/style", "Styles")}<!-- TEMPORARY: theme switcher -->
        </div></details>
        <span class="nav-account">${account}</span>
      </div>
    </details>
    ${inbox}
  </nav>
</header>
${f ? html`<div class="flash ${f.kind}" role="status">${f.msg}</div>` : raw("")}
<main>${opts.body}</main>
<footer class="site"><a href="/safety">Safety</a> <a href="/philosophy">Why</a> <a href="/resources">Resources</a></footer>
<div id="activity" class="activity-region" data-live-topic="activity" data-live-mode="none">
  <button type="button" class="activity-pause link" aria-pressed="false" hidden>Pause activity</button>
  <div class="activity-list" aria-live="polite" role="log"></div>
</div>
${user ? html`<div hidden data-live-topic="user:${user.id}" data-live-mode="none"></div>` : ""}
<script src="/public/nav.js" defer></script>
<script src="/public/live.js" defer></script>
<script src="/public/activity.js" defer></script>
<script src="/public/celebrate.js" defer></script>
${user ? html`<script src="/public/notify.js" defer></script>` : ""}
</body>
</html>`;
  return c.html(doc, opts.status ?? 200);
}
