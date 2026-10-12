import { Hono } from "hono";
import { html } from "hono/html";
import { safeNext } from "../auth.ts";
import { createCrew, currentCrew, setCrewCookie } from "../crew.ts";
import { agencySummary } from "../game/agency.ts";
import { CODE_RE, getMission, openMissionsFor } from "../game/store.ts";
import { clientIp, scaled } from "../ratelimit.ts";
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

function agencyStrip(): Html {
  const s = agencySummary();
  return html`<a id="agency-strip" class="agency-strip" href="/agency">Agency: budget ${s.budget} · reputation ${s.reputation} · pad ${s.pad ? `${s.pad.name} ${s.pad.condition}%` : "none"} · ${s.ready} ready ${s.ready === 1 ? "rocket" : "rockets"}</a>`;
}

home.get("/", (c) => {
  const crew = currentCrew(c);
  if (!crew) {
    return page(c, {
      title: "Mission Control",
      body: html`<h1>Mission Control</h1><p class="lead">A cooperative launch countdown. Each player sits at one console and sees only that console.</p>${callsignForm(c, "/")}`,
    });
  }
  const mine = openMissionsFor(crew.id);
  return page(c, {
    title: "Mission Control",
    body: html`<h1>Mission Control</h1>
<p>Callsign <strong id="who">${crew.callsign}</strong></p>
${agencyStrip()}
<p class="howto">How to play: each console sees only its own panel, so talk to each other, by voice call or in the same room. The Flight Director polls the crew before launch. You can report GO while your console shows a fault; the record will show it.</p>
<div class="home-actions">
<form id="new-mission" method="post" action="/missions">${csrfField(c)}<button type="submit" class="big go-btn">Start a mission</button></form>
<form id="join-mission" method="get" action="/join" class="stack">
  <label for="join-code">Join by code</label>
  <input id="join-code" name="code" maxlength="5" required autocomplete="off" autocapitalize="characters">
  <button type="submit">Join</button>
</form></div>
${mine.length > 0
  ? html`<h2>Your open missions</h2><ul id="my-missions" class="missions">${mine.map((m) => html`<li data-code="${m.code}" data-status="${m.status}"><a href="/m/${m.code}"><span class="code">${m.code}</span> ${m.status}</a></li>`)}</ul>`
  : ""}`,
  });
});

// 30 new crew members per minute per address: a whole class signing up from
// one NAT at a crit or the showcase must fit; a script creating callsigns in
// bulk must not. Only a callsign actually created counts, so typos and name
// clashes never lock anyone out.
const signups = scaled(30, 60_000);

/** A friendly 429 page. `extra` (a form, say) goes under the message. layout's page() has no 429, so re-status its response. */
export async function tooManyPage(c: Context, message: string, retryAfterSec: number, extra: Html | "" = ""): Promise<Response> {
  const r = await page(c, {
    title: "Slow down",
    body: html`<h1>Slow down</h1><p id="error" class="error" role="alert">${message} Try again in ${retryAfterSec} ${retryAfterSec === 1 ? "second" : "seconds"}.</p>${extra}<p><a href="/">Back to the hub</a></p>`,
  });
  return new Response(r.body, { status: 429, headers: r.headers });
}

home.post("/crew", async (c) => {
  const body = await c.req.parseBody();
  const next = safeNext(typeof body["next"] === "string" ? body["next"] : "/");
  if (currentCrew(c)) return c.redirect(next, 303);
  const ip = clientIp(c);
  const wait = signups.blocked(ip);
  if (wait.blocked) {
    const secs = Math.max(1, Math.ceil(wait.retryAfterMs / 1000));
    c.header("Retry-After", String(secs));
    return tooManyPage(c, "Too many callsigns have been taken from this address just now.", secs, callsignForm(c, next));
  }
  const callsign = typeof body["callsign"] === "string" ? body["callsign"].trim() : "";
  const r = createCrew(callsign);
  if (!r.ok) {
    return page(c, {
      title: "Mission Control",
      body: html`<h1>Mission Control</h1>${callsignForm(c, next, r.error)}`,
      status: r.status,
    });
  }
  signups.hit(ip);
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
