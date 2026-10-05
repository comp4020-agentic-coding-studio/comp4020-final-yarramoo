// Fixed list of project themes. Themes cut across categories: a project has one category and 0-3 themes.
//
// NOTE FOR THE OWNER: every `intro` below is placeholder copy, written by Claude as one neutral
// sentence each. The site's policy is human-written text, so rewrite these in your own words.
// `resources` is empty on purpose: add links only after you have checked them yourself.
import { html } from "hono/html";
import { db } from "./db/index.ts";
import type { Html } from "./views/layout.ts";

export type Theme = { slug: string; name: string; intro: string; resources: { name: string; url: string; note: string }[] };

export const MAX_THEMES = 3;

export const THEMES: Theme[] = [
  { slug: "retro-computing", name: "Retro computing", intro: "Old hardware, restoration, and reimplementing lost software.", resources: [] }, // placeholder copy
  { slug: "repair-and-reuse", name: "Repair and reuse", intro: "Keeping tools and gear working, and giving old parts a second life.", resources: [] }, // placeholder copy
  { slug: "open-hardware", name: "Open hardware", intro: "Designs published with the files others need to build, modify and learn from them.", resources: [] }, // placeholder copy
  { slug: "citizen-science", name: "Citizen science", intro: "Sensors and experiments that collect real data for the community.", resources: [] }, // placeholder copy
  { slug: "assistive-tech", name: "Assistive tech", intro: "Tools and devices that make daily life easier for people with disability.", resources: [] }, // placeholder copy
  { slug: "off-grid-energy", name: "Off-grid energy", intro: "Solar, batteries and other power systems that work away from the mains.", resources: [] }, // placeholder copy
];

export const THEME_BY_SLUG = new Map(THEMES.map((t) => [t.slug, t]));

const themesOfStmt = db.prepare("SELECT theme FROM project_themes WHERE project_id = ?");
/** Theme slugs of a project, in list order. */
export function themesOf(projectId: number): string[] {
  const have = new Set((themesOfStmt.all(projectId) as { theme: string }[]).map((r) => r.theme));
  return THEMES.map((t) => t.slug).filter((s) => have.has(s));
}

export const themeChip = (slug: string): Html => {
  const t = THEME_BY_SLUG.get(slug);
  return t ? html`<a class="chip theme-chip" href="/t/${t.slug}">${t.name}</a>` : html``;
};
export const themeChips = (projectId: number): Html => html`${themesOf(projectId).map((s) => html`${themeChip(s)} `)}`;

/** Submitted `themes` values, as strings (lenient: used to refill the form after an error). */
export function themesFrom(b: Record<string, unknown>): string[] {
  const v = b.themes;
  return [...new Set((Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string"))];
}

/** Validate submitted themes: known slugs only, at most MAX_THEMES. */
export function readThemes(b: Record<string, unknown>): { error: string } | { themes: string[] } {
  const themes = themesFrom(b);
  if (themes.some((s) => !THEME_BY_SLUG.has(s))) return { error: "Unknown theme." };
  if (themes.length > MAX_THEMES) return { error: `Choose at most ${MAX_THEMES} themes.` };
  return { themes };
}

/** Replace a project's themes (call inside a transaction). */
export function saveThemes(projectId: number, themes: string[]): void {
  db.prepare("DELETE FROM project_themes WHERE project_id = ?").run(projectId);
  const ins = db.prepare("INSERT INTO project_themes (project_id, theme) VALUES (?,?)");
  for (const t of themes) ins.run(projectId, t);
}

export function themeCheckboxes(selected: string[]): Html {
  return html`<fieldset class="themes-field"><legend>Themes (optional, up to ${MAX_THEMES})</legend>
${THEMES.map((t) => html`<label class="check"><input type="checkbox" name="themes" value="${t.slug}" ${selected.includes(t.slug) ? "checked" : ""}> ${t.name}</label>`)}</fieldset>`;
}
