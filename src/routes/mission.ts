import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { streamSSE } from "hono/streaming";
import { subscribe } from "../bus.ts";
import { currentCrew, type Crew } from "../crew.ts";
import { previewStart } from "../game/agency.ts";
import { act, attach, lobbyTopic, publishSeatChange, roleTopic, snapshot, startMission } from "../game/rooms.ts";
import { DEFAULT_SEQUENCE, getSequence, hasSequence } from "../game/sequences.ts";
import { claimSeat, createMission, getMission, holds, releaseSeat, rolesHeld, seatsOf } from "../game/store.ts";
import { ROLES, ROLE_LABELS, type Action, type ConsoleView, type Role } from "../engine/types.ts";
import { csrfToken } from "../auth.ts";
import { clientIp, rateLimit } from "../ratelimit.ts";
import { csrfField, page } from "../views/layout.ts";
import { callsignForm, tooManyPage } from "./home.ts";

export const mission = new Hono();

const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
const short = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);

const perCrewOrIp = (c: Context): string => {
  const crew = currentCrew(c);
  return crew ? `crew:${crew.id}` : `ip:${clientIp(c)}`;
};

// 10 new missions a minute per crew member; 20 actions a second, which is far
// more than anyone plays at and stops a script.
mission.post(
  "/missions",
  rateLimit({
    limit: 10,
    windowMs: 60_000,
    key: perCrewOrIp,
    reject: (c, secs) => tooManyPage(c, "You have started a lot of missions in the last minute.", secs),
  }),
  async (c) => {
    const crew = currentCrew(c);
    if (!crew) return c.redirect("/", 303);
    // Which sequence to fly: only a registered id is accepted, and none means Kestrel-1.
    const body = await c.req.parseBody();
    const asked = body["sequence"];
    const sequence = asked === undefined || asked === "" ? DEFAULT_SEQUENCE : asked;
    if (typeof sequence !== "string" || !hasSequence(sequence)) {
      return page(c, { title: "Unknown sequence", body: html`<h1>Unknown sequence</h1><p id="error" class="error" role="alert">There is no such mission sequence.</p><p><a href="/">Back to the hub</a></p>`, status: 422 });
    }
    return c.redirect(`/m/${createMission(crew.id, sequence).code}`, 303);
  },
);

function renderMission(c: Context, code: string, crew: Crew | null, opts: { error?: string; status?: 200 | 403 | 404 | 409 | 422 } = {}) {
  const m = getMission(code);
  if (!m) return page(c, { title: "No such mission", body: html`<h1>No such mission</h1><p><a href="/">Back</a></p>`, status: 404 });
  const seq = getSequence(m.sequence_id);
  const seats = seatsOf(m.id);
  const mine = crew ? rolesHeld(m.id, crew.id) : [];
  const lobby = m.status === "lobby";
  const prep = previewStart(m);
  return page(c, {
    title: `Mission ${m.code}`,
    status: opts.status ?? 200,
    body: html`<div id="mission" data-code="${m.code}" data-status="${m.status}" data-roles="${mine.join(" ")}" data-callsign="${crew?.callsign ?? ""}">
<div class="mission-head">
  <p class="eyebrow">${seq.name}</p>
  <h1>Mission <span id="mission-code" class="code">${m.code}</span></h1>
  ${lobby ? html`<p class="share">Share this code or link: <button type="button" id="copy-link" class="secondary">Copy link</button></p>` : ""}
</div>
<p id="error" class="error" role="alert">${opts.error ?? ""}</p>
<p id="conn" class="conn" hidden>reconnecting…</p>
${crew ? html`<input type="hidden" name="_csrf" value="${csrfToken(c)}">` : ""}
${crew ? "" : html`<p>Take a callsign to join this mission.</p>${callsignForm(c, `/m/${m.code}`)}`}
<section id="lobby" class="panel" aria-label="Crew">
  <h2>Crew</h2>
  <p class="muted">Phase <span id="phase">${m.status}</span></p>
  <p id="hardware" class="muted">Rocket <strong id="rocket-name">${prep.rocket?.name ?? "none"}</strong> · Pad <strong id="pad-name">${prep.pad ? `${prep.pad.name} (${prep.pad.condition}%)` : "none"}</strong> · <a href="/agency">Agency</a></p>
  ${lobby && prep.blocked ? html`<p id="start-blocked" class="blocked">Cannot start: ${prep.blocked}</p>` : ""}
  <ul id="seats" class="seats">${seq.roles.map((r) => html`<li data-role="${r}"><span class="role">${ROLE_LABELS[r]}</span><span class="holder">${seats[r] ?? "open"}</span>
    ${lobby && crew && !seats[r] ? html`<form class="inline" method="post" action="/m/${m.code}/seat">${csrfField(c)}<input type="hidden" name="role" value="${r}"><button type="submit">Take seat</button></form>` : ""}
    ${lobby && mine.includes(r) ? html`<form class="inline" method="post" action="/m/${m.code}/unseat">${csrfField(c)}<input type="hidden" name="role" value="${r}"><button type="submit" class="secondary">Leave seat</button></form>` : ""}</li>`)}</ul>
  ${lobby ? html`<p id="fill-note" class="muted">Every seat must be filled before the count can start. One person may take several seats. The Flight Director starts the count.</p>` : ""}
  ${lobby && mine.includes("flight")
    ? html`<form id="start-form" data-action method="post" action="/m/${m.code}/act">${csrfField(c)}<input type="hidden" name="role" value="flight"><input type="hidden" name="type" value="start"><button type="submit" class="big go-btn">Start the count</button></form>`
    : ""}
</section>
<p id="observer-note" class="muted" hidden>You are watching without a seat. Every console is private to the person at it.</p>
<div id="tabs" class="tabs" role="group" aria-label="Consoles" hidden></div>
<div id="consoles" class="consoles" hidden></div>
<section id="outcome-panel" class="outcome" hidden aria-live="polite"></section>
</div>
<script src="/public/console.js" defer></script>`,
  });
}

mission.get("/m/:code", (c) => renderMission(c, c.req.param("code").toUpperCase(), currentCrew(c)));

for (const verb of ["seat", "unseat"] as const) {
  mission.post(`/m/:code/${verb}`, async (c) => {
    const code = c.req.param("code").toUpperCase();
    const crew = currentCrew(c);
    const m = getMission(code);
    if (!m) return renderMission(c, code, crew);
    if (!crew) return renderMission(c, code, crew, { error: "Choose a callsign first.", status: 403 });
    const body = await c.req.parseBody();
    const role = body["role"];
    if (!isRole(role)) return renderMission(c, code, crew, { error: "Unknown role.", status: 422 });
    const error = verb === "seat" ? claimSeat(m, crew.id, role) : releaseSeat(m, crew.id, role);
    if (error) return renderMission(c, code, crew, { error, status: 409 });
    publishSeatChange(code);
    return c.redirect(`/m/${code}`, 303);
  });
}

/** Build an engine Action from an allowlist of fields; nothing from the client is passed through whole. */
function buildAction(role: Role, body: Record<string, unknown>): Action | string {
  switch (body["type"]) {
    case "start": case "hold": case "resume": case "scrub":
      return { role, type: body["type"] };
    case "step": {
      const stepId = short(body["stepId"]);
      return stepId ? { role, type: "step", stepId } : "stepId is required";
    }
    case "poll_open": {
      const pollId = short(body["pollId"]);
      return pollId ? { role, type: "poll_open", pollId } : "pollId is required";
    }
    case "poll_report": {
      const pollId = short(body["pollId"]);
      const report = body["report"];
      if (!pollId) return "pollId is required";
      return report === "go" || report === "nogo" ? { role, type: "poll_report", pollId, report } : 'report must be "go" or "nogo"';
    }
    default:
      return "unknown action type";
  }
}

mission.post(
  "/m/:code/act",
  rateLimit({
    limit: 20,
    windowMs: 1000,
    key: perCrewOrIp,
    reject: (c, secs) => c.json({ ok: false, error: `too many actions, slow down and try again in ${secs} s` }, 429),
  }),
  async (c) => {
    const code = c.req.param("code").toUpperCase();
    const m = getMission(code);
    if (!m) return c.json({ ok: false, error: "no such mission" }, 404);
    const crew = currentCrew(c);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const role = body["role"];
    if (!crew || !isRole(role) || !holds(m.id, crew.id, role)) {
      return c.json({ ok: false, error: "you do not hold that seat" }, 403);
    }
    // Time never comes from the client: only these fields are read.
    const action = buildAction(role, body);
    if (typeof action === "string") return c.json({ ok: false, error: action });
    const result = action.type === "start" ? startMission(m, crew.id) : act(code, crew.id, action);
    return c.json(result);
  },
);

// One SSE stream per console window. A crew member is subscribed to the topics
// of the roles they hold plus the lobby, so another console's view never
// reaches them: there is nothing to filter out later.
mission.get("/m/:code/stream", (c) => {
  const code = c.req.param("code").toUpperCase();
  const m = getMission(code);
  if (!m) return c.text("no such mission", 404);
  const crew = currentCrew(c);
  const roles = crew ? rolesHeld(m.id, crew.id) : [];
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const send = (data: unknown): void => {
      stream.writeSSE({ data: JSON.stringify(data) }).catch(() => {});
    };
    // Several roles may update at once; send one `views` message for the lot.
    const latest: Record<string, ConsoleView> = {};
    let queued = false;
    const flush = (): void => {
      queued = false;
      send({ type: "views", serverNow: Date.now(), views: { ...latest } });
    };
    const unsubs = [
      subscribe(lobbyTopic(code), send),
      ...roles.map((role) =>
        subscribe(roleTopic(code, role), (e) => {
          latest[role] = e["view"] as ConsoleView;
          if (!queued) { queued = true; setImmediate(flush); }
        }),
      ),
    ];
    const detach = attach(code);
    const done = new Promise<void>((resolve) => stream.onAbort(resolve));
    const snap = snapshot(code, roles);
    if (snap) {
      send(snap.lobby);
      if (roles.length > 0) { Object.assign(latest, snap.views); flush(); }
    }
    const beat = setInterval(() => { stream.write(": hb\n\n").catch(() => {}); }, 25_000);
    await done;
    clearInterval(beat);
    unsubs.forEach((u) => u());
    detach();
  });
});
