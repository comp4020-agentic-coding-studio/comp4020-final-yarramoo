import { Hono } from "hono";
import { html } from "hono/html";
import { currentCrew } from "../crew.ts";
import { ledgerForMission } from "../game/agency.ts";
import { ledgerTable } from "./agency.ts";
import { getSequence } from "../game/sequences.ts";
import { countDone, doneMissions, eventsOf, getMission, goOnCautionCounts, liveMissions, seatsOf, seatsOfMany, type EventRow, type MissionRow, type Seats } from "../game/store.ts";
import { ROLES, ROLE_LABELS, type Role } from "../engine/types.ts";
import { callsignLink, page, type Html } from "../views/layout.ts";

export const history = new Hono();

const PAGE_SIZE = 50;
const OUTCOME_LABEL: Record<string, string> = { success: "SUCCESS", explosion: "EXPLOSION", scrub: "SCRUBBED", pad_abort: "PAD ABORT" };
const pad = (n: number): string => String(n).padStart(2, "0");
/** Milliseconds on the mission clock as T-01:48 / T+00:00. */
export function fmtT(ms: number): string {
  const t = Math.floor(Math.abs(ms) / 1000);
  return `T${ms < 0 ? "-" : "+"}${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
const fmtDate = (ms: number | null): string => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const roleLabel = (r: string | null | undefined): string => (r && r in ROLE_LABELS ? ROLE_LABELS[r as Role] : "Mission Control");

function outcomeOf(m: MissionRow): { kind: string; reasons: string[]; atT: number } | null {
  if (!m.outcome_json) return null;
  try { return JSON.parse(m.outcome_json); } catch { return null; }
}

const crewList = (seats: Seats): Html =>
  html`<ul class="crew-list">${ROLES.map((r) => (seats[r] ? html`<li><span class="muted">${ROLE_LABELS[r]}</span> ${callsignLink(seats[r]!)}</li>` : ""))}</ul>`;

history.get("/missions", (c) => {
  const pageNo = Math.min(1_000_000, Math.max(1, Math.floor(Number(c.req.query("page"))) || 1)); // a huge OFFSET makes SQLite throw
  const live = liveMissions();
  const total = countDone();
  const done = doneMissions(PAGE_SIZE, (pageNo - 1) * PAGE_SIZE);
  const seats = seatsOfMany([...live, ...done].map((m) => m.id));
  const cautions = goOnCautionCounts(done.map((m) => m.id));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const body = html`<h1>Missions</h1>
<section aria-labelledby="h-live"><h2 id="h-live">In progress</h2>
${live.length === 0 ? html`<p class="muted">No missions in progress.</p>` : html`<ul class="mission-list">${live.map((m) => html`<li class="panel">
  <p class="eyebrow">${getSequence(m.sequence_id).name}</p>
  <p><a class="code" href="/m/${m.code}">${m.code}</a> <span class="muted">started ${fmtDate(m.started_at)}</span></p>
  ${crewList(seats.get(m.id) ?? {})}
  <p><a href="/m/${m.code}">Watch</a> <span class="muted">(you will see the lobby strip only)</span></p></li>`)}</ul>`}
</section>
<section aria-labelledby="h-done"><h2 id="h-done">Flown</h2>
${done.length === 0 ? html`<p class="muted">No missions flown yet. ${currentCrew(c) ? html`<a href="/">Start one.</a>` : html`<a href="/">Start one.</a>`}</p>` : html`<ul class="mission-list">${done.map((m) => {
  const o = outcomeOf(m);
  const n = cautions.get(m.id) ?? 0;
  return html`<li class="panel">
  <p class="eyebrow">${getSequence(m.sequence_id).name} · ${fmtDate(m.ended_at ?? m.created_at)}</p>
  <p><a class="code" href="/missions/${m.code}">${m.code}</a> <span class="verdict ${o?.kind ?? ""}">${o ? OUTCOME_LABEL[o.kind] ?? o.kind : "ENDED"}</span></p>
  ${crewList(seats.get(m.id) ?? {})}
  <p class="${n > 0 ? "caution-count" : "muted"}">${n} go-on-caution ${n === 1 ? "report" : "reports"}</p>
  <p><a href="/missions/${m.code}">Replay</a></p></li>`;
})}</ul>
<p class="pager">${pageNo > 1 ? html`<a href="/missions?page=${pageNo - 1}">Newer</a>` : ""} <span class="muted">Page ${pageNo} of ${pages}</span> ${pageNo < pages ? html`<a href="/missions?page=${pageNo + 1}">Older</a>` : ""}</p>`}
</section>`;
  return page(c, { title: "Missions", body });
});

history.get("/missions/:code", (c) => {
  const code = c.req.param("code").toUpperCase();
  const m = getMission(code);
  if (!m) return page(c, { title: "No such mission", body: html`<h1>No such mission</h1><p><a href="/missions">All missions</a></p>`, status: 404 });
  if (m.status !== "done") return c.redirect(`/m/${m.code}`, 302);

  const seq = getSequence(m.sequence_id);
  const seats = seatsOf(m.id);
  const events = eventsOf(m.id);
  const out = outcomeOf(m);
  const step = (id: unknown): string => seq.steps.find((s) => s.id === id)?.label ?? String(id);
  const pollLbl = (id: unknown): string => seq.polls.find((p) => p.id === id)?.label ?? String(id);
  const fault = (id: unknown) => seq.faults.find((f) => f.id === id);
  const faultLbl = (id: unknown): string => fault(id)?.label ?? String(id);
  const goNo = (r: unknown): string => (r === "go" ? "GO" : "NO-GO");
  const showing = (s: unknown): string => String(s ?? "").toUpperCase();
  const lower1 = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

  const sentence = (e: EventRow): string => {
    const d = e.data;
    const who = roleLabel(e.role);
    switch (e.kind) {
      case "start": return "Flight Director started the count";
      case "step_done": return `${who} completed: ${step(d["stepId"])}${d["late"] ? " (during a hold)" : ""}`;
      case "step_missed": return `${who} missed the window: ${step(d["stepId"])}${d["required"] ? "" : " (optional)"}`;
      case "fault_active": return `Caution on ${who}: ${faultLbl(d["faultId"])} (${d["real"] ? "real fault" : "glitch"})`;
      case "fault_resolved": return `${who} cleared: ${faultLbl(d["faultId"])}`;
      case "poll_opened": return `Flight Director opened the poll: ${pollLbl(d["pollId"])}${Number(d["round"]) > 1 ? ` (round ${d["round"]})` : ""}`;
      case "poll_report": {
        const bad = d["report"] === "go" && d["showing"] === "caution";
        return `${who} reported ${goNo(d["report"])} while showing ${showing(d["showing"])}${bad ? " (go on caution)" : ""}`;
      }
      case "poll_closed": return `Poll closed: ${pollLbl(d["pollId"])} (${d["allGo"] ? "all GO" : "not all GO"})`;
      case "poll_missed": return `Poll window passed unclosed: ${pollLbl(d["pollId"])}`;
      case "hold": return `Automatic hold: ${String(d["reason"] ?? "")}`.replace(/: $/, "");
      case "resume": return "Flight Director resumed the count";
      case "scrub": return d["reason"] && d["reason"] !== "Scrubbed by the Flight Director" ? `Mission scrubbed: ${String(d["reason"])}` : "Flight Director scrubbed the mission";
      case "window_closed": return `Launch window closed: ${String(d["reason"] ?? "the hold budget ran out")}`;
      case "outcome":
        if (d["kind"] === "pad_abort") return `Launch: PAD ABORT \u2014 engines shut down at ignition${Array.isArray(d["reasons"]) && d["reasons"].length ? ` (${(d["reasons"] as string[]).map(lower1).join("; ")})` : ""}`;
        return `Launch: ${OUTCOME_LABEL[String(d["kind"])] ?? String(d["kind"])}${Array.isArray(d["reasons"]) && d["reasons"].length ? ` (${(d["reasons"] as string[]).map(lower1).join("; ")})` : ""}`;
      default: return `${who}: ${e.kind}`;
    }
  };

  // The record: poll reports and faults.
  const reports = events.filter((e) => e.kind === "poll_report");
  const faultRows = events.filter((e) => e.kind === "fault_active").map((e) => {
    const id = e.data["faultId"];
    const fixed = events.find((x) => x.kind === "fault_resolved" && x.data["faultId"] === id);
    return { label: faultLbl(id), role: e.role, real: !!e.data["real"], at: e.at_t, fixedAt: fixed?.at_t ?? null };
  });
  const nCaution = reports.filter((e) => e.data["report"] === "go" && e.data["showing"] === "caution").length;

  const span = seq.countdownSec * 1000;
  const pos = (t: number): number => Math.max(0, Math.min(100, ((t + span) / span) * 100));

  const body = html`<p><a href="/missions">&larr; All missions</a></p>
<div class="mission-head">
  <p class="eyebrow">${seq.name} · ${fmtDate(m.ended_at ?? m.created_at)}</p>
  <h1>Mission <span class="code">${m.code}</span></h1>
</div>
<section class="outcome ${out?.kind ?? ""}"><h2>${out ? OUTCOME_LABEL[out.kind] ?? out.kind : "ENDED"}</h2>
  ${out ? html`<p class="countdown-final">${fmtT(out.atT)}</p><ul>${out.reasons.map((r) => html`<li>${r}</li>`)}</ul>` : ""}</section>
<section class="panel"><h3>Crew</h3>${crewList(seats)}</section>

<section aria-labelledby="h-cost"><h2 id="h-cost">What it cost the agency</h2>${ledgerTable(ledgerForMission(m.id), { showMission: false })}</section>

<section aria-labelledby="h-record"><h2 id="h-record">The record</h2>
<p class="muted">${nCaution} go-on-caution ${nCaution === 1 ? "report" : "reports"}: a seat said GO while its own console showed a caution.</p>
<h3>Poll reports</h3>
<div class="scroll"><table class="record"><thead><tr><th>Poll</th><th>Seat</th><th>Crew</th><th>Reported</th><th>Console showed</th><th>At</th><th></th></tr></thead><tbody>
${reports.length === 0 ? html`<tr><td colspan="7">No polls were reported.</td></tr>` : reports.map((e) => {
  const bad = e.data["report"] === "go" && e.data["showing"] === "caution";
  return html`<tr class="${bad ? "bad" : ""}"><td>${pollLbl(e.data["pollId"])}</td><td>${roleLabel(e.role)}</td><td>${e.role && seats[e.role] ? callsignLink(seats[e.role]!) : ""}</td><td>${goNo(e.data["report"])}</td><td>${showing(e.data["showing"])}</td><td>${fmtT(e.at_t)}</td><td>${bad ? "GO on CAUTION" : ""}</td></tr>`;
})}</tbody></table></div>
<h3>Faults</h3>
<div class="scroll"><table class="record"><thead><tr><th>Fault</th><th>Console</th><th>Truth</th><th>Appeared</th><th>Resolved</th></tr></thead><tbody>
${faultRows.length === 0 ? html`<tr><td colspan="5">No faults appeared.</td></tr>` : faultRows.map((f) => html`<tr><td>${f.label}</td><td>${roleLabel(f.role)}</td><td>${f.real ? "REAL fault" : "Glitch"}</td><td>${fmtT(f.at)}</td><td>${f.fixedAt !== null ? fmtT(f.fixedAt) : "No"}</td></tr>`)}</tbody></table></div>
</section>

<section aria-labelledby="h-time"><h2 id="h-time">Timeline</h2>
<div class="tbar" role="img" aria-label="Events from ${fmtT(-span)} to T+00:00">
  ${events.map((e) => html`<span class="tick k-${e.kind} r-${e.role ?? "none"}" style="left:${pos(e.at_t).toFixed(2)}%" title="${fmtT(e.at_t)} ${sentence(e)}"></span>`)}
</div>
<div class="tbar-axis"><span>${fmtT(-span)}</span><span>T+00:00</span></div>
<ol class="timeline">
${events.map((e) => html`<li class="ev k-${e.kind}"><span class="ev-t">${fmtT(e.at_t)}</span><span class="rtag r-${e.role ?? "none"}">${e.role ? roleLabel(e.role) : "System"}</span><span class="ev-s">${sentence(e)}</span></li>`)}
</ol></section>`;
  return page(c, { title: `Replay ${m.code}`, body });
});
