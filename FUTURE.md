# Future work

Ideas worth keeping that aren't being built yet. Add one whenever it comes up,
while developing or while looking at other sites. Say where it came from and
why it might be worth doing. Nothing here is a commitment.

## Snapshot from a client mid-replay

Let a client that is still catching up upload a snapshot at an already-closed
tick, checked against the hash the server recorded for that tick.

- **Source:** `docs/research/snapshot-timing.md` fix (h), 2026-10-18.
- **Why:** the first visitor after a long gap could shrink the log without
  having to stay until they are fully live. It needs old hashes kept longer than
  today's 30 checkpoints.

## Dashboard history across restarts

Write per-minute aggregates to plan 9.1's `metrics_minutely` table, and draw
the last hour or day on `/dashboard` (players online, hash failures, RSS).

- **Source:** crit 10 dashboard work, 2026-10-18. Today everything is in memory,
  and Fly stops the machine when idle, so the dashboard only ever shows the
  current run.
- **Why:** a reader of the logs after the crit could see the session as a
  whole, not just whatever happened since the last cold start.

## Which chunk diverged (done, D-126)

Build REQUEST_CHUNK_HASHES/CHUNK_HASHES (deferred in D-043), so a desync
incident records the first diverging chunk, and show it on the admin dashboard.

- **Source:** the desync row in the crit 10 event catalogue, 2026-10-18.
- **Why:** a `desync` event today says who diverged but not where, which leaves
  a determinism bug with nothing to replay against.

## A player page (done, D-125)

A per-player admin view: sessions, play time, casts by spell, deepest point,
resyncs. Later, achievements.

- **Source:** `player_stats` (D-091) collects all of it already, 2026-10-18.
- **Why:** it is the obvious reader of those counters, and M6 achievements
  need somewhere to show up.

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

## ~~Show catch-up as a real progress bar, and replay faster (from M2a)~~ (done: D-127; replay is not faster, only visible)

Late join replays the whole log at roughly 200-400 ticks/s on a laptop (about 5 s for 1300 ticks), shown only as a percentage in the header. Snapshots will cut this, but a visible bar plus rendering every Nth tick during fast-forward would make the wait feel shorter on phones.

## Adaptive J from measured jitter (from M2a)

J is a constant 2. The plan says adapted to jitter; the client already sees tick arrival times, so a rolling p95 of inter-arrival gaps could set J between 2 and 6.

## From M2b (persistence and snapshots)

- **Snapshot the last player out.** The server could ask the departing client for a snapshot on a clean close (the socket's `close` event arrives after the tab is gone, so it needs a `beforeunload` hint or a heartbeat-driven "you're the last, upload now" push). Source: D-042. Worth it if cold-start replay of ~30 s is noticeable.
- ~~**CHUNK_HASHES diff for desync incidents.** (done: D-126)~~ Keep the last 5 chunk-hash arrays on the client and diff on request, so an incident names the diverging chunks. Source: D-043.
- **Server-side check of snapshot "reasonableness".** The majority-hash rule trusts that the majority's sim is right; a periodic deliberate-lie client in CI could run the bad-snapshot test against the deployed build.
- **Per-player upload budget for SNAPSHOT_UPLOAD.** Unsolicited uploads are ignored cheaply, but a solicited client can upload once per request at up to 1 MiB; fine for co-op, worth rate-limiting if the URL is public.

## From M3 (world generation, sleeping, camera)

- ~~**Generator preview page.** (done in part: D-124, `client/gen-preview.html` with a readout; no slider panel yet)~~ A dev route that regenerates the world for a seed typed in and shows the whole-world overview, with a "reachable cells" and "pool count" readout. Came from iterating on parameters by dumping PNGs; a live slider panel would make tuning the caves minutes instead of an hour. Also a cheap way to pick a nice default seed.
- **Biome bands by depth.** (Rock tint done, D-124; the cave-shape half is not: shallow winding, deep open, a sim change needing the full determinism suite and the D-086 pickup counts.) Noita has distinct biomes by depth with their own rock colours and materials. A per-band tint of Rock (shallow brown, deep blue-black) and different cave shapes (shallow winding, deep open) costs little in the generator and the shader and makes depth legible without a HUD.
- **Stalactites and moss.** (Moss near water done, D-124; drips under ceilings not.) The research checklist marks them as Noita look-and-feel (unverified). A cosmetic post-pass in the shader (hash-based drips under ceilings, green tint on wet floors) needs no sim change.
- **Wake by activity heat map.** The dev stats line shows chunks run; drawing the awake chunks as an overlay would make sleeping bugs visible at a glance, the same way the overview made generation bugs visible.
- **Generation in a worker thread at join time.** About 400 ms of wasm generation blocks the worker at join and on every resync. Fine now; once resyncs are routine, restoring from a snapshot could skip generation for chunks that are already stored (but the sim must regenerate for pristine ones).

## From M4a (players, identity, two worlds)

- **Server-side respawn allowance for Pos validation.** The server cannot see `Respawn`, so after M5 a teleport to the surface looks like a jump. Let the server read `Death` claims (or just widen the limit for a few ticks after one) so honest respawns are never rejected. Source: D-067.
- **Cache the generated base world per (seed, kind).** Restore and `init` each regenerate (about 400 ms); the verify worker pays it on every upload and a joining client pays it twice. A 3 MB memcpy of the pristine `mat` removes both. Source: review-m3 S2, still open.
- ~~**A "who is online" list and a share-a-spot link.** The labels already know every active player; a side list with a "jump camera here" click is the spectate feature phones need (D-011) and helps markers find the second profile. (done: D-123; the share-a-spot link is not built)~~
- ~~**Name tags that fade with distance, and a tiny minimap.** The world is 2048 wide and the view 480; two players can be many screens apart and never know. A strip along the top with a dot per player costs one DOM element each. (done: D-123)~~
- **Walking animation for the figures.** `pushFigure` is a static placeholder; leg swing and a lean while levitating need only the avatar's velocity, which the worker already has (todo: character animation).

## Aim assist and a visible cone for Blast

Draw a faint arc at Blast's reach while its key is selected, and a dotted line
for Push's first few cells.

- **Source:** building the M4b spell bar: Blast's 24-cell cone is invisible until it fires.
- **Why:** players learn range by feel otherwise; the preview is renderer-only and costs nothing in the sim.

## Interpolated cast ghosts for other players

Show a faint ghost for another player's bolt for the round trip, from their Cast
input as it reaches the server, not only for your own.

- **Source:** the cast-preview work in M4b, where only the caster's own ghost hides the lockstep delay.
- **Why:** other players see a bolt appear mid-air a round trip late; an early hint would smooth it. It needs the server to relay Cast before the tick closes, which touches the protocol.

## Bag fade-out and per-bag lifetime (from M5 slice 4)

Bags expire after 90 s but the view carries no `expires_at`, so the client cannot blink or fade a bag that is about to vanish. Adding the expiry tick to `ENT_BAG` would let the sprite flash in its last 10 s. Also worth doing: a spell-coloured breakdown of a bag's contents on hover, instead of only the total.

## Arena extras: rounds, king of the hill, capture the bag

Timed arena rounds with a round-end scoreboard; a marked hill zone that scores points per second held (a sim-side counter); a capture-the-bag variant built on dropped bags.

- **Source:** the game-modes research (`docs/research/game-modes-design.md`), from .io games, Minecraft minigame servers and Worms.
- **Why:** a fighting mode needs a loop and a reason to move. These are out of scope for the free-for-all arena (plan U3) but are the obvious next step.

## Private arena rooms and a per-player PvP toggle

Room codes that spin up a fresh arena world per group, and a Terraria-style visible PvP flag inside shared worlds.

- **Source:** the game-modes research, Terraria and Entangled Worlds.
- **Why:** friends could fight without strangers. The server can carry extra 1024x768 worlds (`docs/research/game-modes-capacity.md`), but lazy load and unload of empty worlds would have to be built first.

## Share a creative build

Export a region of the creative world as a PNG or a link (a Sandspiel-style gallery).

- **Source:** the game-modes research, from Sandspiel.
- **Why:** gives creative play an outcome to show off; rendering only, no sim change.

## Dig preview and depth-scaled digging

Show Blast's dig disc in the aim preview, and make digging slower in deep bands or in harder materials.

- **Source:** the Blast-dig worker (21 Oct night), building R1's starting dig.
- **Why:** players can't see where the 4-cell disc lands (6 cells along the aim); slower deep digging keeps Bomb worth finding.

## Cheaper empty ticks

Coalesce or compress tick frames per member; empty ticks cost about 420 B/s per member for nothing.

- **Source:** the capacity measurement (`docs/research/capacity-rooms.md`).
- **Why:** member count and CPU bind capacity, and a Fly machine may start with only a 5 s burst balance.

## Natural-looking traversal: backbone worms instead of repair shafts

Gen v2's box-fit repair carves near-vertical radius-6 shafts that read as pipes (`docs/art/shots/gen-v2-seed8-2026-10-21.png`, the shaft near x=380). A wandering minimum-radius backbone worm per entrance (cave-gen-v2 step 2, skipped because the repair alone passed) would make the guaranteed path look like a cave. Also check pickup reachability in the repair. (The traversal test keeps its own copy of the box-fit flood on purpose: an independent check cannot share a bug with `gen::box_reach`.)

- **Source:** reviewing the gen v2 worker's output and the preview of seed 8.
- **Why:** the repair is a correctness backstop; the look of the caves is what players see.

## One shared byte-vector file for the config encoders

The config round-trip vectors are hard-coded twice (`sim/tests/config.rs`, `tests/net/room.test.ts`). A single `tests/fixtures/room-vectors.json` that both read (the Rust side with the script.rs mini-parser) would make drift impossible rather than merely tested. Not done in R0a because the brief allowed either and the table is 3 vectors plus a mutation list.

- **Source:** R0a worker, while writing the round-trip test.
- **Why:** R1 and R2 add fields and presets; a third copy is where the encoders would quietly diverge.

## Property test: decode never accepts what encode cannot produce

Fuzz random 16-byte arrays through `RoomConfig::decode` and `decodeConfig` and assert they agree, and that every accepted config re-encodes to the same bytes. Catches a range off by one in either language.

- **Source:** R0a worker.
- **Why:** the server validates in TS and the sim in Rust; they must refuse exactly the same configs or a room could be created that no client can init.
