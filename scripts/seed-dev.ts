#!/usr/bin/env node
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { deflate } from "node:zlib";
import { promisify } from "node:util";

const deflateAsync = promisify(deflate);

const APP_URL = process.env.APP_URL || "http://localhost:8080";
const { hostname } = new URL(APP_URL);

if (hostname !== "localhost" && hostname !== "127.0.0.1") {
  console.error(
    `SAFETY GUARD: APP_URL host must be localhost or 127.0.0.1, got "${hostname}". This script must never run against production.`
  );
  process.exit(1);
}

const baseUrl = new URL(APP_URL);

function url(p: string) {
  return new URL(p, baseUrl);
}

const run = Date.now().toString(36);

function client() {
  const jar = new Map<string, string>();

  async function req(
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (jar.size)
      headers.set(
        "cookie",
        [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
      );
    const res = await fetch(url(path), {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const [k, v] = [
        kv.slice(0, kv.indexOf("=")),
        kv.slice(kv.indexOf("=") + 1),
      ];
      if (v === "" || attrs.some((a) => /max-age=0/i.test(a)))
        jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    return res;
  }

  async function csrf(path: string): Promise<string> {
    const m = (await (await req(path)).text()).match(
      /name="_csrf" value="([0-9a-f]+)"/
    );
    if (!m) throw new Error(`no csrf field on ${path}`);
    return m[1];
  }

  async function post(
    path: string,
    fields: Record<string, string>,
    formPage = path
  ) {
    const body = new URLSearchParams(fields);
    body.set("_csrf", await csrf(formPage));
    return req(path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
    });
  }

  async function upload(
    path: string,
    text: string,
    files: { name: string; type: string; data: Uint8Array }[],
    formPage: string,
    pledge = true
  ) {
    const fd = new FormData();
    fd.set("_csrf", await csrf(formPage));
    fd.set("body", text);
    if (pledge) fd.set("pledge", "1");
    for (const f of files)
      fd.append(
        "photos",
        new File([f.data as BlobPart], f.name, { type: f.type })
      );
    return req(path, { method: "POST", body: fd });
  }

  return { req, post, upload };
}

/** Throw (with the response body) unless the response is a redirect, optionally to a path matching `loc`. */
async function expectRedirect(res: Response, what: string, loc?: RegExp) {
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || (loc && !loc.test(location))) {
    const body = (await res.text()).slice(0, 2000);
    throw new Error(
      `${what}: expected 302${loc ? ` to ${loc}` : ""}, got ${res.status} location=${location || "(none)"}\n${body}`
    );
  }
  return location;
}

function makeProvenance(textLength: number) {
  return {
    prov_typed: String(Math.floor(textLength * 0.7)),
    prov_pasted_prose: "0",
    prov_active_ms: String(Math.floor(textLength * 250)),
    prov_paste_events: "0",
    prov_deletions: String(Math.floor(textLength * 0.05)),
  };
}

// Generate a minimal PNG using CRC32
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crc ^ data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeBE32(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

async function generatePNG(
  width: number,
  height: number,
  colorFunc: (x: number, y: number) => [number, number, number]
): Promise<Uint8Array> {
  // Create IHDR chunk
  const ihdr = new Uint8Array(13);
  writeBE32(ihdr, 0, width);
  writeBE32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrCrc = crc32(
    new Uint8Array([...new TextEncoder().encode("IHDR"), ...ihdr])
  );

  // Create IDAT (image data)
  const pixelData: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    pixelData.push(new Uint8Array([0])); // filter byte
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorFunc(x, y);
      pixelData.push(new Uint8Array([r, g, b]));
    }
  }

  const allPixels = new Uint8Array(
    pixelData.reduce((acc, val) => acc + val.length, 0)
  );
  let offset = 0;
  for (const p of pixelData) {
    allPixels.set(p, offset);
    offset += p.length;
  }

  const compressed = await deflateAsync(allPixels);
  const idatCrc = crc32(
    new Uint8Array([...new TextEncoder().encode("IDAT"), ...compressed])
  );

  // Create IEND chunk
  const iendCrc = crc32(new TextEncoder().encode("IEND"));

  // Assemble PNG
  const png: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  ];

  // IHDR chunk
  const ihdrChunk = new Uint8Array(4 + 4 + 13 + 4);
  writeBE32(ihdrChunk, 0, 13);
  ihdrChunk.set(new TextEncoder().encode("IHDR"), 4);
  ihdrChunk.set(ihdr, 8);
  writeBE32(ihdrChunk, 8 + 13, ihdrCrc);
  png.push(ihdrChunk);

  // IDAT chunk
  const idatChunk = new Uint8Array(4 + 4 + compressed.length + 4);
  writeBE32(idatChunk, 0, compressed.length);
  idatChunk.set(new TextEncoder().encode("IDAT"), 4);
  idatChunk.set(compressed, 8);
  writeBE32(idatChunk, 8 + compressed.length, idatCrc);
  png.push(idatChunk);

  // IEND chunk
  const iendChunk = new Uint8Array(4 + 4 + 0 + 4);
  writeBE32(iendChunk, 0, 0);
  iendChunk.set(new TextEncoder().encode("IEND"), 4);
  writeBE32(iendChunk, 8, iendCrc);
  png.push(iendChunk);

  const result = new Uint8Array(png.reduce((acc, val) => acc + val.length, 0));
  let pos = 0;
  for (const p of png) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

const passwords = "devpassword123";

const handles = [
  "sparky_jo",
  "bench_dave",
  "weld_sam",
  "etch_maya",
  "crank_lee",
  "solder_pat",
  "drill_chris",
  "paint_alex",
  "solder_bee",
  "radio_kim",
  "repairbot_max",
  "maker_taylor",
];

const postcodes = [
  "2600", // Canberra
  "2602", // Canberra
  "2604", // Canberra
  "2612", // Canberra
  "2614", // Canberra
  "2617", // Canberra
  "2900", // Queanbeyan
  "2905", // Regional NSW
  "2000", // Sydney
  "3000", // Melbourne
  "4000", // Brisbane
  "7000", // Hobart
];

const skills = [
  "Arduino",
  "Welding",
  "Soldering",
  "CNC",
  "3D printing",
  "Electronics",
  "Woodwork",
  "Metalwork",
  "Ham radio",
  "LoRa",
  "Python",
  "Rust",
  "PCB design",
  "Carpentry",
];

async function signUp(handle: string, postcode: string): Promise<ReturnType<typeof client>> {
  const c = client();
  const res = await c.post("/signup", {
    handle,
    password: passwords,
    dob: "1990-01-01",
    safety_ok: "1",
    postcode,
  });
  if (res.status === 409) {
    throw new Error("already-seeded");
  }
  if (res.status !== 302) {
    throw new Error(`signup failed for ${handle}: ${res.status}`);
  }
  return c;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface User {
  handle: string;
  client: ReturnType<typeof client>;
  id?: number;
}

interface Project {
  id: number;
  ownerId: number;
  title: string;
  summary: string;
  body: string;
  skills: string;
  postcode: string;
  status: string;
  recruiting: boolean;
}

async function main() {
  console.log(`Seeding ${APP_URL}...`);

  // 1. Sign up 12 users
  const users: User[] = [];
  for (const handle of handles) {
    const postcode = postcodes[users.length % postcodes.length]!;
    try {
      const client = await signUp(handle, postcode);
      users.push({ handle, client });
      console.log(`✓ User ${handle}`);
    } catch (e) {
      if ((e as Error).message === "already-seeded") {
        console.log("Already seeded, exiting");
        process.exit(0);
      }
      throw e;
    }
  }

  // 2. Fill in profiles
  for (const user of users) {
    const displayName =
      user.handle.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
    const userSkills = shuffle(skills)
      .slice(0, 3 + Math.floor(Math.random() * 4))
      .join(", ");
    const background =
      [
        "Electronics enthusiast, tinkering since high school.",
        "Woodworker by hobby, looking to expand into metalwork.",
        "Professional electrician, building rigs on weekends.",
        "Self-taught maker, love welding and Arduino projects.",
        "Robotics student, passionate about hands-on work.",
      ][Math.floor(Math.random() * 5)] || "";
    const interests =
      [
        "DIY electronics, ham radio, home automation.",
        "Restoring old tools and machines.",
        "Building workshop gadgets, 3D printing.",
        "CNC work, woodworking, Arduino.",
        "Soldering, PCB design, bike restoration.",
      ][Math.floor(Math.random() * 5)] || "";

    const textLength = background.length + interests.length;
    const prov = makeProvenance(textLength);
    await expectRedirect(
      await user.client.post("/me", {
        display_name: displayName,
        background,
        interests,
        skills: userSkills,
        postcode: postcodes[users.indexOf(user)]!,
        pledge: "1",
        ...prov,
      }),
      `profile ${user.handle}`
    );
    console.log(`✓ Profile ${user.handle}`);
  }

  // 3. Create 18 projects
  const projects: Project[] = [];
  const projectTitles = [
    "Arduino greenhouse watering rig",
    "1970s drill press restoration",
    "Community LoRa weather station",
    "Cargo bike frame build",
    "CNC router from scrap",
    "Backyard pizza oven",
    "Ham radio repeater setup",
    "Tube amp restoration kit",
    "Electric bike conversion",
    "Wooden workbench design",
    "Home automation solar rig",
    "Laser cutter from parts",
    "Vintage radio restoration",
    "3D printer upgrade frame",
    "Welded steel shelving system",
    "DIY PCB etching lab",
    "Bike trailer build",
    "Workshop dust collector",
  ];

  for (let i = 0; i < 18; i++) {
    const owner = users[i % users.length]!;
    const title = projectTitles[i]!;
    const summary = [
      "Automate garden watering with Arduino sensors.",
      "Restore a classic workshop machine.",
      "Build a distributed weather monitoring network.",
      "Design and build a cargo carrier frame.",
      "Salvage parts to create a CNC router.",
      "Construct an outdoor wood-fired oven.",
      "Extend radio range with a community repeater.",
      "Revive a vintage tube amplifier.",
      "Convert a regular bike to electric.",
      "Design a sturdy woodworking bench.",
      "Combine solar and home automation.",
      "Assemble a laser cutter from components.",
      "Repair and upgrade old radio equipment.",
      "Upgrade printer mechanics and printing area.",
      "Create modular welded storage.",
      "Set up DIY PCB etching facilities.",
      "Build a practical bike towing system.",
      "Create efficient workshop dust removal.",
    ][i]!;

    const body = [
      "Need help with sensor calibration and app development. Water plants automatically based on soil moisture. Already have Arduino and sensors, need guidance on coding the logic.",
      "Found a Bridgeport mill at an estate sale. Main spindle works but table needs work. Looking for experts on mechanical restoration and recalibration.",
      "Placing LoRa nodes around the city to collect weather data. Each node costs about $30 to build. Want distributed humidity, temperature, and pressure readings.",
      "Building from angle iron and old bike parts. Need welding help and frame design expertise. Aiming for 30kg cargo capacity.",
      "Sourcing stepper motors, linear rails, and aluminum extrusion. Planning 600x400mm cutting area. Need CAD help and firmware flashing skills.",
      "Laying bricks and building a firewood storage area first. Using refractory materials inside. Looking for advice on chimney sizing and heat distribution.",
      "Setting up dual VHF/UHF system in town. Need antenna design, repeater programming, and regulatory compliance knowledge.",
      "Chassis is solid, need capacitor replacement and output transformer testing. Some valves working, others need sourcing.",
      "Have a steel frame bike and hub motor. Need to integrate battery, controller, and wiring. Safety testing required.",
      "Want a sturdy bench with storage. Planning 1.5m top surface. Have wood but need layout and joinery advice.",
      "Installing 6kW solar array with battery storage and home automation hub. Integrating with existing circuits.",
      "Found most components online. Need to align mirrors, tune resonator, and build the water cooling system.",
      "Have several vintage radios needing restoration. Tubes need replacing, capacitors are aging. Want to preserve original functionality.",
      "Planning larger nozzle, better cooling, and stronger extruder. Upgrading heated bed and adding auto-leveling.",
      "Making compact shelving unit. Welding beams and painting. About 2m x 1m per shelf, multiple tiers.",
      "Got an old laminator and UV box. Setting up etch tank and mixing ferric chloride. Need process refinement.",
      "Designing for cargo and kids. Steel frame, pneumatic tires, and simple steering.",
      "Building ductwork and installing a multi-stage filter. Goal is keeping shop air clean while working.",
    ][i]!;

    const skillsNeeded = shuffle(skills)
      .slice(0, 2 + Math.floor(Math.random() * 3))
      .join(", ");
    const projectPostcode = postcodes[i % postcodes.length]!;

    const textLength = summary.length + body.length;
    const prov = makeProvenance(textLength);

    const res = await owner.client.post("/projects/new", {
      title,
      summary,
      body,
      skills: skillsNeeded,
      postcode: projectPostcode,
      category: "other",
      pledge: "1",
      ...prov,
    });
    const loc = await expectRedirect(res, `create project "${title}"`, /^\/projects\/\d+$/);
    const pid = Number(loc.split("/")[2]);
    projects.push({
      id: pid,
      ownerId: users.indexOf(owner),
      title,
      summary,
      body,
      skills: skillsNeeded,
      postcode: projectPostcode,
      status: "open",
      recruiting: true,
    });
    console.log(`✓ Project ${pid}: ${title}`);
  }

  // 4. Update project statuses
  // ~9 open/recruiting, 5 in_progress (3 recruiting, 2 not), 3 done, 1 open/not recruiting
  const statusUpdates = [
    { idx: 0, status: "in_progress", recruiting: true },
    { idx: 1, status: "in_progress", recruiting: true },
    { idx: 2, status: "in_progress", recruiting: true },
    { idx: 3, status: "in_progress", recruiting: false },
    { idx: 4, status: "in_progress", recruiting: false },
    { idx: 5, status: "done", recruiting: false },
    { idx: 6, status: "done", recruiting: false },
    { idx: 7, status: "done", recruiting: false },
    { idx: 8, status: "open", recruiting: false },
  ];

  for (const update of statusUpdates) {
    const p = projects[update.idx]!;
    const owner = users[p.ownerId]!;
    const textLength = p.title.length;
    const prov = makeProvenance(textLength);

    // The server only allows open -> in_progress -> done, so step through in_progress.
    const steps = update.status === "done" ? ["in_progress", "done"] : [update.status];
    for (const status of steps) {
      if (status === p.status) continue;
      const last = status === update.status;
      await expectRedirect(
        await owner.client.post(
          `/projects/${p.id}/edit`,
          {
            title: p.title,
            summary: p.summary,
            body: p.body,
            skills: p.skills,
            postcode: p.postcode,
            category: "other",
            status,
            recruiting: last && !update.recruiting ? "" : "1",
            pledge: "1",
            ...prov,
          },
          `/projects/${p.id}/edit`
        ),
        `edit project ${p.id} -> ${status}`,
        new RegExp(`^/projects/${p.id}$`)
      );
      p.status = status;
    }
    p.status = update.status;
    p.recruiting = update.recruiting;
    console.log(`✓ Updated project ${p.id} to ${update.status}`);
  }

  // 5. Create join requests (~15)
  const joinRequests: { projectId: number; userId: number; status: string }[] =
    [];
  for (let i = 0; i < 15; i++) {
    const projectIdx = i % projects.length;
    const project = projects[projectIdx]!;
    if (!project.recruiting) continue; // Only recruit on recruiting projects

    let userIdx = (i + projectIdx + 3) % users.length;
    while (userIdx === project.ownerId) {
      userIdx = (userIdx + 1) % users.length;
    }

    const user = users[userIdx]!;
    const message =
      [
        "I have experience with Arduino. Can help with the sensor integration.",
        "Welding background here, ready to contribute.",
        "I'm familiar with CNC work, count me in.",
        "Interested in learning more, can assist with testing.",
        "Experienced with this type of project, let's collaborate.",
        "I have some spare time this month, can jump in.",
      ][i % 6] || "";

    const res = await user.client.post(
      `/projects/${project.id}/requests`,
      { skill_id: "", message },
      `/projects/${project.id}`
    );

    await expectRedirect(res, `join request ${user.handle} -> ${project.id}`, new RegExp(`^/projects/${project.id}$`));
    {
      joinRequests.push({
        projectId: project.id,
        userId: userIdx,
        status: "pending",
      });
      console.log(
        `✓ Join request ${user.handle} → project ${project.id}`
      );
    }
  }

  // 6. Accept/decline some requests
  // Accept ~8, decline 2
  let acceptCount = 0;
  let declineCount = 0;

  for (const req of shuffle(joinRequests)) {
    const project = projects.find((p) => p.id === req.projectId)!;
    const owner = users[project.ownerId]!;
    const requestsPage = await owner.client.req(
      `/projects/${project.id}/requests`
    );
    const requestsHtml = await requestsPage.text();
    // Pending rows are the ones that carry an accept form.
    const pendingIds = requestsHtml
      .split('<li class="request"')
      .filter((chunk) => chunk.includes("/accept"))
      .map((chunk) => chunk.match(/id="request-(\d+)"/)?.[1])
      .filter((x): x is string => !!x);

    for (const rid of pendingIds) {
      const verb = acceptCount < 8 ? "accept" : declineCount < 2 ? "decline" : null;
      if (!verb) break;
      await expectRedirect(
        await owner.client.post(
          `/projects/${project.id}/requests/${rid}/${verb}`,
          {},
          `/projects/${project.id}/requests`
        ),
        `${verb} request ${rid} on project ${project.id}`,
        new RegExp(`^/projects/${project.id}/requests$`)
      );
      if (verb === "accept") {
        req.status = "accepted";
        acceptCount++;
      } else {
        req.status = "declined";
        declineCount++;
      }
      console.log(`✓ ${verb}ed request ${rid} for project ${project.id}`);
      break;
    }

    if (acceptCount >= 8 && declineCount >= 2) break;
  }

  // 7. Create progress updates (~14) with photos
  const inProgressProjects = projects.filter(
    (p) => p.status === "in_progress" || p.status === "done"
  );

  for (let i = 0; i < 14; i++) {
    const project =
      inProgressProjects[i % inProgressProjects.length]!;
    const owner = users[project.ownerId]!;
    const updates = [
      "Got the first prototype running! Wiring is clean, sensors responding well.",
      "Finished the mechanical setup. Now testing calibration and response times.",
      "Frame is welded and ready. Starting on the electrical connections next.",
      "Successfully etched the first PCB. Soldering components tomorrow.",
      "Assembled most of the drivetrain. Brake alignment still needs work.",
      "Painted and sealed the oven interior. Very pleased with heat distribution.",
      "Radio tower installation done. Signal strength looks good from test sites.",
      "Amp caps replaced and tested. Sound quality is excellent now.",
      "Motor controller is wired in and responding. Battery integration next week.",
      "Finished the top surface. Added a vise and organized storage underneath.",
      "Solar panels mounted. Battery storage system is charged and running.",
      "Mirrors aligned and cutting accurately. Still tweaking the assist air.",
      "Got the first vintage radio fully restored. Sound is beautiful.",
      "New nozzle installed. Printing faster and cleaner than before.",
    ];

    const body = updates[i % updates.length] || "Progress update";
    const textLength = body.length;
    const prov = makeProvenance(textLength);

    // Generate 1-3 photos
    const photoCount = 1 + Math.floor(Math.random() * 3);
    const photos: { name: string; type: string; data: Uint8Array }[] = [];

    const colors = [
      (x: number, y: number) => [
        100 + Math.floor((y / 480) * 150),
        70,
        50,
      ] as [number, number, number],
      (x: number, y: number) => [
        180,
        100 + Math.floor((y / 480) * 75),
        50,
      ] as [number, number, number],
      (x: number, y: number) => [
        200,
        150 + Math.floor((y / 480) * 100),
        80,
      ] as [number, number, number],
    ];

    for (let p = 0; p < photoCount; p++) {
      const colorFunc =
        colors[Math.floor(Math.random() * colors.length)] || colors[0]!;
      const pngData = await generatePNG(
        640,
        480,
        (x, y) => {
          const [r, g, b] = colorFunc(x, y);
          return [
            r + (Math.floor(x / 20) % 2) * 20,
            g,
            b + (Math.floor(y / 30) % 2) * 10,
          ] as [number, number, number];
        }
      );

      photos.push({
        name: `update-${i}-${p}.png`,
        type: "image/png",
        data: pngData,
      });
    }

    const updatePath = `/projects/${project.id}/updates`;
    const res = await owner.client.upload(updatePath, body, photos, `/projects/${project.id}`, true);

    await expectRedirect(res, `progress update on project ${project.id}`);
    console.log(`✓ Update on project ${project.id} with ${photoCount} photo(s)`);
  }

  // 8. Create Q&A (10 questions, ~22 answers)
  const questionTitles = [
    "How do I calibrate Arduino soil sensors?",
    "What's the best way to weld aluminum frames?",
    "CNC spindle makes odd noise, what could it be?",
    "Anyone used LoRa modules in high-rise buildings?",
    "Best flux type for SMD soldering?",
    "How to prevent rust on steel bike frames?",
    "What wattage power supply for my 3D printer upgrade?",
    "Ham radio antenna design for apartment?",
    "How do I restore oxidized aluminum parts?",
    "Where to source quality stepper motors?",
  ];

  const questionBodies = [
    "I have capacitive moisture sensors but the readings vary a lot. Tried calibrating in water and air but still getting drifts. Using Arduino Uno with analog pins.",
    "Trying to TIG weld aluminum for the first time. Keep getting pinholes. My torch settings are at 150A with a cup that seems right.",
    "Been running my old mill for years, but recently noticed a grinding sound during fast spindle speeds. Bearings feel okay. What should I check?",
    "Planning to deploy LoRa nodes on buildings in the CBD. Will the signal degrade too much going through concrete and steel?",
    "Currently using water-soluble flux. Gets sticky after a while. Someone mentioned gel flux but haven't tried it.",
    "Building a cargo bike, wanting to use steel for durability. Don't want to keep repainting every year.",
    "Got a new 400W hot end and upgraded motors. Do I need a bigger PSU than my original 360W?",
    "Living in a 3-floor apartment. Ran a coax up the outside wall. Getting 2-3 km range. Is this normal?",
    "Have some old aluminum heat sinks that have oxidation. Tried wire brushing but it came back. Any permanent solutions?",
    "Cheapest reliable source? I've seen some on eBay but worried about specs not matching.",
  ];

  for (let i = 0; i < 10; i++) {
    const asker = users[i % users.length]!;
    const title = questionTitles[i]!;
    const body = questionBodies[i]!;
    const skillsNeeded = shuffle(skills)
      .slice(0, 2 + Math.floor(Math.random() * 2))
      .join(", ");

    const textLength = title.length + body.length;
    const prov = makeProvenance(textLength);

    const res = await asker.client.post("/questions/new", {
      title,
      body,
      skills: skillsNeeded,
      project: "",
      pledge: "1",
      ...prov,
    });

    await expectRedirect(res, `question "${title}"`, /^\/questions\/\d+/);
    {
      const qid = Number(res.headers.get("location")?.split("/")[2]);
      console.log(`✓ Question ${qid}: ${title}`);

      // Add 2-4 answers per question
      const answerCount = 2 + Math.floor(Math.random() * 3);
      const answerBodies = [
        "Try calibrating in both dry and saturated soil, not just water. Map the raw values first, then apply a cubic polynomial fit.",
        "Sounds like porosity from improper shielding gas flow. Check your argon regulator and clean the nozzle.",
        "Could be spindle bearings wearing out. Have you checked runout with a dial indicator?",
        "LoRa is pretty good at penetrating buildings. I've had nodes working inside concrete structures. Depends on antenna placement.",
        "Gel flux is great for SMD work. Stays put and cleans up way easier. I switched last year.",
        "Stainless steel would be better but more expensive. Mild steel with a good rust converter and paint works fine.",
        "Check the specs of your new motors. They should draw about the same current as the old ones. 360W might be tight.",
        "That sounds normal for an apartment setup. Rubber duck antenna would get you a bit more range if you want.",
        "Anodizing is your permanent fix. Local metal plating shop can do it for reasonable cost.",
        "NEMA17 is pretty standard. AliExpress is cheap but slow. I get mine from the local electronics supplier.",
      ];

      for (let a = 0; a < answerCount; a++) {
        const answerer =
          users[(i + a + 2) % users.length]!;
        const answerBody = answerBodies[a % answerBodies.length] || "";
        const answerTextLength = answerBody.length;
        const answerProv = makeProvenance(answerTextLength);

        const answerRes = await answerer.client.post(
          `/questions/${qid}/answers`,
          {
            body: answerBody,
            pledge: "1",
            ...answerProv,
          }
        );

        await expectRedirect(answerRes, `answer on question ${qid}`);
        {
          console.log(
            `  ✓ Answer by ${answerer.handle} on question ${qid}`
          );

          // Random user marks it as helpful
          if (Math.random() > 0.5) {
            const helperUser = users[Math.floor(Math.random() * users.length)]!;
            const location = answerRes.headers.get("location");
            const aid = location?.split("#")[1]?.replace("answer-", "");
            if (aid) {
              await helperUser.client.post(`/answers/${aid}/helped`, {});
              console.log(
                `    ✓ Marked helpful by ${helperUser.handle}`
              );
            }
          }
        }
      }

      // Asker accepts one answer
      if (Math.random() > 0.5) {
        const qPage = await asker.client.req(`/questions/${qid}`);
        const qHtml = await qPage.text();
        const acceptMatch = qHtml.match(/action="\/questions\/\d+\/accept\/(\d+)"/);
        if (acceptMatch) {
          const aid = acceptMatch[1];
          await asker.client.post(`/questions/${qid}/accept/${aid}`, {});
          console.log(`  ✓ Asker accepted answer ${aid}`);
        }
      }
    }
  }

  console.log("\n=== Seeding Complete ===");
  console.log(`Users created: ${users.length}`);
  console.log(`Projects created: ${projects.length}`);
  console.log(`Join requests created: ${joinRequests.length}`);
  console.log(`Password for all users: ${passwords}`);
  console.log("\nVerify with curl:");
  console.log(`  curl ${APP_URL}/ | grep -i project`);
  console.log(`  curl ${APP_URL}/updates | grep -i project`);
  console.log(`  curl ${APP_URL}/questions | grep -i how`);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
