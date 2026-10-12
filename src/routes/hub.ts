import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { streamSSE } from "hono/streaming";
import { subscribe } from "../bus.ts";
import { currentCrew, type Crew } from "../crew.ts";
import { HUB_TOPIC, liveForHub, openLobbies, quickJoin } from "../game/store.ts";
import { ROLE_LABELS, type Role } from "../engine/types.ts";
import { clientIp, rateLimit } from "../ratelimit.ts";
import { callsignLink, csrfField, type Html } from "../views/layout.ts";
import { tooManyPage } from "./home.ts";

export const hub = new Hono();

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

function clock(tMs: number): string {
  const s = Math.floor(Math.abs(tMs) / 1000);
  return `T${tMs < 0 ? "-" : "+"}${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The two live sections. Public data only: codes, sequence names, callsigns, seat labels, the clock. */
export function hubSections(c: Context, crew: Crew | null): Html {
  const now = Date.now();
  const lobbies = openLobbies(now);
  const flying = liveForHub();
  return html`<section id="open-crews" class="hub-section" aria-labelledby="h-open"><h2 id="h-open">Open crews</h2>
${crew ? html`<form id="quick-join" method="post" action="/quick-join" class="inline">${csrfField(c)}<button type="submit" class="big go-btn">Join the next crew</button></form>` : ""}
${lobbies.length === 0
  ? html`<p class="muted" id="no-crews">No crew is forming right now. Start a mission and others can join it.</p>`
  : html`<ul class="crews">${lobbies.map((l) => html`<li class="panel crew-card" data-code="${l.code}" data-free="${l.free}">
  <p class="crew-head"><span class="code">${l.code}</span> <strong>${l.sequenceName}</strong> <span class="muted">${l.roles.length - l.free} of ${l.roles.length} seats · ${ago(now - l.createdAt)}</span></p>
  <ul class="seat-chips">${l.roles.map((r) => l.seats[r as Role]
    ? html`<li class="taken"><span class="role">${ROLE_LABELS[r as Role]}</span> ${callsignLink(l.seats[r as Role]!)}</li>`
    : html`<li class="free"><span class="role">${ROLE_LABELS[r as Role]}</span> <span class="muted">free</span></li>`)}</ul>
  <a class="button" href="/m/${l.code}">Join</a></li>`)}</ul>`}
</section>
<section id="in-flight" class="hub-section" aria-labelledby="h-flight"><h2 id="h-flight">In flight</h2>
${flying.length === 0
  ? html`<p class="muted" id="no-flights">No mission is counting down.</p>`
  : html`<ul class="crews">${flying.map((m) => html`<li class="panel crew-card" data-code="${m.code}"><p class="crew-head"><span class="code">${m.code}</span> <strong>${m.sequenceName}</strong> <span class="mono">${clock(m.tMs)}</span></p>
  <p class="muted">${m.callsigns.map((cs, i) => html`${i ? ", " : ""}${callsignLink(cs)}`)}</p>
  <a class="button" href="/m/${m.code}">Watch</a></li>`)}</ul>`}
</section>`;
}

hub.get("/hub/fragment", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(html`${hubSections(c, currentCrew(c))}`);
});

hub.post(
  "/quick-join",
  rateLimit({
    limit: 10,
    windowMs: 60_000,
    key: (c) => { const crew = currentCrew(c); return crew ? `crew:${crew.id}` : `ip:${clientIp(c)}`; },
    reject: (c, secs) => tooManyPage(c, "You have joined or started a lot of crews in the last minute.", secs),
  }),
  (c) => {
    const crew = currentCrew(c);
    if (!crew) return c.redirect("/", 303);
    return c.redirect(`/m/${quickJoin(crew.id)}`, 303);
  },
);

// Public and bare: "something changed", never a payload.
hub.get("/hub/stream", (c) => {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const unsub = subscribe(HUB_TOPIC, (e) => { stream.writeSSE({ data: JSON.stringify({ type: e.type }) }).catch(() => {}); });
    const done = new Promise<void>((resolve) => stream.onAbort(resolve));
    stream.writeSSE({ data: JSON.stringify({ type: "hello" }) }).catch(() => {});
    const beat = setInterval(() => { stream.write(": hb\n\n").catch(() => {}); }, 25_000);
    await done;
    clearInterval(beat);
    unsub();
  });
});
