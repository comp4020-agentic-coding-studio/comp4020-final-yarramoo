import type { Context } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { csrfToken } from "../auth.ts";
import { currentCrew } from "../crew.ts";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Hidden CSRF input; include in every POST form. */
export function csrfField(c: Context): Html {
  return html`<input type="hidden" name="_csrf" value="${csrfToken(c)}">`;
}

/** Standard page shell. Returns a Response. */
export function page(c: Context, opts: { title: string; body: Html; status?: 200 | 400 | 403 | 404 | 409 | 422 | 500 }): Response | Promise<Response> {
  const path = c.req.path;
  const link = (href: string, label: string): Html => {
    const cur = href === "/" ? path === "/" : path === href || path.startsWith(href.endsWith("/") ? href : href + "/");
    return html`<a href="${href}"${cur ? raw(' aria-current="page"') : ""}>${label}</a>`;
  };
  const seg = path.split("/")[1] || "home";
  const crew = currentCrew(c);
  const doc = html`<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Mission Control</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body data-page="${seg}">
<header class="site">
  <a class="brand" href="/">Mission Control</a>
  <nav aria-label="Main">${link("/", "Home")} ${link("/readme/", "README")}${crew ? html` <span class="callsign" id="callsign" data-callsign="${crew.callsign}">${crew.callsign}</span>` : ""}</nav>
</header>
<main>${opts.body}</main>
</body>
</html>`;
  return c.html(doc, opts.status ?? 200);
}
