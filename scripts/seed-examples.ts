#!/usr/bin/env node
// Posts a small set of clearly labelled EXAMPLE content (example_* accounts) so the site isn't empty.
// Everything it creates is badged "Example post" and excluded from /provenance.json, so unlike
// seed-dev.ts it may target the live site. Idempotent: exits 0 if example_jo already exists.
//   APP_URL=https://... EXAMPLE_SEED_KEY=... node scripts/seed-examples.ts
import { randomBytes } from "node:crypto";

const APP_URL = process.env.APP_URL;
const KEY = process.env.EXAMPLE_SEED_KEY;
if (!APP_URL || !KEY) {
  console.error("Set APP_URL and EXAMPLE_SEED_KEY.");
  process.exit(1);
}
const PASSWORD = randomBytes(18).toString("base64url");

class Client {
  jar = new Map<string, string>();
  async req(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-example-seed", KEY!);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(new URL(path, APP_URL), { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const i = kv.indexOf("=");
      const [k, v] = [kv.slice(0, i).trim(), kv.slice(i + 1)];
      if (v === "" || attrs.some((a) => /max-age=0/i.test(a))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async csrf(page: string) {
    const m = (await (await this.req(page)).text()).match(/name="_csrf" value="([0-9a-f]+)"/);
    if (!m) throw new Error(`no csrf field on ${page}`);
    return m[1];
  }
  /** POST a form, require a 302 to a path matching `loc`, return the Location. */
  async post(path: string, fields: Record<string, string | string[]>, formPage: string, loc: RegExp, what: string) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    body.set("_csrf", await this.csrf(formPage));
    const res = await this.req(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const location = res.headers.get("location") ?? "";
    if (res.status !== 302 || !loc.test(location)) {
      throw new Error(`${what}: expected 302 to ${loc}, got ${res.status} location=${location || "(none)"}\n${(await res.text()).slice(0, 800)}`);
    }
    return location;
  }
}

const login = (c: Client, handle: string) => c.post("/login", { handle, password: PASSWORD, next: "/" }, "/login", /^\//, `login ${handle}`);

// Already seeded? (A login with the fresh random password fails, so check the profile page instead.)
if ((await new Client().req("/u/example_jo")).status === 200) {
  console.log("examples already present");
  process.exit(0);
}

const ACCOUNTS = [
  { handle: "example_jo", postcode: "2602", skills: "soldering, arduino, lora" },
  { handle: "example_sam", postcode: "2617", skills: "machining, welding, woodwork" },
  { handle: "example_priya", postcode: "2000", skills: "electronics repair, 3d printing" },
  { handle: "example_lee", postcode: "3000", skills: "bike building, brazing, retro computing" },
];
const who = new Map<string, Client>();
for (const a of ACCOUNTS) {
  const c = new Client();
  await c.post("/signup", { handle: a.handle, password: PASSWORD, dob: "1990-01-01", safety_ok: "1", postcode: a.postcode }, "/signup", /^\/me/, `signup ${a.handle}`);
  await c.post("/me", { display_name: a.handle, postcode: a.postcode, skills: a.skills }, "/me", /^\/me/, `profile ${a.handle}`);
  who.set(a.handle, c);
  console.log(`created ${a.handle}`);
}
const as = (h: string) => who.get(h)!;

type Proj = { owner: string; title: string; summary: string; body: string; skills: string; postcode: string; category: string; themes: string[]; status: "open" | "in_progress" | "done"; update?: string };
const PROJECTS: Proj[] = [
  { owner: "example_jo", title: "Canberra LoRa weather network", summary: "A mesh of cheap LoRa weather stations across Canberra suburbs, with the data published openly.",
    body: "Frost pockets differ a lot between Tuggeranong and Gungahlin. We want 10 to 15 small solar stations (temperature, humidity, pressure) reporting over LoRa to a shared gateway. Designs and data will be open. Looking for people who can solder, write firmware or host a node.",
    skills: "soldering, arduino", postcode: "2602", category: "electronics", themes: ["citizen-science", "open-hardware"], status: "open" },
  { owner: "example_sam", title: "Restore a 1970s drill press", summary: "Bringing a seized 1970s pedestal drill press back to square, with a new motor mount.",
    body: "Bought from an estate sale in Fyshwick. The quill is stiff, the table is chipped and the belt guard is missing. Stripping, derusting and re-bushing it, then fitting a modern switch. Happy to share what works.",
    skills: "machining, welding", postcode: "2617", category: "metalwork", themes: ["repair-and-reuse"], status: "in_progress" },
  { owner: "example_lee", title: "Commodore 64 recap", summary: "Replacing the dried-out electrolytic capacitors in a breadbin Commodore 64.",
    body: "The picture was fuzzy and the SID was noisy. Recapped the board, cleaned the keyboard contacts and swapped the PSU for a modern one. It boots to BASIC again.",
    skills: "soldering", postcode: "3000", category: "electronics", themes: ["retro-computing"], status: "done",
    update: "Finished the recap this weekend. Picture is sharp and the SID no longer hums. Next time I would socket the chips first." },
  { owner: "example_priya", title: "Sydney repair-cafe toolkit", summary: "Putting together a shared, portable toolkit for a monthly repair cafe in Sydney.",
    body: "We keep borrowing screwdrivers. Plan: two crates with a good multimeter, soldering station, bit set and spare fuses, plus a laminated triage sheet. Need people to help source and test tools.",
    skills: "electronics repair", postcode: "2000", category: "repair-cafe", themes: ["repair-and-reuse"], status: "open" },
  { owner: "example_lee", title: "Melbourne cargo bike frame", summary: "Building a long-tail cargo bike frame from steel tube in a shared Melbourne workshop.",
    body: "Aiming for a frame that carries two kids or a week of shopping. Designing the jig first, then brazing. Looking for someone with a fillet-brazing background to check my joints.",
    skills: "brazing, bike building", postcode: "3000", category: "bikes", themes: ["open-hardware"], status: "open" },
];
const projId = new Map<string, number>();
for (const p of PROJECTS) {
  const c = as(p.owner);
  const fields = { title: p.title, summary: p.summary, body: p.body, skills: p.skills, postcode: p.postcode, category: p.category, themes: p.themes, pledge: "1" };
  const id = Number((await c.post("/projects/new", fields, "/projects/new", /^\/projects\/\d+/, `create ${p.title}`)).match(/\d+/)![0]);
  projId.set(p.title, id);
  const edit = (status: string) => c.post(`/projects/${id}/edit`, { ...fields, status, recruiting: status === "done" ? "" : "1" }, `/projects/${id}/edit`, new RegExp(`^/projects/${id}$`), `edit ${id} -> ${status}`);
  if (p.status !== "open") await edit("in_progress");
  if (p.update) await c.post(`/projects/${id}/updates`, { body: p.update, pledge: "1" }, `/projects/${id}`, /^\/projects\/\d+/, `update ${id}`);
  if (p.status === "done") await edit("done");
  console.log(`project ${id}: ${p.title} (${p.status})`);
}

const QUESTIONS = [
  { by: "example_sam", title: "How do I stop a drill press quill from sticking?", body: "The quill on my old drill press moves stiffly and catches halfway down. Spring feels fine. Is this rust, dried grease, or a worn bush? What would you try first?",
    skills: "machining", answers: [["example_jo", "Pull the quill out and look first. Dried grease and a little rust is the usual cause. Clean with kero, polish the bore lightly with fine wet and dry, then use a thin machine oil."], ["example_lee", "Check the spring tension nut too. Over-tightening it makes the quill bind near the bottom of its travel."]], accept: 0 },
  { by: "example_priya", title: "Which multimeter is good enough for a repair cafe?", body: "We need a few meters that survive being dropped and borrowed. Budget is about $60 each. Does auto-ranging matter, and should we worry about CAT ratings for mains appliances?",
    skills: "electronics repair", answers: [["example_sam", "Get auto-ranging with a continuity beeper and a CAT III rating. Spend a bit more on decent leads, they fail first."]], accept: 0 },
  { by: "example_lee", title: "Best way to align a bike frame before brazing?", body: "I have a flat table and a few off-cuts of angle iron. Is that enough to hold a frame true while brazing, or do I need a proper jig? Distortion from heat worries me.",
    skills: "brazing", answers: [["example_priya", "Tack everything first and measure diagonals before the full braze. A flat table works if you clamp to it."], ["example_jo", "Rotate the braze order so the heat spreads evenly, and re-check alignment after each joint."]], accept: -1 },
];
for (const q of QUESTIONS) {
  const qid = Number((await as(q.by).post("/questions/new", { title: q.title, body: q.body, skills: q.skills, pledge: "1" }, "/questions/new", /^\/questions\/\d+/, `ask ${q.title}`)).match(/\d+/)![0]);
  let first: string | null = null;
  for (const [h, body] of q.answers) {
    const loc = await as(h).post(`/questions/${qid}/answers`, { body, pledge: "1" }, `/questions/${qid}`, /^\/questions\/\d+/, `answer ${qid}`);
    first ??= loc;
  }
  if (q.accept >= 0) {
    const html = await (await as(q.by).req(`/questions/${qid}`)).text();
    const aid = html.match(/id="answer-(\d+)"/)?.[1];
    if (!aid) throw new Error(`no answer id on question ${qid}`);
    await as(q.by).post(`/questions/${qid}/accept/${aid}`, {}, `/questions/${qid}`, /^\/questions\/\d+/, `accept ${qid}`);
  }
  console.log(`question ${qid}: ${q.title}`);
}

for (const h of ["example_jo", "example_sam"]) {
  await as(h).post("/lobbies/rocketry/canberra/join", { skills: "general building" }, "/c/rocketry", /^\/(c\/rocketry|projects\/\d+)/, `lobby ${h}`);
  console.log(`${h} joined rocketry/canberra`);
}

console.log(`Done. Example account password for this run (not saved anywhere): ${PASSWORD}`);
