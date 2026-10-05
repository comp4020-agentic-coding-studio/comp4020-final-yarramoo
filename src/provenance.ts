import { html, raw } from "hono/html";
import { db } from "./db/index.ts";
import type { Html } from "./views/layout.ts";

// Provenance: an honest, soft signal about how a text was entered. We cannot detect
// machine-written text; we record how much *prose* (text outside ``` fences) arrived by
// paste, as reported by public/provenance.js. The client is untrusted: values are only
// ever a hint. `potentially_ai` is backend-only and is never rendered anywhere.

export type Provenance = {
  typed: number | null;
  pastedProse: number | null;
  proseChars: number;
  potentiallyAi: boolean;
};

const FENCE = /```[\s\S]*?(?:```|$)/g;

/** Length of the text outside ``` fences (unclosed fences run to the end). */
export function proseLength(text: string): number {
  return text.replace(/\r\n?/g, "\n").replace(FENCE, "").length;
}

function num(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v);
}

export function readProvenance(body: Record<string, unknown>, text: string): Provenance {
  const norm = text.replace(/\r\n?/g, "\n");
  const proseChars = proseLength(norm);
  const t = num(body["prov_typed"]);
  const p = num(body["prov_pasted_prose"]);
  if (t === null || p === null) return { typed: null, pastedProse: null, proseChars, potentiallyAi: false };
  const typed = Math.min(t, norm.length);
  const pastedProse = Math.min(p, proseChars);
  return { typed, pastedProse, proseChars, potentiallyAi: proseChars >= 200 && pastedProse / proseChars > 0.5 };
}

export function saveProvenance(type: string, id: number, p: Provenance, pledged = true): void {
  db.prepare(
    "INSERT OR REPLACE INTO provenance (target_type, target_id, pledged, typed_chars, pasted_prose_chars, prose_chars, potentially_ai) VALUES (?,?,?,?,?,?,?)",
  ).run(type, id, pledged ? 1 : 0, p.typed, p.pastedProse, p.proseChars, p.potentiallyAi ? 1 : 0);
}

export function provenanceLabel(type: string, id: number): "typed" | "pasted" | "unknown" {
  const r = db.prepare("SELECT typed_chars, pasted_prose_chars, potentially_ai FROM provenance WHERE target_type = ? AND target_id = ?")
    .get(type, id) as { typed_chars: number | null; pasted_prose_chars: number | null; potentially_ai: number } | undefined;
  if (!r) return "unknown";
  if (r.potentially_ai) return "pasted";
  if (r.typed_chars === null || r.pasted_prose_chars === null) return "unknown";
  return "typed";
}

/** Public, neutral badge. Typed and unknown show nothing. */
export function provenanceBadge(type: string, id: number): Html {
  return provenanceLabel(type, id) === "pasted" ? html`<span class="badge prov-pasted">contains pasted text</span>` : html``;
}

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
