// Fixed list of regions. A postcode belongs to the capital-city metro whose CBD is within that
// metro's radius (the nearest one, if radii overlap); otherwise to "regional-<state>". The ACT has
// no regional region: any ACT postcode is canberra. Note this module must not import ./db (the
// postcode loader imports it), so the distance helper is local.

import { html } from "hono/html";
import type { Html } from "./views/layout.ts";

export type Region = { slug: string; name: string; state: string; lat?: number; lon?: number; radiusKm?: number };

const metro = (slug: string, name: string, state: string, lat: number, lon: number, radiusKm: number): Region => ({ slug, name, state, lat, lon, radiusKm });
const regional = (state: string, name: string): Region => ({ slug: `regional-${state.toLowerCase()}`, name: `Regional ${name}`, state });

export const REGIONS: Region[] = [
  metro("canberra", "Canberra", "ACT", -35.2809, 149.13, 40), // includes Queanbeyan (2620)
  metro("sydney", "Sydney", "NSW", -33.8688, 151.2093, 60),
  regional("NSW", "NSW"),
  metro("melbourne", "Melbourne", "VIC", -37.8136, 144.9631, 60),
  regional("VIC", "Victoria"),
  metro("brisbane", "Brisbane", "QLD", -27.4698, 153.0251, 60),
  regional("QLD", "Queensland"),
  metro("perth", "Perth", "WA", -31.9505, 115.8605, 60),
  regional("WA", "Western Australia"),
  metro("adelaide", "Adelaide", "SA", -34.9285, 138.6007, 60),
  regional("SA", "South Australia"),
  metro("hobart", "Hobart", "TAS", -42.8821, 147.3272, 40),
  regional("TAS", "Tasmania"),
  metro("darwin", "Darwin", "NT", -12.4634, 130.8456, 40),
  regional("NT", "Northern Territory"),
];

export const REGION_BY_SLUG = new Map(REGIONS.map((r) => [r.slug, r]));

/** Regions in display order, grouped by state (state order of first appearance in REGIONS). */
export function regionsByState(): { state: string; regions: Region[] }[] {
  const out: { state: string; regions: Region[] }[] = [];
  for (const r of REGIONS) {
    let g = out.find((x) => x.state === r.state);
    if (!g) out.push((g = { state: r.state, regions: [] }));
    g.regions.push(r);
  }
  return out;
}

function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Region slug for a postcode row: nearest capital metro within its radius, else regional-<state>. */
export function regionOf(p: { state: string; lat: number; lon: number }): string {
  let best: string | null = null;
  let bestD = Infinity;
  for (const r of REGIONS) {
    if (r.lat === undefined || r.lon === undefined || r.radiusKm === undefined) continue;
    const d = distKm(r.lat, r.lon, p.lat, p.lon);
    if (d <= r.radiusKm && d < bestD) { best = r.slug; bestD = d; }
  }
  if (best) return best;
  return p.state === "ACT" ? "canberra" : `regional-${p.state.toLowerCase()}`;
}

/** <select name="region"> grouped by state, with "Anywhere" first; `selected` is a region slug or "". */
export function regionSelect(selected: string): Html {
  return html`<select name="region"><option value="">Anywhere</option>${regionsByState().map((g) =>
    html`<optgroup label="${g.state}">${g.regions.map((r) => html`<option value="${r.slug}" ${r.slug === selected ? "selected" : ""}>${r.name}</option>`)}</optgroup>`)}</select>`;
}
