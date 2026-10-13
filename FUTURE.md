# Future work

Ideas worth keeping that aren't being built yet. Add one whenever it comes up,
while developing or while looking at other sites. Say where it came from and
why it might be worth doing. Nothing here is a commitment.

## Workshops and classes

Members post an in-person workshop or class: what skill, when, where (by
postcode, like projects), and how many places. Others RSVP. Running one earns a
teaching award on the teacher's profile.

- **Source:** the owner's note on profile awards, 2026-10-05, which mentioned
  teaching classes. There's no feature for it yet.
- **Why:** it moves the site from "find a collaborator" to "learn from someone
  near you", which is the most direct form of human cognitive engagement the
  site could offer.

## Written commendations from project owners

A project owner gives a teammate a short commendation in their own words
("taught me to TIG weld"), shown on the teammate's profile beside the automatic
awards.

- **Source:** an option weighed and set aside on 2026-10-05, when awards were
  settled as earned from activity only.
- **Why:** a commendation is human-written recognition, which fits the site's
  philosophy. It needs rules first, such as one per teammate per project and
  only after the project is done, so it can't turn into a popularity contest.

## Follow a project

Members follow a project and see its new updates in a personal feed.

- **Source:** Hackaday.io's project pages, seen during the 2026-10-05 prior-art
  search.
- **Why:** progress updates are the inspiration half of the site, and a follow
  is a low-effort way to keep people coming back to a build.

## Pin projects to a profile

People choose one to three projects to sit at the top of their profile, so it
opens with the work they're proudest of rather than the most recent.

- **Source:** suggested by the worker that built profiles and awards,
  2026-10-05.
- **Why:** profiles have no photos, so what someone has made is their face. It
  should be their pick.

## Search projects and questions

Full-text search with SQLite's built-in FTS5 index, so no new dependency.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** people would find an existing answer before asking again, which
  fits a site that values working things out.

## Tool and workshop sharing

Members list tools or workshop access by region, for example "lathe available
in Belconnen, weekends".

- **Source:** recommended in planning, 2026-10-05.
- **Why:** it's very local and very DIY, and it lowers the barrier for people
  who have ideas but no garage.

## Team meetups

A team proposes a time and place, and members RSVP. The safety advice appears
at the point of planning.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** meeting in person is where the 18+ rule and the "parents may
  accompany kids" policy actually matter.

## Download or delete my data

A privacy page, plus a way to export or delete your own posts and the
behaviour signals the site keeps about them.

- **Source:** recommended in planning, 2026-10-05.
- **Why:** the honest counterpart to collecting provenance signals, and a
  strong point in the "good" argument.

## Instruments dashboard

An admin health page showing live connection counts, slow requests and
errors, database and volume size against the 256 MB machine, and trends in
the honesty signals.

- **Source:** recommended in planning, 2026-10-05, with crit 10 ("Fly by
  instruments") in mind.
- **Why:** you can't fly a live app blind. It also gives spec checks for
  real-time latency and persistence something to protect.

## Leaving a team, and handing over leadership

Members of a lobby-formed team can leave it, and a leader can hand leadership
to another member directly instead of waiting for votes to shift.

- **Source:** suggested by the worker that built lobbies, 2026-10-05.
- **Why:** teams formed by strangers will sometimes not gel. A graceful way
  out stops dead teams piling up with a leader who has wandered off.

## Block-aware lobbies

When a lobby forms a team, skip pairing two people where one has blocked the
other, and hold the later joiner for the next team.

- **Source:** a known limitation flagged by the worker that built report and
  block, 2026-10-05.
- **Why:** today a blocked pair can still end up on the same team, which
  undercuts what blocking is for.

## Report status for reporters

People who filed a report can see whether it was resolved. They see the
outcome only, not admin notes.

- **Source:** suggested by the worker that built report and block, 2026-10-05.
- **Why:** a report that disappears into silence teaches people not to bother
  reporting.

## Sandbox ideas (from M1)

- Upload only `dirty_rects` once the sim reports them (now a full 512x512 upload per frame); from M1 client work, worth doing when the game world is 2048x1536.
- Expose `matView()`/`auxView()` on `shared/sim.ts` so the client does not capture wasm exports; from the M1 worker.
- A pause/step/clear control in the sandbox; from watching long gunpowder chains.

## Show catch-up as a real progress bar, and replay faster (from M2a)

Late join replays the whole log at roughly 200-400 ticks/s on a laptop (about 5 s for 1300 ticks), shown only as a percentage in the header. Snapshots will cut this, but a visible bar plus rendering every Nth tick during fast-forward would make the wait feel shorter on phones.

## Adaptive J from measured jitter (from M2a)

J is a constant 2. The plan says adapted to jitter; the client already sees tick arrival times, so a rolling p95 of inter-arrival gaps could set J between 2 and 6.

## From M2b (persistence and snapshots)

- **Snapshot the last player out.** The server could ask the departing client for a snapshot on a clean close (the socket's `close` event arrives after the tab is gone, so it needs a `beforeunload` hint or a heartbeat-driven "you're the last, upload now" push). Source: D-042. Worth it if cold-start replay of ~30 s is noticeable.
- **CHUNK_HASHES diff for desync incidents.** Keep the last 5 chunk-hash arrays on the client and diff on request, so an incident names the diverging chunks. Source: D-043.
- **Server-side check of snapshot "reasonableness".** The majority-hash rule trusts that the majority's sim is right; a periodic deliberate-lie client in CI could run the bad-snapshot test against the deployed build.
- **Per-player upload budget for SNAPSHOT_UPLOAD.** Unsolicited uploads are ignored cheaply, but a solicited client can upload once per request at up to 1 MiB; fine for co-op, worth rate-limiting if the URL is public.

## From M3 (world generation, sleeping, camera)

- **Generator preview page.** A dev route that regenerates the world for a seed typed in and shows the whole-world overview, with a "reachable cells" and "pool count" readout. Came from iterating on parameters by dumping PNGs; a live slider panel would make tuning the caves minutes instead of an hour. Also a cheap way to pick a nice default seed.
- **Biome bands by depth.** Noita has distinct biomes by depth with their own rock colours and materials. A per-band tint of Rock (shallow brown, deep blue-black) and different cave shapes (shallow winding, deep open) costs little in the generator and the shader and makes depth legible without a HUD.
- **Stalactites and moss.** The research checklist marks them as Noita look-and-feel (unverified). A cosmetic post-pass in the shader (hash-based drips under ceilings, green tint on wet floors) needs no sim change.
- **Wake by activity heat map.** The dev stats line shows chunks run; drawing the awake chunks as an overlay would make sleeping bugs visible at a glance, the same way the overview made generation bugs visible.
- **Generation in a worker thread at join time.** About 400 ms of wasm generation blocks the worker at join and on every resync. Fine now; once resyncs are routine, restoring from a snapshot could skip generation for chunks that are already stored (but the sim must regenerate for pristine ones).
