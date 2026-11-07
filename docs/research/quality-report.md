# Track A (quality): overnight 8-9 Nov report

Opus lead, branch `quality` from `multa` `ab437c0`, worktree `/tmp/wt-quality`. Cap $45 from B0 = $197.47 (week).
Own server: `PORT=8084 DATA_DIR=/tmp/quality-data SIMULTA_DEV_TELEPORT=1`, production build (`pnpm build:client`).

## 1. Playtest (written before any fix)

Played like a user with agent-browser: menu → New game → Survival (S) → name → lobby; a second browser joined by
link, both readied, the round started ("Descend!"); one player teleported (dev teleport) to the boss supply pile and
fought the Sand Colossus with Fire; a Deathmatch room (M) with both players blasting each other; a 390x844 phone
viewport on the menu, a dead room link and a live room; the sandbox with two tabs. Screenshots are in
`docs/research/shots/quality/` (all Read and looked at).

What worked: menu flow, name prompt, room creation, the lobby list and ready count in both tabs
(`05-lobby-a.png`, `07-b-lobby.png`), the countdown and spawn (`08-a-started.png`), boss bar and hotbar pickup slot
(`12-boss-fight.png`), Blast knockback replicated to both clients in Deathmatch (Bob x 480 → 465 in both tabs),
the sandbox stroke in both tabs (`21-sandbox-ab.png`), phone menu and phone spectating (`18-phone-dm.png`).

### Ranked bugs

| # | Severity | Bug | Evidence | Status |
|---|---|---|---|---|
| Q1 | **High** | **The boss supply pile cannot be picked up, in every Survival world.** The alcove is `SUPPLY_ALCOVE_H = 8` rows tall; the avatar is `HITBOX_H = 10`. No body fits inside, so the 4 Fire bolt + 2 Bomb pickups meant for the boss fight are drawn but unreachable on foot (only Dig opens it). This is very likely the user's "spells cannot be picked up". | `10-alcove-zoom.png` (the pile in an 8-row niche, the avatar taller than it); probe `shots/quality/pickup-reach.txt`: 76 of 79 unreachable pickups over 28 worlds are supply-pile ids. The boss-win soak never saw it because `__devGoto` teleports into the rock. | **fixed** `6682ceb`, `92db921` |
| Q2 | Medium | **About 0.4% of cave pickups sit under a ceiling too low for the body.** `pick_spots` checks 8 Empty cells up from the floor cell (9 rows with it); the body needs 10 rows, 5 wide. 3 of 756 pickups (S seed 1 Water, M seed 2 Lava Flask, L PvP seed 3 Water) have rock or ice at row 9-10. Occasional, as the user said. | same probe | **fixed** `6682ceb`, `92db921` |
| Q3 | Medium | **N1: the 4x-throttled client falls behind and never recovers** (open since 7 Nov, bisected to `51524fa`). A phone is about that client. | `docs/research/n1-throttled-regression.md` | **mechanism found, scheduler fixed** `e6c4010`; throttled model still behind (capacity), section 4 |
| Q4 | Low | **The boss is not named before the descent.** The lobby says "the Deep Mage or the Sand Colossus, by seed"; the Join list shows nothing. | `05-lobby-a.png` | **lobby fixed** `e6c4010`; Join card not done |
| Q5 | Low | **A dead room link shows a sandbox page.** `/r/<code>` for a room deleted 2 min after emptying (D-188) shows the title "Game world", a Brush slider and "Fill empty only", and a small orange "No room has that code." line at the bottom. It should say the room has ended and offer the menu. | `17-phone-room.png` (390x844) | ranked, not fixed |
| Q6 | Low | **The hint toast covers the hotbar on first join** ("Move: WASD/arrows...") at 1280x800 and on the phone, over the slots for several seconds. | `05-lobby-a.png`, `18-phone-dm.png` | ranked, not fixed |
| Q7 | Cosmetic | Phone portrait: the world is a thin strip with large empty bands above and below (already Track C's item). | `18-phone-dm.png` | Track C |

Not bugs (checked): Blast does not damage players in Deathmatch, only knocks back (by design, `spells.rs:189`; Fire
and Bomb do the damage). The Survival room vanishing 2 min after both players left is D-188.

## 3. Pickups (Q1, Q2)

**Method.** `/tmp/quality-probe/pickup-reach.ts` (kept out of the repo; output in `shots/quality/pickup-reach.txt`) loads the real `sim.wasm`, generates Survival S
and M (seeds 1-12) and Caves PvP L (seeds 1-4), and for every pickup asks: is there any feet position (1/16 cell) where
the avatar's 5x10 box is free of solids (`client/avatar.ts` `collides`) and the sim's pickup test (`hitbox_cells()` plus
`PICKUP_REACH_BELOW = 2`, `sim/src/sim.rs:506`) covers the pickup cell? 79 of 756 fail: 76 are the supply pile
(ids 11-16 at S, 17-21 at M), 3 are cave spots under a low ceiling.

**Why the supply pile.** `carve_arena` carves the alcove `SUPPLY_ALCOVE_H = 8` rows tall; the body is `HITBOX_H = 10`.
The boss-win soak (`tests/soak/boss-win.ts`) never noticed: `__devGoto` teleports the avatar onto the pickup, into the
rock, and the sim accepts the dev teleport. By eye (`10-alcove-zoom.png`) the pile glows in a slot shorter than the
player. A player who reaches the boss without Dig cannot take the 4 Fire + 2 Bomb meant for the fight, which matches
"the occasional issue where spells cannot be picked up" (it is every Survival world, but only at the boss).

**Fix.** Worker W1 (Sonnet, brief `docs/briefs/quality-w1-pickup-reach.md`, report `quality-w1-report.md`) in
`6682ceb`: `SUPPLY_ALCOVE_H = HITBOX_H + 2` (12), a full-body headroom check in `pick_spots`, and
`sim/tests/pickup_reach.rs` (every pickup of Survival S/M/L seeds 1-6 and Caves PvP L seeds 1-4 has a free 5x10 body
position whose pickup test covers it), red on the unfixed code with 66 unreachable (`/tmp/quality-w1-red.log`), and
snapshot format 17 -> 18 (generation changed; stored worlds reset, as for v14/v17). Its headroom box was one row too
high and centred only, which cost Caves PvP L seed 4 nine of its 25 deep spots, so W1 relaxed
`every_world_gets_its_full_set_of_pickups` to "deep 15..=25". **The lead replaced the check** (`92db921`): some 5x10 box
offset by -2..=2 columns, at the body's own rows (`yf-9..=yf`), must be Empty. That restores the strict (40, 25) on all
12 seeds; `pickup_reach` is still green and goes red (48 unreachable) when the headroom is cut to one row.

**Walk-in check** (Node, the real wasm and the real `client/avatar.ts` controller: Join, ready, walk from 6 cells on
the arena side into the pile with Pos inputs, count `EV_PICKUP`; `shots/quality/walk-pile-new.txt`): Survival S/M/L
seeds 1-4, **old build 24 of 72 pile pickups collected, new build 71 of 72** (S seed 3 got 5/6 in 240 ticks with the
pile on open floor; not chased). In the browser (`24-pile-fixed.png`, `25-near-pile.png`) the pile now sits in a slot
taller than the avatar; a by-hand walk-in failed twice because the boss killed the solo test player first.

## 4. N1: the throttled client (Q3)

**The bisect's next step does not reproduce the CSS story on today's build.** 3-minute soaks (`DURATION_S=180`), logs
`/tmp/quality-n1-*.log`, JSON `/tmp/quality-n1-*.json`:

| Build | Throttled client end | Unthrottled clients end | Non-live samples (unthrottled) |
|---|---|---|---|
| `multa` as is | 6 872 behind | 208, 180 behind | 24, 20 of 36 |
| (a) `pointer-events: none` restored on `#spells` | 7 912 | 128, 172 | 27, 27 |
| (b) `#stage.has-bar` padding removed | 8 748 | 251, 330 | 31, 31 |

Neither property alone helps. At the soak's 1100x700 the canvas is 960x540 with or without the padding (integer
scaling), so (b) never changed the canvas.

**The mechanism, from a focused probe** (`tmp-probe/n1-probe.ts`, uncommitted; one page, the soak's 3x step wrapper,
`Emulation.setCPUThrottlingRate 4`, the worker's `requestAnimationFrame` counted): the worker steps the sim from
`requestAnimationFrame` on its OffscreenCanvas, and that follows the **page's** frame rate. On a 4x-throttled page that
is clicked once a second it ran at **8.7 Hz** (frame gaps 117-150 ms); with three pages in one browser, as in the soak,
**3-4 Hz** (gaps 317-517 ms, measured under some machine load). Every stepping limit in the worker was per frame:

- live: at most `MAX_FRAME_STEPS = 4` from the accumulator plus `MAX_EXTRA = 4` (8 x 7 Hz = 56/s, under the server's
  60), and frame time clamped to 250 ms, so time owed beyond that was dropped;
- catching up: `FF_BUDGET_MS = 12` ms of stepping per frame (at 4x step cost and a few Hz, far under 60/s), so a client
  that fell behind never caught up;
- the avatar controller had the same 4-step cap, so on a slow page you also walked slower than everyone else.

The hotbar commit only pushed the throttled page's frame rate below the line: hiding the bar cut its main-thread long
tasks from 1 951 to 1 080 ms in 20 s, but the worker rAF stayed about 9-10 Hz either way.

**Fix (client only, no sim or protocol change):** `client/lockstep.ts` now owns the step policy: `MAX_FRAME_STEPS = 30`,
`MAX_STEP_DT_MS = 500` (a separate `stepDt` for the sim and avatar accumulators; visual smoothing keeps the 250 ms
clamp) and `ffBudgetMs(dt)` = half the frame, between 12 and 100 ms. The one-row scrolling hotbar is unchanged.
`tests/net/slow-frames.test.ts` models the client in fake time (server 60 ticks/s, 2 ms steps, frames 1/fps apart, the
worker's own policy): red on the old policy (7 fps live, 3 fps live, catch-up from 3000 at 10 fps all fail), red on an
intermediate 12-step/250 ms version (3 fps fails), green on the fix; a fifth case (catch up from 1000 behind at 3 fps
with 8 ms steps) was red on a half-frame/100 ms fast-forward budget and green on 0.8/400.

**Result (3-minute soaks, same seed):**

| Build | Throttled end | Unthrottled end | Unthrottled non-live samples | Rate drops | Pos rejected |
|---|---|---|---|---|---|
| `multa` | 6 872 behind | 208, 180 | 24, 20 of 36 | 0 | 0 |
| fix 12 steps / 250 ms (load from another lead's vitest) | 6 070 | 527, 530 | 19, 20 | 0 | 0 |
| fix 30 / 500 ms / half-frame FF | 4 654 | 39, 82 (live) | 0, 0 | 11 (bot1, Pos bursts) | 0 |
| **committed:** + 0.8-frame FF + one Pos per slow frame | 5 880 | 113, 122 (live) | 1, 1 | 0 | 0 |

So the two normal clients, which before spent half the soak in "catching-up" with their avatars paused, are now
live throughout, with 0 incidents, 0 wire mismatches and the same hash at the final checkpoint. **The 4x-throttled client
still falls behind** at about 32 ticks/s: its step p95 is 12.9 ms (a 4x core plus the harness's 3x busy-wait), so 60
steps/s would need ~780 ms of every second in the worker before decoding, hashing and drawing. That is now a capacity
limit of the model, not the scheduler: the per-frame caps that threw away time are gone. `throttledEndedLive` stays
red. Next step (not done, budget): measure a real phone's step time (the soak's 3x busy-wait may overstate it; the
19 Oct baseline at 38 behind had cheaper steps before biomes and the Colossus), and if it is near the limit, a fresh
snapshot instead of a replay when a client is more than N seconds behind (FUTURE.md's existing idea).
Gate for this commit: `pnpm typecheck` (`/tmp/quality-g1-tsc.log`) and `pnpm test:net` 465/465
(`/tmp/quality-g1-net.log`), commit `e6c4010` chained on both.

## 5. The boss before the descent (Q4)

**Built:** the Survival lobby names this world's boss: "Co-op, one life: descend together and kill the Deep Mage."
The worker reads the boss kind (4 or 7) from the entities view, where the boss exists from generation (tick 0), and
passes it in the lobby message; `bossName` in `client/toasts.ts` turns it into text. Render-only (invariant 9), no sim,
server or protocol change. Seen: `22-lobby-boss.png` (lobby says the Deep Mage) and `23-boss-is-mage.png` (the same
room's boss, after ready and a dev teleport). Tests in `tests/net/toasts.test.ts`: the names (red with the old text),
and every Survival world (S and M, seeds 1-6) shows exactly one boss in `entities()` before any step, both kinds occur.

**Not built: the Join list card.** A room's seed is drawn when the room is first *loaded* (`seedForRoom()` in
`loadRoom`, `server/main.ts:524`), not when it is created, so an unloaded room has no boss yet. A card would need a TS
mirror of `rng()` + `SALT_BOSS_KIND` on the server (pinned against the wasm over many seeds) and the boss only for loaded
rooms, or drawing the seed at creation (a room-lifecycle change). Left as a follow-up; the lobby already tells players
before they descend.

## 6. Not fixed tonight: ready briefs

- **Q5, dead room link (Sonnet, ~$3, client only).** `client/room.ts`: when `GET /api/rooms/:code` returns 404, the
  page falls through to the sandbox layout (title "Game world", brush panel). Instead render a centred panel
  "This room has ended (rooms close 2 minutes after everyone leaves)" with "Join a game" and "New game" buttons (the
  late panel's three-ways-out helper at `room.ts:1018` already has them). Verify at 390x844 and 1280x800 with a
  deleted code; no protocol change.
- **Q6, hint toast over the hotbar (Haiku or Sonnet, ~$1, CSS).** Raise the first-join hint above the bar
  (`bottom` past the 58 px bar padding) or dismiss it on the first key press; check 1280x800 and 390x844.
- **Q4b, boss on the Join card (Sonnet, ~$6).** Either a TS `rng()` mirror + `SALT_BOSS_KIND` in `shared/`
  (pinned against the wasm over 64 seeds) and `boss` in `/api/rooms` for loaded rooms only, or draw the seed at room
  creation (changes D-201's lazy draw; needs the room-seed test). The first is reversible; prefer it.
- **N1 follow-up (Opus or Sonnet, measurement first).** Real-phone step time; then a snapshot fast path for a client
  far behind (FUTURE.md "a fresh snapshot instead of replaying a huge backlog").

## 7. Review

Cold Sonnet review of all four code commits: `docs/research/review-quality.md`. **No blockers.** Checked by the
lead against the code:
- **Should-fix (done, `4ac9de0`):** the slow-frames model spaced frames at `dt` whatever the stepping cost. It now owes
  the real gap since the last frame, as `frame()` does; still red on the old policy (4 of 5 cases), green on the fix.
- Nit, accepted as is: the live path (`ls.run(ls.plan(base))`) has no time budget, so a device with very slow steps
  runs up to 34 steps a frame. That is bounded by real time owed and by the 120-tick switch to the budgeted
  fast-forward, and spending the CPU on stepping is the point; drawing gets less. Worth watching on a real phone.
- Nit, accepted: the keepalive stretches to ~5 s at 3 fps (counts due Pos, not ticks); the server's silence limit is
  10 s and hash replies count as heard.
- Nit, fixed: the `CATCHUP_THRESHOLD` comment order.
- Nit, open: at 12 rows the alcove could open into a cave or liquid above it (`clear_arena` clears liquids only in the
  box). Not seen in any probe world; low confidence.
- Fine (its list): Pos rate stays at most 30/s, the Pos jump bound holds, hidden-tab return, invariants 1 and 9, the
  `pick_spots` index bounds, the alcove vs arena ceiling and `reseal_floor`, format 18 mirrored in `server/db.ts`.

## 8. Gates

| Commit | What | Gate | Logs |
|---|---|---|---|
| `e6c4010` | N1 step policy, lobby boss | typecheck + test:net 465/465 (client only) | `/tmp/quality-g1-{tsc,net}.log` |
| `6682ceb` | W1 pickup reach (sim) | full gate: cargo, clippy, tsc, determinism 53/53, net 465/465 | `/tmp/quality-w1-*.log` |
| `92db921` | exact headroom check (sim) | full gate: cargo (51 binaries ok), clippy, tsc, determinism 53/53, net 465/465 | `/tmp/quality-g2-*.log` |
| `4ac9de0` | test model + comment | typecheck + slow-frames and hidden-tab tests | `/tmp/quality-g3-*.log` |

Each commit was chained on its gate's exit code. `pnpm check` against my own server was not run separately (the net
suite covers it for these files). The :8084 check server was restarted on the final build (hashes match).

## 9. Architectural decisions for review

1. **The worker's step budget is real time owed, not a per-frame count** (`MAX_FRAME_STEPS` 30, `MAX_STEP_DT_MS` 500,
   `ffBudgetMs` = 0.8 of the frame in 12..400 ms, all in `client/lockstep.ts`). Alternatives: drive stepping from a
   `setTimeout` loop separate from rAF (decouples it from the page's frame rate entirely, but two loops share the sim
   and the renderer); keep the caps and lower the soak's throttle. Chosen because it is three constants and the same
   loop. Cost: on a very slow device a frame may spend ~0.5 s stepping before it draws.
2. **One Pos per slow frame** (the last due one). Alternative: send them all (more bursts into the 40/s window, no
   extra information). Cost: fewer intermediate positions for other clients' smoothing at a few fps.
3. **The lobby reads the boss from the entities view**, not a TS mirror of the sim's rng. Reversible; the Join card
   still needs a mirror or an earlier seed draw (Q4b).
4. **Supply alcove 12 rows** (`HITBOX_H + 2`) and **pickup headroom = any 5x10 body offset by -2..=2 at the body's own
   rows**. The strict (40, 25) pickup count stays. Snapshot format 18 resets stored worlds (not live; reversible only by
   another reset).

## 10. D-row drafts (for `docs/DECISIONS.md`)

- **D-2xx (8 Nov), N1 throttled client.** The worker steps by real time owed (`MAX_FRAME_STEPS` 30, `MAX_STEP_DT_MS`
  500, fast-forward 0.8 of the frame up to 400 ms) and a slow frame sends only its last due Pos. The worker's
  OffscreenCanvas rAF follows the page's frame rate (3-10 Hz on a 4x-throttled page) and every limit was per frame, so a
  slow client could not reach 60 ticks/s. Normal clients in the N1 soak went from half the run catching up to live
  throughout; the 4x model client is now CPU-bound (13 ms steps) and still falls behind. `51524fa` was the trigger, not
  the cause. Client only.
- **D-2xx (8 Nov), pickups can be walked into.** Supply alcove 12 rows (was 8, under the 10-row body); cave pickup
  spots need a free 5x10 body at some -2..=2 offset. Snapshot format 18. Walk-in on the real controller: 24/72 -> 71/72
  pile pickups. Pinned by `sim/tests/pickup_reach.rs`.
- **D-2xx (8 Nov), lobby names the boss** from the entities view (render-only).

**Engineering-decisions entry draft (N1):** "A per-frame cap is a frame-rate assumption" -- the bisect blamed a CSS
commit; the real cause was that the worker's step budget was counted per frame while its frames follow the page's
rAF. Link: this report section 4, `n1-throttled-regression.md`, `e6c4010`, `4ac9de0`.

## 11. FUTURE.md ideas (listed, not added)

- A pickup test that the spot is **connected to the spawn**, not only that a body fits (W1).
- The **N1 snapshot fast path**: a client more than N s behind loads a fresh snapshot instead of replaying.
- Measure **step time on a real phone** before trusting the soak's 3x busy-wait model.
- The boss-win soak teleports onto pickups, so it can never notice an unreachable pile: walk the last few cells.

## 12. Spend
| Point | Week $ | Track $ |
|---|---|---|
| B0 | 197.47 | 0 |
| after playtest | 208.47 | 11.00 |
| before W1 (N1 probing, soaks, fixes) | 222.41 | 24.94 |
| after W1 (Sonnet, ~$2.9) | 225.30 | 27.83 |
| before review (gate, headroom fix) | 227.32 | 29.85 |
| after review (Sonnet, ~$1-2) and walk-in check | 230.46 | 32.99 |

Workers: W1 Sonnet ~$2.9 (cap $9); reviewer Sonnet ~$1.5 (cap $5); the rest is the Opus lead. No third worker. The
coordinator's extra warm-verify item was not started: it did not fit in the ~$12 left under the cap.
