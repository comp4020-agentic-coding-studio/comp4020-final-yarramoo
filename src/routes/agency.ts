import { Hono } from "hono";
import { html } from "hono/html";
import { streamSSE } from "hono/streaming";
import { subscribe } from "../bus.ts";
import { currentCrew } from "../crew.ts";
import { COSTS, padRepairCost } from "../game/agency-rules.ts";
import { AGENCY_TOPIC, APPROPRIATION_REPUTATION, appropriationNeeded, buyRocket, emergencyAppropriation, getAgency, getPads, getRockets, latestLedger, repairPad, repairRocket, type LedgerRow, type SpendResult } from "../game/agency.ts";
import { callsignLink, csrfField, page, type Html } from "../views/layout.ts";

export const agency = new Hono();

const fmtAt = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export const bar = (pct: number): Html =>
  html`<span class="bar" role="img" aria-label="${pct}%"><span class="bar-fill ${pct < 40 ? "low" : pct < 70 ? "mid" : ""}" style="width:${pct}%"></span></span> <span class="mono">${pct}%</span>`;

/** The ledger as a table; used here and on a mission's replay. */
export function ledgerTable(rows: LedgerRow[], opts: { showMission?: boolean } = {}): Html {
  const showMission = opts.showMission ?? true;
  return html`<div class="scroll"><table class="record ledger"><thead><tr><th>Time (UTC)</th>${showMission ? html`<th>Mission</th>` : ""}<th>Crew</th><th>Budget</th><th>Reputation</th><th>Reason</th></tr></thead><tbody>
${rows.length === 0 ? html`<tr><td colspan="6">Nothing yet.</td></tr>` : rows.map((l) => html`<tr><td>${fmtAt(l.at)}</td>${showMission ? html`<td>${l.code ? html`<a class="code" href="/missions/${l.code}">${l.code}</a>` : ""}</td>` : ""}<td>${l.callsign ? callsignLink(l.callsign) : ""}</td><td class="${l.budget_delta < 0 ? "neg" : l.budget_delta > 0 ? "pos" : ""}">${l.budget_delta === 0 ? "" : signed(l.budget_delta)}</td><td class="${l.reputation_delta < 0 ? "neg" : l.reputation_delta > 0 ? "pos" : ""}">${l.reputation_delta === 0 ? "" : signed(l.reputation_delta)}</td><td>${l.reason}</td></tr>`)}</tbody></table></div>`;
}

agency.get("/agency", (c) => {
  const crew = currentCrew(c);
  const a = getAgency();
  const pads = getPads();
  const rockets = getRockets();
  const ok = c.req.query("ok");
  const err = c.req.query("err");
  const form = (action: string, label: string, cost: number, extra: Html | "" = "", reason: string | null = null): Html => {
    const why = reason ?? (!crew ? "Take a callsign first" : cost > a.budget ? `Costs ${cost}; the budget is ${a.budget}` : null);
    return html`<form class="inline" method="post" action="${action}">${csrfField(c)}${extra}<button type="submit" ${why ? "disabled" : ""}>${label} (${cost})</button>${why ? html` <span class="muted">${why}</span>` : ""}</form>`;
  };
  const body = html`<h1>Agency</h1>
<p class="muted">One agency for everyone: the budget, the reputation, the pad and the rockets are shared by every crew.</p>
${ok ? html`<p id="flash" class="flash" role="status">${ok.slice(0, 200)}</p>` : ""}
${err ? html`<p id="flash-error" class="error" role="alert">${err.slice(0, 200)}</p>` : ""}
<div class="stats">
  <div class="panel"><h3>Budget</h3><p class="stat" id="budget">${a.budget}</p></div>
  <div class="panel"><h3>Reputation</h3><p class="stat" id="reputation">${a.reputation}<span class="muted"> / 100</span></p></div>
</div>
${appropriationNeeded() > 0 ? html`<section class="panel grounded" aria-labelledby="h-grounded"><h2 id="h-grounded">Grounded</h2>
  <p>The agency cannot launch and cannot afford to fix that. Any crew member can ask for an emergency appropriation: enough credits to fly again, at a cost of ${-APPROPRIATION_REPUTATION} reputation.</p>
  <form method="post" action="/agency/appropriation">${csrfField(c)}<button type="submit" ${crew ? "" : "disabled"}>Request ${appropriationNeeded()} credits</button>${crew ? "" : html` <span class="muted">Take a callsign first</span>`}</form></section>` : ""}
<p class="howto">Reputation rises when crews say NO-GO on a caution, and falls with every GO on a caution, even when the launch goes fine.</p>
<section aria-labelledby="h-pads"><h2 id="h-pads">Pads</h2>
${pads.map((p) => html`<div class="panel pad" data-pad="${p.name}"><p><strong>${p.name}</strong> ${bar(p.condition)}</p>
  <p class="muted">A pad below 40% cannot host a launch.</p>
  ${form("/agency/repair-pad", "Repair pad", padRepairCost(p.condition), "", p.condition >= 100 ? "Already at 100%" : null)}</div>`)}</section>
<section aria-labelledby="h-hangar"><h2 id="h-hangar">Hangar</h2>
<ul class="hangar">${rockets.map((r) => html`<li class="panel rocket" data-rocket="${r.name}" data-status="${r.status}"><p><strong>${r.name}</strong> <span class="verdict ${r.status === "ready" ? "success" : r.status === "repair" ? "scrub" : "explosion"}">${r.status.toUpperCase()}</span> <span class="muted">${r.flights} ${r.flights === 1 ? "flight" : "flights"}</span></p>
  ${r.status === "lost" ? "" : html`<p>${bar(r.condition)}</p>`}
  ${r.status === "repair" ? form("/agency/repair-rocket", "Repair", COSTS.rocketRepair, html`<input type="hidden" name="rocketId" value="${r.id}">`) : ""}</li>`)}</ul>
${form("/agency/buy-rocket", "Buy a rocket", COSTS.rocketBuy)}</section>
<section aria-labelledby="h-ledger"><h2 id="h-ledger">Ledger</h2>${ledgerTable(latestLedger(30))}</section>
<script src="/public/agency.js" defer></script>`;
  return page(c, { title: "Agency", body });
});

const back = (c: import("hono").Context, r: SpendResult) =>
  c.redirect(`/agency?${r.ok ? "ok" : "err"}=${encodeURIComponent(r.ok ? r.message : r.error)}`, 303);

for (const [path, run] of [
  ["repair-pad", (id: number) => repairPad(id)],
  ["buy-rocket", (id: number) => buyRocket(id)],
  ["appropriation", (id: number) => emergencyAppropriation(id)],
] as const) {
  agency.post(`/agency/${path}`, (c) => {
    const crew = currentCrew(c);
    if (!crew) return c.redirect("/", 303);
    return back(c, run(crew.id));
  });
}

agency.post("/agency/repair-rocket", async (c) => {
  const crew = currentCrew(c);
  if (!crew) return c.redirect("/", 303);
  const body = await c.req.parseBody();
  const id = Number(body["rocketId"]);
  if (!Number.isInteger(id)) return back(c, { ok: false, error: "No such rocket." });
  return back(c, repairRocket(crew.id, id));
});

// Agency-wide, nothing private: a bare "something changed" ping.
agency.get("/agency/stream", (c) => {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const unsub = subscribe(AGENCY_TOPIC, (e) => { stream.writeSSE({ data: JSON.stringify({ type: e.type }) }).catch(() => {}); });
    const done = new Promise<void>((resolve) => stream.onAbort(resolve));
    stream.writeSSE({ data: JSON.stringify({ type: "hello" }) }).catch(() => {});
    const beat = setInterval(() => { stream.write(": hb\n\n").catch(() => {}); }, 25_000);
    await done;
    clearInterval(beat);
    unsub();
  });
});
