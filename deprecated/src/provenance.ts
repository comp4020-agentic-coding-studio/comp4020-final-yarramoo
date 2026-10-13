import { html, raw } from "hono/html";
import { db } from "./db/index.ts";
import type { Html } from "./views/layout.ts";

// Provenance: quiet behaviour signals about how a text was entered. Nothing here is shown to
// other users. public/provenance.js reports, per form: characters typed, prose characters
// pasted, paste events, characters deleted while editing and focused-and-active writing time.
// "Prose" is text outside ``` fences (code and logs may be pasted freely). The client is
// untrusted and these are behaviour hints, never proof that anyone used a machine.
//
// score in [0,1] = 0.5 * pastedRatio + 0.3 * speed + 0.2 * noRevision, where
//   pastedRatio = pasted prose chars / prose chars        (text that arrived by paste)
//   speed       = ramp from 0 at 400 prose chars per active minute to 1 at 800 (only for prose
//                 >= 100 chars; typing much faster than that is implausible for composing)
//   noRevision  = 1 when prose >= 400 and deletions / prose < 1%  (people edit as they write)
// Missing signals contribute 0 for their term; if the paste counts are missing altogether (no
// JavaScript) the score is null ("unknown"). The score feeds an admin review list and the
// machine-facing label in /provenance.json; `potentially_ai` is just score >= 0.6.
//
// Admin: ADMIN_HANDLES is a comma-separated list of handles. An entry ending in `*` is a
// prefix match (so the test server can use `admin_test_*`).

export type Provenance = {
  typed: number | null;
  pastedProse: number | null;
  proseChars: number;
  activeMs: number | null;
  pasteEvents: number | null;
  deletions: number | null;
  score: number | null;
  potentiallyAi: boolean;
};

export type Label = "typed" | "mixed" | "pasted" | "unknown";
const TYPES = ["question", "answer", "project", "update", "profile"] as const;
export type TargetType = (typeof TYPES)[number];

const FENCE = /```[\s\S]*?(?:```|$)/g;

/** Length of the text outside ``` fences (unclosed fences run to the end). */
export function proseLength(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(FENCE, "").length;
}

function num(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v);
}

const DAY_MS = 24 * 3600 * 1000;

export function computeScore(p: Omit<Provenance, "score" | "potentiallyAi">): number | null {
  if (p.typed === null || p.pastedProse === null) return null;
  const prose = p.proseChars;
  const ratio = prose > 0 ? Math.min(1, p.pastedProse / prose) : 0;
  let speed = 0;
  if (p.activeMs !== null && prose >= 100) {
    const cpm = prose / (Math.max(p.activeMs, 1000) / 60000);
    speed = Math.min(1, Math.max(0, (cpm - 400) / 400));
  }
  const noRevision = p.deletions !== null && prose >= 400 && p.deletions / prose < 0.01 ? 1 : 0;
  return Math.round((0.5 * ratio + 0.3 * speed + 0.2 * noRevision) * 1000) / 1000;
}

export function readProvenance(body: Record<string, unknown>, text: string): Provenance {
  const norm = text.replace(/\r\n?/g, "\n");
  const proseChars = proseLength(norm);
  const t = num(body["prov_typed"]);
  const p = num(body["prov_pasted_prose"]);
  const a = num(body["prov_active_ms"]);
  const e = num(body["prov_paste_events"]);
  const d = num(body["prov_deletions"]);
  const base = {
    typed: t === null ? null : Math.min(t, norm.length),
    pastedProse: p === null ? null : Math.min(p, proseChars),
    proseChars,
    activeMs: a === null ? null : Math.min(a, DAY_MS),
    pasteEvents: e === null ? null : Math.min(e, 100000),
    deletions: d === null ? null : Math.min(d, 1000000),
  };
  const score = computeScore(base);
  return { ...base, score, potentiallyAi: score !== null && score >= 0.6 };
}

/** Record (or overwrite) the signals for one item. Admin review state (hidden, reviewed) is kept. */
export function saveProvenance(type: TargetType, id: number, p: Provenance, pledged = true): void {
  db.prepare(
    `INSERT INTO provenance (target_type, target_id, pledged, typed_chars, pasted_prose_chars, prose_chars, potentially_ai, active_ms, paste_events, deletions, score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (target_type, target_id) DO UPDATE SET pledged = excluded.pledged, typed_chars = excluded.typed_chars,
       pasted_prose_chars = excluded.pasted_prose_chars, prose_chars = excluded.prose_chars, potentially_ai = excluded.potentially_ai,
       active_ms = excluded.active_ms, paste_events = excluded.paste_events, deletions = excluded.deletions, score = excluded.score`,
  ).run(type, id, pledged ? 1 : 0, p.typed, p.pastedProse, p.proseChars, p.potentiallyAi ? 1 : 0, p.activeMs, p.pasteEvents, p.deletions, p.score);
}

export function isHidden(type: TargetType, id: number): boolean {
  return !!db.prepare("SELECT 1 FROM provenance WHERE target_type = ? AND target_id = ? AND hidden = 1").get(type, id);
}

/** SQL condition excluding hidden rows, e.g. notHidden("question", "q.id"). `idColumn` is code, never user input. */
export function notHidden(type: TargetType, idColumn: string): string {
  if (!(TYPES as readonly string[]).includes(type)) throw new Error(`bad provenance type ${type}`);
  if (!/^[a-z_]+\.[a-z_]+$|^[a-z_]+$/.test(idColumn)) throw new Error(`bad column ${idColumn}`);
  return `NOT EXISTS (SELECT 1 FROM provenance pv WHERE pv.target_type = '${type}' AND pv.target_id = ${idColumn} AND pv.hidden = 1)`;
}

export function labelOf(score: number | null | undefined): Label {
  if (score === null || score === undefined) return "unknown";
  return score < 0.3 ? "typed" : score < 0.6 ? "mixed" : "pasted";
}

/** Machine-facing label from the backend score. Never rendered as a badge. */
export function provenanceLabel(type: TargetType, id: number): Label {
  const r = db.prepare("SELECT score FROM provenance WHERE target_type = ? AND target_id = ?").get(type, id) as { score: number | null } | undefined;
  return labelOf(r?.score);
}

export function isAdmin(user: { handle: string } | null | undefined): boolean {
  if (!user) return false;
  const h = user.handle.toLowerCase();
  return (process.env.ADMIN_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((e) => (e.endsWith("*") ? h.startsWith(e.slice(0, -1)) : h === e));
}

export const PLEDGE_ERR = "Please tick the box to confirm you wrote this in your own words.";
export const pledgeField: Html = html`<label class="check"><input type="checkbox" name="pledge" value="1" required> I wrote this in my own words.</label>`;

export const UNDER_REVIEW = html`<p class="muted review-note" role="note">This post is under review.</p>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    url = url.slice(0, url.length - trail.length);
    out += esc(text.slice(last, m.index));
    if (url.length > 8) out += `<a href="${esc(url)}" rel="nofollow ugc noopener" target="_blank">${esc(url)}</a>`;
    else out += esc(url);
    out += esc(trail);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

function paragraphs(text: string): string {
  return text.split(/\n[ \t]*\n+/).map((p) => p.replace(/^\n+|\n+$/g, "")).filter((p) => p.trim())
    .map((p) => `<p>${p.split("\n").map(inline).join("<br>")}</p>`).join("");
}

/** Escape everything; ``` fences become <pre><code>, other text becomes paragraphs. */
export function renderBody(text: string): Html {
  const src = text.replace(/\r\n?/g, "\n");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(/```([^\n]*)\n?([\s\S]*?)(?:```|$)/g)) {
    out += paragraphs(src.slice(last, m.index));
    out += `<pre><code>${esc(m[2]!.replace(/\n$/, ""))}</code></pre>`;
    last = m.index + m[0].length;
  }
  out += paragraphs(src.slice(last));
  return html`<div class="rich">${raw(out)}</div>`;
}
