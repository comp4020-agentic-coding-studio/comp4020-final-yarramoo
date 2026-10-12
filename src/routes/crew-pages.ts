import { Hono } from "hono";
import { html } from "hono/html";
import { findCrew, crewIndex, isCrewSort, profileOf, type CrewSort } from "../game/records.ts";
import { getSequence } from "../game/sequences.ts";
import { ROLE_LABELS } from "../engine/types.ts";
import { callsignLink, page, type Html } from "../views/layout.ts";

export const crewPages = new Hono();

const OUTCOME_LABEL: Record<string, string> = { success: "Success", pad_abort: "Pad abort", explosion: "Explosion", scrub: "Scrubbed", terminated: "Terminated", range_violation: "Range violation" };
const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

/** Plain-language summary of the record. */
function verdict(r: { cautions: number; goOnCaution: number; spokeUp: number; reports: number }): string {
  if (r.reports === 0) return "No poll reports on the record yet.";
  if (r.cautions === 0) return `${r.reports} poll ${r.reports === 1 ? "report" : "reports"}, and their console never showed a caution.`;
  if (r.goOnCaution === 0) return r.cautions === 1 ? "Spoke up the one time their console showed a caution." : "Spoke up every time their console showed a caution.";
  return `Said GO on a caution ${times(r.goOnCaution)} out of ${r.cautions} ${r.cautions === 1 ? "caution" : "cautions"}.`;
}

crewPages.get("/crew", (c) => {
  const asked = c.req.query("sort");
  const sort: CrewSort = isCrewSort(asked) ? asked : "flown";
  const rows = crewIndex(sort);
  const th = (key: CrewSort, label: string): Html =>
    key === sort ? html`<th aria-sort="descending">${label}</th>` : html`<th><a href="/crew?sort=${key}">${label}</a></th>`;
  return page(c, {
    title: "Crew",
    body: html`<h1>Crew</h1>
<p class="muted">Everyone who has flown a mission. Only finished missions count.</p>
<div class="scroll"><table class="record crew-table"><thead><tr><th>Callsign</th>${th("flown", "Missions flown")}<th>Cautions faced</th>${th("spoke", "Spoke up")}${th("caution", "GO on caution")}</tr></thead><tbody>
${rows.length === 0 ? html`<tr><td colspan="5">Nobody has flown yet.</td></tr>` : rows.map((r) => html`<tr><td>${callsignLink(r.callsign)}</td><td>${r.flown}</td><td>${r.cautions}</td><td>${r.spokeUp}</td><td class="${r.goOnCaution > 0 ? "neg" : ""}">${r.goOnCaution}</td></tr>`)}</tbody></table></div>`,
  });
});

crewPages.get("/crew/:callsign", (c) => {
  const who = findCrew(c.req.param("callsign"));
  if (!who) return page(c, { title: "No such crew member", body: html`<h1>No such crew member</h1><p><a href="/crew">All crew</a></p>`, status: 404 });
  const p = profileOf(who.id);
  const r = p.record;
  const outcomes = Object.entries(p.outcomes);
  return page(c, {
    title: who.callsign,
    body: html`<p><a href="/crew">&larr; All crew</a></p>
<div class="mission-head"><p class="eyebrow">Crew member since ${fmtDate(who.created_at)}</p><h1><span class="callsign">${who.callsign}</span></h1></div>
<div class="stats">
  <div class="panel"><h3>Missions flown</h3><p class="stat" id="flown">${p.flown}</p>
    <p class="muted">${outcomes.length === 0 ? "None yet" : outcomes.map(([k, n]) => `${n} ${OUTCOME_LABEL[k]?.toLowerCase() ?? k}`).join(", ")}</p></div>
  <div class="panel"><h3>Seats held most</h3>${p.roles.length === 0 ? html`<p class="muted">None yet</p>` : html`<ul class="plain">${p.roles.slice(0, 3).map((x) => html`<li>${ROLE_LABELS[x.role]} <span class="muted">${x.n}</span></li>`)}</ul>`}</div>
</div>
<section aria-labelledby="h-record"><h2 id="h-record">The record</h2>
<p id="verdict" class="${r.goOnCaution > 0 ? "caution-count" : ""}">${verdict(r)}</p>
<ul class="plain"><li>${r.reports} poll ${r.reports === 1 ? "report" : "reports"}</li><li>${r.cautions} while their console showed a caution</li><li>GO on a caution: <strong id="go-caution">${r.goOnCaution}</strong></li><li>NO-GO on a caution (spoke up): <strong id="spoke-up">${r.spokeUp}</strong></li></ul>
<p class="muted">Seats are attributed to whoever held them when the mission ran. Only finished missions are counted.</p></section>
<section aria-labelledby="h-flown"><h2 id="h-flown">Flown missions</h2>
${p.missions.length === 0 ? html`<p class="muted">No missions flown yet.</p>` : html`<div class="scroll"><table class="record"><thead><tr><th>Mission</th><th>Sequence</th><th>Seats</th><th>Outcome</th><th>GO on caution</th></tr></thead><tbody>
${p.missions.map((m) => html`<tr><td><a class="code" href="/missions/${m.code}">${m.code}</a></td><td>${getSequence(m.sequence_id).name}</td><td>${m.roles.map((x) => ROLE_LABELS[x]).join(", ")}</td><td>${m.outcome ? OUTCOME_LABEL[m.outcome] ?? m.outcome : "Ended"}</td><td>${m.goOnCaution}</td></tr>`)}</tbody></table></div>`}
</section>`,
  });
});
