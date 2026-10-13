import { html } from "hono/html";
import { publish } from "./bus.ts";
import { CATEGORY_BY_SLUG } from "./categories.ts";
import { db } from "./db/index.ts";
import { lookupPostcode } from "./geo.ts";
import { isExampleUser } from "./examples.ts";
import { isHidden } from "./provenance.ts";
import { REGION_BY_SLUG, regionOf } from "./regions.ts";

// "Something just happened" toasts. Text carries only titles, handles, category and region, never bodies.
export type Kind = "project-posted" | "project-finished" | "project-started" | "team-grew" | "update-posted" | "question-asked" | "answer-accepted" | "team-formed";
type Opts = { projectId?: number; questionId?: number; actorId?: number; handle?: string; photos?: number; updateId?: number };
type P = { id: number; title: string; postcode: string | null; category: string | null };

const cut = (s: string) => (s.length > 60 ? s.slice(0, 59) + "…" : s);

/** Build and publish an activity event. Hidden content is never announced. Never throws. */
export function announce(kind: Kind, o: Opts): void {
  try {
    if (isExampleUser(o.actorId)) return;
    let text = "";
    let href = "/";
    let category: string | undefined;
    let region: string | undefined;
    if (o.projectId !== undefined) {
      const p = db.prepare("SELECT id, title, postcode, category FROM projects WHERE id = ?").get(o.projectId) as P | undefined;
      if (!p || isHidden("project", p.id)) return;
      const t = cut(p.title);
      href = `/projects/${p.id}`;
      category = p.category && CATEGORY_BY_SLUG.has(p.category) ? p.category : undefined;
      const place = p.postcode ? lookupPostcode(p.postcode) : null;
      const r = place ? REGION_BY_SLUG.get(regionOf(place)) : undefined;
      region = r?.name;
      const inRegion = r ? ` in ${r.name}` : "";
      if (kind === "project-posted") text = `New project: ${t}${inRegion}`;
      else if (kind === "project-finished") text = `${t} is finished!`;
      else if (kind === "project-started") text = `${t} is under way`;
      else if (kind === "team-formed") text = `A team formed: ${t}`;
      else if (kind === "team-grew") text = `${o.handle ? "@" + o.handle : "Someone"} joined ${t}`;
      else if (kind === "update-posted") {
        if (o.updateId !== undefined && isHidden("update", o.updateId)) return;
        const n = o.photos ?? 0;
        text = `New update on ${t}${n ? ` (${n} photo${n === 1 ? "" : "s"})` : ""}`;
        if (o.updateId !== undefined) href += `#update-${o.updateId}`;
      } else return;
    } else if (o.questionId !== undefined) {
      const q = db.prepare("SELECT id, title FROM questions WHERE id = ?").get(o.questionId) as { id: number; title: string } | undefined;
      if (!q || isHidden("question", q.id)) return;
      href = `/questions/${q.id}`;
      text = kind === "answer-accepted" ? `An answer was accepted: ${cut(q.title)}` : `New question: ${cut(q.title)}`;
    } else return;
    const snippet = html`<a class="activity-link" href="${href}">${text}</a>`;
    publish("activity", { type: "activity", data: { kind, text, href, category, region, actor: o.actorId ?? null }, html: String(snippet) });
  } catch { /* announcing must never break the request */ }
}
