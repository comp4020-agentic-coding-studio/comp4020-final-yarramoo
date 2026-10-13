// TEMPORARY: visual theme switcher. Remove this file, public/themes/, spec/style.test.ts,
// and the lines marked TEMPORARY in layout.ts and server.ts.
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { safeNext } from "../auth.ts";
import { csrfField, page } from "../views/layout.ts";

export const style = new Hono();

const FONT = "https://fonts.googleapis.com/css2?display=swap";
const PEG = "family=Zilla+Slab:wght@600;700&family=Inter:wght@400;600&family=Stardos+Stencil:wght@400;700";
const ENA = "family=Oswald:wght@500;700&family=Source+Serif+4:ital,wght@0,400;0,600;1,400";
const NOTE = "family=IBM+Plex+Mono:wght@400;600&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=Caveat:wght@600;700";

export const THEMES = {
  plain: { name: "Plain", desc: "Today's look: clean, neutral, system fonts.", fonts: "", sw: ["#fafaf7", "#ffffff", "#1c6e5a", "#1d2330"] },
  pegboard: { name: "Pegboard", desc: "1970s garage wall: kraft board, masking tape, safety orange, Dymo labels.", fonts: `${FONT}&${PEG}`, sw: ["#c9a679", "#f3ecd9", "#e8590c", "#2b2b2b"] },
  enamel: { name: "Enamel", desc: "1950s machine-shop catalogue: hammertone green-grey, cream panels, enamel red, brass.", fonts: `${FONT}&${ENA}`, sw: ["#6b7d76", "#f4ecd8", "#b3261e", "#b08d3c"] },
  notebook: { name: "Notebook", desc: "Builder's graph-paper notebook: blueprint ink, red pencil, taped-in pages.", fonts: `${FONT}&${NOTE}`, sw: ["#fbf6e6", "#ffffff", "#1d3f8f", "#c62828"] },
  blend: { name: "Blend", desc: "Pegboard for the workshop pages, graph-paper notebook for Questions.", fonts: `${FONT}&${PEG}&${NOTE}`, sw: ["#c9a679", "#e8590c", "#fbf6e6", "#1d3f8f"] },
  raw: { name: "Raw HTML", desc: "Browser defaults did all the work: serif, blue links, plain rules, [bracketed] badges.", fonts: "", sw: ["#ffffff", "#000000", "#0000ee", "#551a8b"] },
  hobbyist: { name: "Hobbyist homepage", desc: "Late-90s workshop site: grey tiled page, bevelled panel, navy title bars, parts-list skills.", fonts: "", sw: ["#c0c0c0", "#fffff0", "#000080", "#0000ee"] },
} as const;
export type Theme = keyof typeof THEMES;

export function themeOf(c: Context): Theme {
  const v = getCookie(c, "theme");
  return v && Object.hasOwn(THEMES, v) ? (v as Theme) : "plain";
}
export const themeFonts = (t: Theme): string => THEMES[t].fonts;

style.post("/style", async (c) => {
  const body = await c.req.parseBody();
  const t = typeof body["theme"] === "string" ? body["theme"] : "";
  const theme = Object.hasOwn(THEMES, t) ? t : "plain";
  setCookie(c, "theme", theme, { path: "/", sameSite: "Lax", maxAge: 31_536_000 });
  const next = typeof body["next"] === "string" ? safeNext(body["next"]) : "/style";
  return c.redirect(next === "/" ? "/style" : next);
});

style.get("/style", (c) => {
  const cur = themeOf(c);
  const opts = (Object.keys(THEMES) as Theme[]).map((k) => {
    const t = THEMES[k];
    return html`<label class="check theme-opt"><input type="radio" name="theme" value="${k}" ${cur === k ? raw("checked") : raw("")}>
  <span><strong>${t.name}</strong> · <span class="muted">${t.desc}</span><br>
  <span class="swatch" aria-hidden="true" style="display:inline-flex;gap:2px;margin-top:.25rem">${t.sw.map((col) => html`<i style="display:inline-block;width:2rem;height:.9rem;background:${col};border:1px solid rgba(0,0,0,.35)"></i>`)}</span></span></label>`;
  });
  return page(c, {
    title: "Styles",
    body: html`<h1>Styles</h1>
<p class="muted">Temporary: pick a visual direction to compare on the real pages. Saved in a cookie on this browser.</p>
<form method="post" action="/style" class="stack wide">${csrfField(c)}
${opts}
<div><button type="submit">Apply style</button></div>
</form>

<h2>Specimen</h2>
<p class="muted">Current style: ${THEMES[cur].name}.</p>
<h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3>
<p>Body paragraph: a bench vise, a box of offcuts and a free Saturday. <a href="/style">A link inside the text</a> sits here.</p>
<p><button type="button">Primary button</button> <button type="button" class="secondary">Secondary</button> <button type="button" class="ghost">Ghost</button></p>
<div class="stack wide">
<label>Text input <input type="text" value="Workbench"></label>
<label>Textarea <textarea rows="3">Notes on the build</textarea></label>
<label class="check"><input type="checkbox" checked> A checkbox</label>
</div>
<h2>Project card</h2>
<article class="card project-card">
  <h2><a href="/style">Restore a 1960s lathe</a></h2>
  <p class="badges"><span class="badge status-in_progress">In progress</span> <span class="badge recruiting">Recruiting</span></p>
  <p>Looking for someone who can cut gears and help me carry the thing up the stairs.</p>
  <ul class="tags"><li><a href="/style">welding</a></li><li><a href="/style">machining</a></li><li><a href="/style">woodwork</a></li></ul>
  <p class="muted">Canberra, ACT 2600 · 4 km away</p>
</article>
<div class="flash" role="status">Flash: your update was posted.</div>
<div class="flash error" role="status">Flash: something needs fixing.</div>
<h2>Questions</h2>
<div class="q-list">
<article class="q-item">
  <h2><a href="/style">How do I true a warped table-saw fence?</a></h2>
  <p class="muted q-meta">by sam · 3 Oct · 2 answers · helped 4 <span class="badge status-done">Accepted</span></p>
  <ul class="tags"><li><a href="/style">carpentry</a></li><li><a href="/style">tools</a></li></ul>
</article></div>
<article class="answer accepted">
  <p class="muted q-meta"><span class="badge status-done">Accepted</span> alex · 3 Oct</p>
  <div class="rich"><p>Shim the rear of the fence with a strip of laminate, then re-check with a straightedge.</p></div>
  <p class="answer-actions"><button type="button" class="on">This helped (4)</button> <button type="button" class="ghost">Unaccept</button></p>
</article>
<article class="answer">
  <p class="muted q-meta">jo · 4 Oct</p>
  <div class="rich"><p>Or just buy a new fence. Honestly.</p></div>
  <p class="answer-actions"><button type="button" class="ghost">This helped (0)</button></p>
</article>
<h2>Progress update</h2>
<article class="update-card">
  <p class="muted update-meta"><a href="/style">alex</a> · 4 Oct, 3:10 pm</p>
  <div class="body-text">Cast iron bed is cleaned up and the ways are looking good.</div>
  <div class="photo-grid n1"><div style="height:10rem;background:repeating-linear-gradient(45deg,rgba(128,128,128,.25) 0 10px,rgba(128,128,128,.4) 10px 20px);display:grid;place-items:center" class="muted">photo placeholder</div></div>
</article>`,
  });
});
