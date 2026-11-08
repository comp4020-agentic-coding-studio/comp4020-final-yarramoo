# Brief OWNED: a player's own persistent sandbox world (Opus lead)

Written 8 Nov by the session model from the user's request: "A user can request a single sandbox world that is theirs
to own. They may make changes, and share a link so that others can interact with it, but ultimately it is theirs. This
world is associated with the player ID, and lasts until the player deletes it. This is primarily added so that the
'persists' feature in the marking criteria is met. The deathmatch and survival game-modes intentionally do not persist
and do not belong to any player." The user's decisions: **one owned sandbox per player; anyone with the link can paint
in it; only the owner can delete it.** Final submission is **Mon 9 Nov 12:00**: finished, tested and safe beats wide.

## Budget and stopping (hard)
- **$40 total** for you and every worker. Read spend at the start (B0), after every worker and every ~20 of your own
  tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  Stop dispatching at B0 + $32; finish by B0 + $40. **If the week reads $395 or more, stop at once**, commit to your
  branch and report.
- **At most 3 workers, one at a time** (Sonnet implementation, Haiku mechanical). Workers never dispatch. Each gets a
  brief in `docs/briefs/owned-*.md` (cap, files, commit checklist, verification, "Architectural decisions for review")
  and writes its report to a file as it goes. Write `docs/research/owned-sandbox-report.md` **as you go**.

## Where
`git worktree add /tmp/wt-owned -b owned-sandbox multa`. Never touch the main checkout or the user's :8080 server (PID
in `HANDOVER.md`); never push or merge. Ports **8076** / **5176**, data `/tmp/owned-*`.
**Another Opus lead is building a slow-connection notice in parallel** (`/tmp/wt-slownet`, branch `slow-net`). It owns
the client's connection status UI and the server's per-member lag signals. You own room creation, ownership, the
sweep and the menu. **Both of you may need `server/main.ts`**: keep your edits there small and in the room/HTTP
sections, so the merge is clean; never reformat code you don't change. **Before any gate or heavy build** check
`pgrep -fl "cargo test|vitest|test:determinism|tests/soak"` and `docker ps`, and wait for quiet: one heavy job at a time.

## What exists (read first; verify in the code)
- Rooms: `rooms` table (`server/db.ts`: `creator_player_id`, `visibility` public/unlisted, `mode` includes
  `sandbox`), `server/rooms.ts` (`RoomsStore`: create, list, delete), `POST /api/rooms`, `GET /api/rooms/:code`,
  room deletion 2 min after empty / 10 min never joined (`ROOM_UNLOAD_MS`, `ROOM_NEVER_JOINED_MS`, `deleteRoom`,
  `sweepRooms` in `server/main.ts`, D-188). Survival/Deathmatch rooms must keep that ephemeral behaviour.
- Persistence that already works: worlds persist their tick log and snapshots in SQLite (`worlds`, `snapshots`, the
  tick log; `World.loadFromDb`) and survive restarts; the fixed shared sandbox (world 0) is the old persistent world.
  An owned room needs to be **exempt from the empty-room sweep** and to **reload from its stored snapshot + log** when
  someone opens its link after a restart or after being unloaded (lazy loading exists: `getOrLoadRoom`).
- Identity: players register with a name and get a token (`POST /api/players`, `localStorage` `sand.name`/`sand.token`);
  the server knows a member's visitor/player id. **Players only ever see plain names** (CLAUDE.md).
- The menu (D-210): `client/menu.ts`, `client/menu/{router,screens,live}.ts`, `client/menu.css`; New game -> type ->
  settings; a share screen for private rooms (`#share/CODE`). A sandbox entry exists that goes to `/sandbox`.
- Memory and load caps (`MAX_LOADED_ROOMS`, the 200 MB room-load gate, D-213's capacity findings): an owned world that
  nobody is in must **unload** (free memory) without being **deleted**.
- Snapshot format is 19; the sim's sandbox config is `CLASSIC_SANDBOX` (`shared/room.ts`).

## The job
1. **Design (you)**: the data model (e.g. `rooms.owner_player_id` + a unique index so one per player, or reuse
   `creator_player_id` plus an `owned`/`persistent` flag: decide, migration via the append-only migrations array,
   `PRAGMA user_version`); which sweep exemptions apply; what "delete" removes (room row, world row, snapshots, tick log,
   all of it, in one transaction); what a non-owner visitor can do (paint yes, delete no, rename no); what happens to an
   owned room's tick log growth over days (snapshots prune it: check the cadence and `MAX_LOG_TICKS`); visibility
   (owned worlds are link-only by default and never appear in the public room list? or the owner's choice: pick the
   simpler and say so).
2. **Server**: `POST /api/sandbox` (or an option on `POST /api/rooms`) to create or return the caller's owned sandbox
   (idempotent: a second request returns the same world), `GET` to find it, `DELETE` by its owner only (token-checked);
   the sweep never deletes an owned room; unload when empty still happens. Logging through `log.event` with names in
   `shared/events.ts`; rate-limited where a client can repeat it.
3. **Menu**: "My world" on the title or New game screen: create it (or "open my world" if it exists), the share link
   (reuse the share screen), and a delete button with a confirm. The room page shows the owner's plain name ("Mitch's
   world") and, to the owner only, the delete action or a link to it.
4. **Tests, red first** (`tests/net/`): one owned sandbox per player (a second create returns the same one); a
   non-owner can't delete it (403) but can join and paint; it survives the sweep long past `ROOM_UNLOAD_MS`; it survives
   a server restart with its painted cells (paint, restart, reload, hash matches); it unloads when empty and reloads on
   the next join; delete removes everything and its link then 404s; Survival/Deathmatch rooms are still swept.
5. **Gate**: `node scripts/gate-plan.ts` picks the tier (a server/client change is typecheck + net; anything in
   `shared/`, `sim/` or the input path is the full gate). `APP_URL=http://localhost:8076 pnpm check` against your own
   server. **Two browsers**: owner creates and paints, a second visitor opens the link and paints too, both see each
   other; restart the server; the world is still there; the owner deletes it; the link now says it's gone.
6. **Cold review** (read-only Sonnet) of the `server/` diff (ownership and delete are a trust path), written to
   `docs/research/review-owned-sandbox.md`; check its claims in the code.

## Hand back
`docs/research/owned-sandbox-report.md`: what was built, the data model and migration, tests with red-first evidence,
gate results with log paths, screenshots you Read, the review and what you did, **Architectural decisions for review**,
a D-row draft and an engineering-decisions entry draft (this is the "persists" feature: say how a marker can see it),
FUTURE.md ideas. Branch `owned-sandbox` committed, not pushed; commits end with the writing model's `Co-Authored-By`
line (Opus `Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet `Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku
`Claude Haiku 5.5 <noreply@anthropic.com>`). Kill everything you start.
