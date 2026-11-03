# Brief F report (worker, fix-f-client)

## 1. Catch-up after a hidden tab
Cause confirmed: worker.ts only fast-forwarded when `net === "catching-up"` (set on connect/resync/reconnect). A hidden
tab stayed `live` and ran `ls.plan()`: at most 4 + 4 = 8 ticks per frame (~480/s at 60 fps, 240/s in practice).
Fix: `driveFrame` + `CATCHUP_THRESHOLD = 120` in `client/lockstep.ts`; the worker frame loop calls it. Backlog > 120
ticks sets `catchUpTarget = received` and `net = "catching-up"` (overlay shows, `gameFrame` does not run, so no Pos
and no casts); back to live through the existing path (`sendLive`). HASH/claims are gated on `tick > catchUpTarget`
so nothing is re-sent. New `hidden` worker message (from `visibilitychange`) stops Pos and casts while hidden; no
Leave sent.
Test `tests/net/hidden-tab.test.ts`: red with the threshold check disabled (`sawCatching` false), green with it.
Numbers: before, 91,384 ticks at <=480 ticks/s is >= 190 s of pure replay (observed ~6 min at 240/s, while the world
kept advancing). After: probe on an empty-world backlog of 3001 ticks, fast-forward ran at ~92,000 ticks/s (32 ms
total), so 91k ticks is ~1 s on an empty world; a busy world is slower but is bounded by the 12 ms/frame budget,
roughly 5-20x the old rate or better. (Measured on empty ticks only; not measured on a populated survival room.)
(c) Snapshot instead of replay for huge backlogs: skipped. The resync path closes the socket with 4001 and has a
budget; reusing it needs a server decision about when to hand out a snapshot, more than a few lines.
(b) Server inactivity: recommend (not built) that the server mark a player silent for N minutes (no Pos/keepalive;
the client sends a keepalive Pos every ~POS_KEEPALIVE_TICKS while standing) as inactive/away, so lobby ready-up
does not wait on a hidden tab. Server change, flagged only.

## 2. Lava
Cause (found, not exactly as hypothesised): lava used the water constants. In a real room (survival, avatar painted
into lava via `__devPaint`) the avatar did sink, but at water's pace and, while up/space was held, swim-up
(`vy -= 0.2` against a pull of 0.042) rose at up to -0.9 cells/tick, so it bobbed out and floated on top; the "feet
check" (`dy` -1 and -5 on the middle column) also misses lava less than 2 cells deep. Fix: per-liquid `LiquidFeel`
table in `client/avatar.ts` (water/oil/acid as before; lava walk 0.3, pull 0.5, swim 0.1, max sink 0.3, max rise 0.25).
Test (`tests/net/avatar.test.ts`): red first (lava max sink was 0.7, expected < 0.35), now green. Browser check:
in a 30-radius lava pool the avatar dropped ~8 cells in 1 s and health fell steadily.
Not done: a thin (<2 cell) lava layer still does not count as "in" liquid; left alone.

## 3. Walking animation
`updatePose` (`client/fx.ts`): walkPhase factor 0.45 -> 0.2 per cell (about 9 frames/s at WALK; was 20), |vx| smoothed
with an exponential average (90 ms), walk/idle switch with hysteresis (on 0.12, off 0.05). Test
`tests/net/walk-anim.test.ts`: red on the old code (20.2 frames in a second; a one-frame stall flickered to idle),
green now. Not verified: I did not open a second real-room session to watch a remote avatar; judged by the unit
test only. The user should look at it at 1x and 2x.

## 4. Remove Creative
Menu card, the filter option, `creative.png` removed (`client/menu.ts`). Server: `POST /api/rooms` with
`mode: "creative"` returns 400 `{"error":"mode_retired"}`; `CREATABLE_MODES` (survival, deathmatch, sandbox) in
`server/rooms.ts`; `ROOM_MODES` kept (it is also the type of stored rows) and the DB check constraint untouched.
Old Creative rooms stay loadable (the simpler option, and reversible). Tests: `tests/net/rooms.test.ts` new test red
before (the room was created), green after. `room-join.test.ts` Paint/Pos tests tested the avatars+brushes config,
not Creative itself, so they were re-pointed to `mode: "survival"` with the same config (none deleted).
`tests/net/room.test.ts` keeps `CREATIVE` (shared config hex pin; sim config untouched). The `CREATIVE` constant in
`shared/room.ts`, the dual-tools code in `room.ts` and `tests/soak/p1-creative.ts` are left (a room config can still
set avatars+brushes; not clearly dead).

## Architectural decisions for review
- Catch-up threshold and pause: threshold 120 ticks (2 s) in `driveFrame`; target = tick received so far. Alternatives:
  a larger threshold (fewer false overlays on a lag spike, but longer crawl), or raising per-frame steps instead of
  an overlay. Chosen for reuse of the existing, tested fast-forward path; the avatar pauses because `gameFrame`
  only runs while `net === "live"`. Cost: a 2 s network stall now flashes the overlay and a 12 ms/frame ff budget; a
  Pos-less gap of that length is visible to others.
- Hidden tab: only stop Pos/casts (worker `hidden` message), no Leave, no server change. Alternative: send Leave
  (rejected: resets lobby countdowns on an alt-tab). Cost: a hidden player stays in the lobby/ready set; the
  server should probably mark players silent for minutes as away (flagged, not built).
- Per-liquid controller table: `LiquidFeel` in `client/avatar.ts`, keyed on material id 14 (lava) vs water-like
  default. Alternative: put the numbers in `shared/names.ts`. Cost: a new liquid with its own feel needs a row here
  (the material-class test in avatar.test.ts does not enforce it).
- Old Creative rooms: stay loadable; only creation is refused (`mode_retired`). Alternative: fail loading as
  "room unavailable". Cost: the dead mode label persists in old rows until they expire.
- Rate of huge backlogs (>20,000): not handled with a snapshot (see item 1c).

## Ideas for FUTURE.md (suggested)
- Server-side "away" state for players with no input for minutes (lobby ready-up, dashboards).
- Show "you were away N minutes" instead of the generic catching-up overlay after a hidden tab.

## Verification notes
- Full `pnpm test:net` at the Creative commit: 354 passed, 1 failed (`claims-live.test.ts` "the killer is awarded
  first_blood..." - the logged claim.death did not match victim/killer). It fails intermittently on the base commit
  6968d44 as well (1 of 2 runs there, 1 of 3 on this branch), so it is a pre-existing flake, not from this work. It
  was NOT investigated: per CLAUDE.md it is a real defect (probably claim ordering/timing) and needs its own look.
- Screenshot `docs/art/shots/fix-f-lava.png` (looked at): the avatar standing in a lava pool in survival, health bar
  partly drained. It shows lava contact only; the sink itself is shown by the numbers in item 2.
- Not verified: remote-avatar walk in a real room on port 8098 (no real server started); the overlay appearing in a
  real hidden tab (tested at the driveFrame level, not in a browser with a throttled background tab).
