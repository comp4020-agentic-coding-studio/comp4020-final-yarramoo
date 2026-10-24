# Brief R3: the main menu

Written 25 Oct by the session model, after R2 landed in full (R2a/R2b/R2c, `multa` at `ff0717b`). Milestone R3 of
`docs/plan-game-modes.md`: the landing page at `/`, with mode cards, a public room list, a create sheet, a name
sheet on first join, a first-visit hint, and (if visible performance allows) a live preview of the busiest
public room. This is the first milestone where a real `client/` change is required to actually join a real room
— R2 built the server side (protocol v9, lazy loading, admission caps) but nothing in `client/` uses it yet; the
client still only ever joins world 0 or 1 by URL path.

**Dispatch:** one Sonnet worker, medium effort, about 90 tool calls (this slice touches `client/`'s routing and
UI shell, which is more surface than a typical slice, but it's additive — the existing sandbox/game pages keep
working at their existing URLs throughout). No independent reviewer — per the plan's own review column, R3's
review is "screenshots at 375 and 1280 px; two contexts sharing a code," which the session model does directly.

---

## Context for the worker

Repo `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`, branch `multa`. Read `CLAUDE.md` first
(player names are shown plain, never `name#id`, in any client-facing UI; names go through `textContent`, never
HTML, per the existing pattern in `client/main.ts`). Then `docs/plan-game-modes.md` sections "The main menu (the
landing page)" in full (who lands here, the five principles, the layout diagram, each piece, phones, routes,
"done when", and the user's 21 Oct answers: no Quick play, live preview stays, icons already made) and "Server:
rooms instead of two fixed worlds" (the API this slice calls). The game is not live: UI and routing changes are
fine, nothing to preserve across them. Never use port 8080 for the Docker check (8093, per convention).

## What exists already (read before touching anything)

- **The server side is fully built** (R2a/R2b, landed and pushed): `POST /api/rooms`, `GET /api/rooms` (public
  list), `GET /api/rooms/:code` (config + id for joining), and the real socket join path — HELLO with a room id
  beyond 0/1 lazily loads that room's `World`, and WELCOME now carries the room's actual 16-byte config
  (`m.cfg`), not just a bare kind byte. `shared/room.ts` has `RoomConfig`, `encodeConfig`/`decodeConfig`,
  presets, and `ROOM_MODES` equivalent info (check `server/rooms.ts`'s `ROOM_MODES` array: `survival`,
  `deathmatch`, `creative`, `sandbox`).
- **`client/main.ts`** (913 lines) and **`client/worker.ts`** currently derive everything from a URL-path-only
  `worldId` (`client/main.ts:48`: `/sandbox` → 0, everything else → 1) and join by that bare id
  (`client/worker.ts:299`, `encodeHello(buildHash, worldId, token, ...)`). `beginReplay` in `client/worker.ts`
  (`:265`) still calls `sim.init(seed, worldKind)` with the bare kind from WELCOME's derived `m.worldKind` field
  (`client/worker.ts:306-307`), not the real config bytes WELCOME now carries (`m.cfg`, a 16-byte `Uint8Array` —
  see `shared/protocol.ts`'s `decodeServer`'s `S_WELCOME` case). **This must change for a real room to actually
  work**: `sim.init` needs to take the room's real config, not a kind number that only ever meant something for
  the two fixed worlds. Read `shared/sim.ts`'s `init` signature — it already accepts either a bare kind number
  (back-compat) or a `Uint8Array` config (R0a), so this is a call-site change in `client/worker.ts`, not a
  `shared/sim.ts` change.
- **`localKind`** (`client/main.ts:78`, `?world=game` dev-only local single-player path, no server) is a
  separate code path from the real server join — don't touch it, and don't let the new room-joining code
  interfere with it.
- **Name storage**: `client/main.ts:50`, `NAME_KEY = "sand.name"`, already backed by `localStorage`, already
  used for the sandbox/game pages' existing (minimal) name entry. The plan's "name sheet on first join" reuses
  this storage, not a new mechanism.
- **Icons**: `docs/art/menu/` (made 21 Oct, see the handover). The logo was flagged as reading like a pyramid and
  regenerated once (`73701c5`, "sand pile with a tiny wizard casting") — use whichever of `docs/art/menu/` looks
  right; if genuinely unusable, flag it in your report rather than generating new art (image generation is a
  separate skill/budget, out of scope for this brief).

## What to build (the plan's own 6-commit breakdown — follow this order)

1. **Routing and menu shell.** `/` serves the menu (not the game client directly — today `/` serves the cave
   world's client page; that behaviour moves to being the fallback room/game route). `/r/<code>` is a room by
   code (fetches `GET /api/rooms/:code`, then joins by the returned numeric id over the existing socket path).
   `/sandbox` stays the permanent sandbox room exactly as today (world id 0, unchanged). Every route still
   serves the same client bundle (the plan: "one HTML page"); the client reads `location.pathname` to decide
   menu vs. room vs. sandbox, the same pattern `worldId` already uses, just with a third branch. Phone-first
   layout: one column under 600px with large tap targets (the plan has an ASCII layout diagram — follow its
   shape, not its exact pixels).
2. **Mode cards and room list.** Three mode cards (Survival, Deathmatch, Creative) plus Sandbox, each with a
   one-line rule and a PvP badge (the plan's wording: "No damage" / "PvP" / etc. — see the layout diagram's
   example text). A public room list below, polled every 5s from `GET /api/rooms` (id, code, name, mode — no
   player names, no live counts yet per R2a/R2b's own TODO, which is fine: show what the API gives, sorted
   however it comes back). Room names rendered via `textContent` only, never `innerHTML`. Empty state: "No rooms
   yet. Make one."
3. **Create sheet and share bar.** Clicking "New" on a mode card (or a bare "Create a room" in the hero) opens a
   sheet: room name (capped client-side at 32 chars, matching the server's own cap), the preset pre-selected
   from which card was clicked, terrain and size pickers, public/unlisted toggle, and an "Advanced" disclosure
   exposing every config field (the plan's table under "Config fields", already in `shared/room.ts`'s
   `CONFIG_FIELDS`). On submit, `POST /api/rooms`, then join the returned room immediately (no second click) and
   show a share bar (the room's `/r/<code>` link plus a copy button) once inside.
4. **Name sheet on first join.** The plan: "The name comes at the moment of joining, not on arrival." The first
   Join or Create action (not page load) opens a small name sheet if `sand.name` isn't already set; it's
   remembered after that via the existing `localStorage` key. A returning visitor with a name skips the sheet
   entirely.
5. **First-visit hint.** On first entry to any room (per mode, remembered per mode so it doesn't nag), a
   three-line overlay explaining that mode's controls (move/cast for avatar modes, dig for Caves with spells,
   brush for Creative/Sandbox) — dismissed by any input. Store "seen" per mode in `localStorage`, a new key
   alongside `sand.name`.
6. **Live preview** (only if it doesn't meaningfully slow the menu page down — measure it, don't just assume):
   a muted, spectator-mode, no-input view of the busiest public room behind the menu's hero text, falling back
   to `/sandbox` if nothing else is live. This connects a real (spectating) socket client on the menu page
   itself, so budget the extra connection against the member caps the same way any spectator does (R2b's
   `memberCapReason` already counts every connection). If this turns out to meaningfully hurt first-paint time
   or feels too complex for this slice's budget, it's explicitly conditional ("if M1 says so" — M1 already said
   yes, live preview stays, but if it doesn't fit cleanly in this slice's time budget, build everything else
   first and flag the live preview as a FUTURE.md item with your reasoning, rather than rushing a broken one).

## The real-room join path (required for commits 1 and 3 to actually work end to end)

This is the part of the brief that isn't "UI only" — a room created via the new create sheet must actually be
playable, which needs:

- `client/worker.ts`'s `beginReplay` to init the sim from `m.cfg` (the real config bytes) when joining a real
  room, not the derived `m.worldKind`. Since `shared/sim.ts`'s `init` already accepts a `Uint8Array`, this
  should be close to a one-line change at the call site plus threading `cfg` through instead of `worldKind`
  where `beginReplay` is invoked from the WELCOME handler (`:306-307`).
- `client/main.ts`'s `worldId` (currently a `const` derived once from the URL path at module load) needs to
  become capable of holding a real room id (any positive integer, not just 0 or 1), fetched from
  `GET /api/rooms/:code` when the URL is `/r/<code>`, before the worker connects. The existing `worldId === 1`
  checks sprinkled through `client/main.ts` (avatar steering, casting, the nav highlighting) are about "is this
  an avatar-capable world," not literally "is this world id 1" — as rooms land, these need to become
  config-driven checks (does this room's config have `avatars === 1`?) rather than an id comparison, since a
  real room's id will never be 1. Read every `worldId === 1` site listed in `grep -n "worldId" client/*.ts`
  (already done for you above) and judge each one: some are genuinely "is this the old fixed game world"
  (nav highlighting against the old Game/Sandbox links, which the plan says go away anyway in the new menu —
  see "Header" in the plan) and can be deleted outright as part of commit 1's routing change; others need to
  become `cfg.avatars === 1` checks. Use your judgement and explain each non-obvious call in your report.
- Phones: avatar-capable rooms (Deathmatch, Survival, Creative-with-avatars) show "Watch" not "Join" on a touch
  device per the plan (D-011's existing spectate pattern already does this for the old game world — generalize
  it, don't rebuild it).

## What NOT to build (later milestones' job)

- Creative's brush panel, Survival's round machine, Deathmatch's respawn/kill tallies — R4/R5/R6.
- Per-mode room lifecycle timing (archive/delete) — still deferred from R2b, not this slice's job either.
- `max_players` enforcement, further capacity work — out of scope.
- New generated art — flag a gap, don't generate.

## Verify

- **The two existing fixed-world pages keep working exactly as before** at their existing URLs
  (`/sandbox`, and whatever URL served the cave world before — confirm this still works, now presumably by
  redirecting through the menu or by a direct room-equivalent route; state clearly in your report which URL the
  old game world lives at now and why).
- **A real two-browser-context test**: one context creates an unlisted room via the create sheet (or
  programmatically through the API plus a UI join, your choice for the automated test) and shares its code; a
  second context enters `/r/<code>` and both end up in the same room, see the same config, and (if the room is
  avatar-capable) their sims agree on a state hash after some ticks — mirrors the existing two-client-agreement
  pattern already used in `tests/net/room-join.test.ts` and `tests/net/game.test.ts`.
- **The public room list never shows an unlisted room** — a net/component test, not just eyeballing.
- **`pnpm check` (the course spec) passes against the Docker image with the menu at `/`** — this is explicitly
  named as a "done when" criterion in the plan; the course spec checks `/` serves a page with a module script
  and a `/readme/` link (`spec/game.test.ts:15-22`), so confirm this still holds with the menu as the new `/`.
- **Screenshots at 375px and 1280px**, saved under `docs/art/shots/` with clear names, for the session model to
  review (the plan's own review method for this slice — the session model can't drive a browser directly without
  delegating that separately, so a screenshot plus a plain-text description of what's shown is the deliverable).
- **Gate every commit on exit codes:**
  `pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...`
  (no `sim/` changes expected; if you need one, add the Rust gate too).
- **Boot the real Docker image** and run `APP_URL=http://localhost:8093 pnpm check`. Confirm the menu, a created
  room, and the existing sandbox/game pages all work against the live container, not just in-process tests.

## Files you may touch

`client/*` (main.ts, worker.ts, index.html, any new files for the menu UI — a new `client/menu.ts`/`.html` or
extending the existing single-page structure, your call on whichever fits the existing build setup better),
`shared/events.ts` (new event names only, if client-triggered room joins need new server-side logging — check
with `server/main.ts`'s existing join logging first, it likely already covers this), `tests/net/*` (new tests),
`docs/art/shots/*` (new screenshots). Don't touch `sim/`, `shared/room.ts`'s config layout, `shared/protocol.ts`'s
wire format (R3 is a client, not a protocol, slice — if you find you need a protocol change, stop and flag it
rather than bumping the version yourself), or `server/*` (the API this slice needs already exists from R2a/R2b;
if something's missing, flag it rather than building new server routes in this brief).

## Commits (checklist; each gated — this mirrors the plan's own numbered breakdown)

1. [ ] Routing and menu shell (`/` is the menu, `/r/<code>` joins a room, `/sandbox` unchanged)
2. [ ] Mode cards and room list
3. [ ] Create sheet and share bar (a created room is actually joinable end to end)
4. [ ] Name sheet on first join
5. [ ] The first-visit hint
6. [ ] Live preview (or, if deferred, a clear FUTURE.md entry explaining why, plus everything else working)

End each message with the attribution line from the session's instructions. **Don't push**: the session model
reviews and pushes.

## Report

Write to `docs/research/r3-worker-report.md` as you go (append per commit). Include: what changed per commit,
the real-room join evidence (two contexts, same config, hash agreement if avatar-capable), the Docker check, a
plain description of each screenshot (what it shows, so the session model can judge by eye), a section
**"Architectural decisions for review"** (how you judged each `worldId === 1` call site, whether live preview
made the cut and why, anything hard-to-reverse you were unsure about where you took the more reversible option),
and any FUTURE.md ideas written directly into `FUTURE.md`.
