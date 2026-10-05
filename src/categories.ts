// Fixed list of project categories.
//
// NOTE FOR THE OWNER: every `description` below is placeholder copy, written by Claude as one
// neutral factual sentence each. The site's policy is human-written text, so rewrite these in your
// own words (and the safety line / resource notes if you want to). Resource links are limited to
// ones that were checked; do not add unverified URLs.
import { html } from "hono/html";
import type { Html } from "./views/layout.ts";

export type Resource = { name: string; url: string; note: string };
export type Category = { slug: string; name: string; description: string; teamSize: number | null; resources?: Resource[]; safety?: string };

export const CATEGORIES: Category[] = [
  {
    slug: "rocketry", name: "Rocketry", teamSize: 5,
    description: "Model and high-power rockets, from small motors to certified flights.", // placeholder copy
    safety: "Fly with a club: clubs arrange insurance and airspace clearance, and high-power motors need certification.", // placeholder copy
    resources: [
      { name: "Canberra Rocketry Group", url: "https://crg.tidyhq.com/", note: "Canberra region club; Tripoli prefecture. Launches near Yass and Ardlethan." },
      { name: "NSW Rocketry Association", url: "https://nswrocketry.org.au/", note: "Sydney/NSW club; Tripoli prefecture. Certification info for mid and high power." },
    ],
  },
  { slug: "robotics", name: "Robotics", teamSize: 3, description: "Machines that sense and move, from hobby rovers to arms." }, // placeholder copy
  { slug: "3d-printing", name: "3D printing", teamSize: 3, description: "Designing and printing parts, and building or tuning printers." }, // placeholder copy
  { slug: "electronics", name: "Electronics", teamSize: 3, description: "Circuits, microcontrollers and PCB design." }, // placeholder copy
  { slug: "radio", name: "Radio", teamSize: 3, description: "Amateur (ham) radio, antennas and wireless experiments." }, // placeholder copy
  { slug: "woodwork", name: "Woodwork", teamSize: 3, description: "Furniture, joinery and other projects built from timber." }, // placeholder copy
  { slug: "metalwork", name: "Metalwork", teamSize: 3, description: "Welding, machining and fabrication in steel and other metals." }, // placeholder copy
  { slug: "bikes", name: "Bikes", teamSize: 3, description: "Building, repairing and modifying bicycles and e-bikes." }, // placeholder copy
  { slug: "home-automation", name: "Home automation", teamSize: 3, description: "Sensors, switches and software that automate a home or workshop." }, // placeholder copy
  { slug: "repair-cafe", name: "Repair cafe", teamSize: 4, description: "Fixing broken household items together instead of throwing them away." }, // placeholder copy
  { slug: "garden-tech", name: "Garden tech", teamSize: 3, description: "Irrigation, sensors and tools for growing food and plants." }, // placeholder copy
  { slug: "other", name: "Other", teamSize: null, description: "Projects that do not fit another category." }, // placeholder copy
];

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

/** A stored category value as a valid slug; NULL or unknown reads as "other". */
export const categoryOf = (v: string | null | undefined): string => (v && CATEGORY_BY_SLUG.has(v) ? v : "other");

/** Chip linking to the category's page. */
export function categoryChip(v: string | null | undefined): Html {
  const c = CATEGORY_BY_SLUG.get(categoryOf(v))!;
  return html`<a class="chip" href="/c/${c.slug}">${c.name}</a>`;
}

/** <select name="category">; `anyLabel` adds a leading empty option (for filters), otherwise a category is required. */
export function categorySelect(selected: string, anyLabel?: string): Html {
  return html`<select name="category" ${anyLabel ? "" : "required"}>${anyLabel ? html`<option value="">${anyLabel}</option>` : ""}${CATEGORIES.map((c) => html`<option value="${c.slug}" ${c.slug === selected ? "selected" : ""}>${c.name}</option>`)}</select>`;
}
