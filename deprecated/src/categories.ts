// Fixed list of project categories.
//
// NOTE FOR THE OWNER: every `description` below is placeholder copy, written by Claude as one
// neutral factual sentence each. The site's policy is human-written text, so rewrite these in your
// own words (and the safety line / resource notes if you want to). Resource links are limited to
// ones that were checked; do not add unverified URLs. Club links beyond rocketry come from
// research/hobby-groups.md, keeping only URLs that returned HTTP 200 on 2026-10-05.
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
  { slug: "robotics", name: "Robotics", teamSize: 3, description: "Machines that sense and move, from hobby rovers to arms.", resources: [
    { name: "Canberra Makerspace", url: "https://canberramaker.space", note: "Member-run makerspace in Giralang, ACT: electronics, 3D printing, wood and metal." },
  ] }, // placeholder copy
  { slug: "3d-printing", name: "3D printing", teamSize: 3, description: "Designing and printing parts, and building or tuning printers.", resources: [
    { name: "Canberra Makerspace", url: "https://canberramaker.space", note: "Member-run makerspace in Giralang, ACT: electronics, 3D printing, wood and metal." },
    { name: "HSBNE", url: "https://hsbne.org/", note: "Brisbane community workshop and maker collective." },
  ] }, // placeholder copy
  { slug: "electronics", name: "Electronics", teamSize: 3, description: "Circuits, microcontrollers and PCB design.", resources: [
    { name: "Canberra Makerspace", url: "https://canberramaker.space", note: "Member-run makerspace in Giralang, ACT: electronics, 3D printing, wood and metal." },
    { name: "HSBNE", url: "https://hsbne.org/", note: "Brisbane community workshop and maker collective." },
  ] }, // placeholder copy
  { slug: "radio", name: "Radio", teamSize: 3, description: "Amateur (ham) radio, antennas and wireless experiments." }, // placeholder copy
  { slug: "woodwork", name: "Woodwork", teamSize: 3, description: "Furniture, joinery and other projects built from timber.", resources: [
    { name: "Triton Owners' Club (ACT)", url: "https://www.tocact.org.au/", note: "Canberra and Queanbeyan woodworking club with monthly meetings." },
  ] }, // placeholder copy
  { slug: "metalwork", name: "Metalwork", teamSize: 3, description: "Welding, machining and fabrication in steel and other metals.", resources: [
    { name: "Artist Blacksmiths Association of NSW", url: "https://www.artistblacksmithnsw.com", note: "Open to amateurs and professionals; regular hands-on sessions." },
    { name: "Artist Blacksmith Association (Victoria)", url: "https://www.abavic.org.au", note: "Victorian blacksmithing association." },
    { name: "Artist Blacksmiths Association South Australia", url: "https://www.artistblacksmithsa.org.au", note: "SA association offering support, training and skill sharing." },
  ] }, // placeholder copy
  { slug: "bikes", name: "Bikes", teamSize: 3, description: "Building, repairing and modifying bicycles and e-bikes.", resources: [
    { name: "The Recyclery", url: "https://www.canberraenvironment.org/the-recyclery", note: "Canberra Environment Centre's drop-in community bike workshop." },
  ] }, // placeholder copy
  { slug: "home-automation", name: "Home automation", teamSize: 3, description: "Sensors, switches and software that automate a home or workshop." }, // placeholder copy
  { slug: "repair-cafe", name: "Repair cafe", teamSize: 4, description: "Fixing broken household items together instead of throwing them away.", resources: [
    { name: "Community Toolbox Repair Café", url: "https://www.communitytoolboxcbr.org/repair-cafe", note: "Monthly repair café in Canberra." },
    { name: "Repair Cafe Sydney North", url: "https://repaircafesydneynorth.net/", note: "Regular Sunday repair sessions in Lane Cove." },
  ] }, // placeholder copy
  { slug: "garden-tech", name: "Garden tech", teamSize: 3, description: "Irrigation, sensors and tools for growing food and plants.", resources: [
    { name: "Canberra Organic Growers Society", url: "https://cogs.asn.au/", note: "Canberra community gardens society, running since 1982." },
  ] }, // placeholder copy
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
