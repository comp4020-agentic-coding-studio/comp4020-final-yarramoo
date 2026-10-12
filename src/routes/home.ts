import { Hono } from "hono";
import { html } from "hono/html";
import { safeNext } from "../auth.ts";
import { createCrew, currentCrew, setCrewCookie } from "../crew.ts";
import { CODE_RE, getMission, openMissionsFor } from "../game/store.ts";
import { csrfField, page, type Html } from "../views/layout.ts";
import type { Context } from "hono";

export const home = new Hono();

/** The callsign form, shared by `/` and the mission page for someone with no callsign yet. */
export function callsignForm(c: Context, next: string, error?: string): Html {
  return html`<form id="callsign-form" method="post" action="/crew" class="stack">
  ${csrfField(c)}
  <input type="hidden" name="next" value="${next}">
  <label for="callsign-input">Choose a callsign</label>
  <input id="callsign-input" name="callsign" required minlength="2" maxlength="16" pattern="[A-Za-z0-9_\\-]{2,16}" autocomplete="off" autocapitalize="off">
  <p class="muted">2 to 16 letters, digits, underscore or hyphen. This browser is you; there is no password.</p>
  ${error ? html`<p id="error" class="error" role="alert">${error}</p>` : ""}
  <button type="submit">Take this callsign</button>
</form>`;
}

home.get("/", (c) => {
  const crew = currentCrew(c);
  if (!crew) {
    return page(c, {
      title: "Mission Control",
      body: html`<h1>Mission Control</h1><p>A cooperative launch countdown. Each player sits at one console.</p>${callsignForm(c, "/")}`,
    });
  }
  const mine = openMissionsFor(crew.id);
  return page(c, {
    title: "Mission Control",
    body: html`<h1>Mission Control</h1>
<p>Callsign <strong id="who">${crew.callsign}</strong>.</p>
<form id="new-mission" method="post" action="/missions">${csrfField(c)}<button type="submit">Start a new mission</button></form>
<form id="join-mission" method="get" action="/join" class="stack">
  <label for="join-code">Join with a mission code</label>
  <input id="join-code" name="code" maxlength="5" required autocomplete="off" autocapitalize="characters">
  <button type="submit">Join</button>
</form>
${mine.length > 0
  ? html`<h2>Your open missions</h2><ul id="my-missions">${mine.map((m) => html`<li data-code="${m.code}" data-status="${m.status}"><a href="/m/${m.code}">${m.code}</a> (${m.status})</li>`)}</ul>`
  : ""}`,
  });
});

home.post("/crew", async (c) => {
  const body = await c.req.parseBody();
  const next = safeNext(typeof body["next"] === "string" ? body["next"] : "/");
  if (currentCrew(c)) return c.redirect(next, 303);
  const callsign = typeof body["callsign"] === "string" ? body["callsign"].trim() : "";
  const r = createCrew(callsign);
  if (!r.ok) {
    return page(c, {
      title: "Mission Control",
      body: html`<h1>Mission Control</h1>${callsignForm(c, next, r.error)}`,
      status: r.status,
    });
  }
  setCrewCookie(c, r.token);
  return c.redirect(next, 303);
});

home.get("/join", (c) => {
  const code = (c.req.query("code") ?? "").trim().toUpperCase();
  if (!CODE_RE.test(code) || !getMission(code)) {
    return page(c, {
      title: "No such mission",
      body: html`<h1>No such mission</h1><p id="error" class="error">There is no mission with the code ${code.slice(0, 8)}.</p><p><a href="/">Back</a></p>`,
      status: 404,
    });
  }
  return c.redirect(`/m/${code}`, 303);
});
