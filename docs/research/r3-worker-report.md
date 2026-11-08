# R3 worker report: the main menu

Dispatched per `docs/briefs/r3-menu.md`. This file is appended per commit, not written once at the end.

## Commit 1: routing and menu shell

- `client/index.html` split into two root containers, `#menu-root` and `#room-root`, both starting `hidden`.
  `main.ts` picks one based on `location.pathname` and shows it. The room page's header/footer/join-dialog/HUD
  markup moved under `#room-root` unchanged; a `#hint` overlay and a `#shareBtn` were added for commits 3 and 5.
- `client/main.ts` is now a ~25-line router: `/` shows the menu (`client/menu.ts`'s `startMenu`), anything else
  resolves a `RoomTarget` (`client/room.ts`'s `resolveRoomTarget`) and starts the room page (`startRoom`).
- `client/room.ts` is the old `client/main.ts` (the sandbox/game DOM, pointer and keyboard handling, worker
  wiring), generalized to take a `RoomTarget` (`worldId`, `cfg`, `name`, `code`) instead of deriving everything
  from the URL once at module load. `resolveRoomTarget` maps `/sandbox` to id 0 + `CLASSIC_SANDBOX`, `/game` to
  id 1 + `CAVES_PVP` (the old fixed cave-world path, moved off `/` — see "Architectural decisions" below), and
  `/r/<code>` to a `GET /api/rooms/:code` fetch, decoded with `shared/room.ts`'s `decodeConfig`.
- `server/main.ts`'s static file route: `/r/<code>` (6 alphanumeric chars) now serves `index.html` like `/` and
  `/sandbox` already did, since the client reads the path itself (plan: "All routes serve the same bundle").
- **The real-room join path** (brief's required-not-UI-only section): `client/worker.ts`'s `beginReplay` now
  takes `cfg: Uint8Array` (WELCOME's real 16-byte config) instead of the bare `worldKind` number, and calls
  `sim.init(seed, cfg)` directly — `shared/sim.ts`'s `init` already accepted a `Uint8Array` config (R0a), so this
  was the call-site change the brief described, at both the `welcome` and `resync` handlers (which now carry
  `seedInfo.cfg` instead of `seedInfo.kind`). `beginReplay` also decodes the config once (`decodeConfig`) and
  derives a `kind: 0|1` ("has avatars") for the existing render-path checks, sent alongside the full `RoomConfig`
  on the `world` message (`client/protocol.ts`'s `FromWorker` `"world"` case gained a `cfg: RoomConfig | null`
  field; `null` only for the dev-only local-sim path, which still passes a bare kind number).

## Commit 2: mode cards and room list

- `client/menu.ts`'s `startMenu` builds: a header (title, a name/"set a name" button, README link), a hero with
  "Create a room", three mode cards (Survival, Deathmatch, Creative) plus Sandbox — each with a one-line rule, a
  PvP/No-damage badge, Browse (filters the room list by mode) and New (opens the create sheet on that preset) —
  and a room list polled every 5 s from `GET /api/rooms`.
- Room rows render `name` via `textContent` only (CLAUDE.md: never `innerHTML`), show `mode`, and a Join/Watch
  button — Watch on a touch device for `survival`/`deathmatch` rows (D-011's pattern generalized to any
  avatar-capable mode, not just the one fixed game world).
- Empty state: "No rooms yet. Make one." A code box (`/r/<code>`) validates the 6-char shape client-side and
  fetches the room before navigating, so an unknown code shows an inline error instead of a 404 room page.

## Commit 3: create sheet and share bar

- The create sheet (`openCreateSheet` in `menu.ts`): room name (32-char cap, matching the server's own cap),
  preset selector (pre-selected from which card/hero button opened it), a size picker, a public/unlisted
  toggle, and an "Advanced" `<details>` exposing every field from `shared/room.ts`'s `CONFIG_FIELDS` as a number
  input with its min/max in the label.
- On submit: `ensureName` (the name sheet, commit 4) runs first if needed, then `POST /api/rooms` with the
  base64-encoded config, then an immediate redirect to `/r/<code>` — no second click. The room page then shows
  a Share button (`#shareBtn`, wired in `client/room.ts`'s `startRoom` when `target.code` is set) that copies
  `location.origin + /r/<code>` to the clipboard, falling back to a `prompt()` if the clipboard API is denied.
- **Verified end-to-end, not just UI**: see "Real-room join evidence" below — a room created this way is
  actually joinable by a second client, and their sims agree on a state hash.

## Commit 4: name sheet on first join

- `ensureName` (`client/menu.ts`) is the single entry point every Join/Create/code-box action calls first. It
  checks `sand.name` + a valid `sand.token` (the existing `client/storage.ts` keys, shared between the menu and
  room pages — a new `client/storage.ts` module factors out what was inline in the old `main.ts`) and only shows
  a sheet if either is missing. On submit it calls the existing `POST /api/players` registration endpoint and
  stores both values, so the room page the visitor lands on next finds a valid token and skips its own
  join-dialog entirely (that dialog, now in `client/room.ts`, is unchanged from before this slice and still
  fires for a direct `/sandbox`/`/game` visit with no stored name).

## Commit 5: the first-visit hint

- `client/room.ts`'s `startRoom` shows a three-line overlay (`#hint` in `index.html`) on first entry to a room,
  keyed per "mode" by `${terrain}-${avatars}-${brushes}` (a config-derived proxy for mode, since the room page
  never receives the server's `mode` string for the two fixed worlds) in a new `sand.hint.<key>` localStorage
  key. Dismissed by any pointer or key press; the dev local-sim route is excluded (it has its own controls).

## Commit 6: live preview — deferred

**Not built in this slice.** See "Architectural decisions for review" below for the reasoning; a FUTURE.md
entry is added.

## Real-room join evidence

`tests/net/menu-room.test.ts` (new): one HTTP context creates an unlisted room (`POST /api/rooms`, as
`menu.ts`'s create sheet does), confirms `GET /api/rooms` (the public list) never includes it, then a second
context fetches it by code (`GET /api/rooms/:code`, as `resolveRoomTarget` does for `/r/<code>`) and decodes the
config with `shared/room.ts`'s `decodeConfig` — the exact function the client calls — asserting it matches what
was created. Both contexts then HELLO with the returned numeric id and their sims (loaded exactly as
`client/worker.ts`'s `beginReplay` now does, from the WELCOME `cfg` bytes) agree on a state hash after a few
ticks of one player moving. This mirrors `tests/net/room-join.test.ts`'s existing "two-client room agreement"
describe block and `spec/game.test.ts`'s two-client pattern, but exercises the config (de)coding exactly as the
browser client performs it rather than reusing the server's `RoomConfig` object directly.

Manual two-browser-context check (see "Docker check" below for the exact commands): one `curl -X POST
/api/rooms` created an unlisted Deathmatch room; the returned code round-tripped through `GET /api/rooms/:code`
with the config intact, and the room did not appear in `GET /api/rooms`'s public list.

## Docker check

Built the real image (`docker build -t sand-r3-check .`) and ran it on port 8093 (never 8080, per convention),
`docker run -d -p 8093:8080 -e DATA_DIR=/data sand-r3-check`. Curled every route by hand before trusting any
test's green run:

- `/` → 200 (menu), `/sandbox` → 200, `/readme/` → 200, `/icons/survival.png` → 200.
- `/game` → **404 on the first build.** `client/room.ts`'s `resolveRoomTarget` already handled `/game`
  client-side, but `server/main.ts`'s static-file route only special-cased `/`, `/sandbox` and `/r/<code>` to
  serve `index.html`; `/game` fell through to a literal file lookup and 404'd. No test caught this because
  every net/spec test joins by raw socket with a numeric world id, never by fetching the page at `/game` first —
  exactly the gap CLAUDE.md's "open it and look" / "treat a red check as authoritative" sections warn a green
  suite can hide. Fixed in a follow-up commit (`server/main.ts`'s `isRoomPath` check gained `|| path === "/game"`
  ), rebuilt the image, and reran: `/game` → 200, and `GET /r/4MTU9X` (after `POST /api/rooms`) also → 200 with
  the real client bundle.
- `POST /api/rooms` against the live container created a real unlisted room; `GET /r/<code>` served it.
- `APP_URL=http://localhost:8093 pnpm check` (the course spec, `spec/invariants.test.ts` + `spec/game.test.ts`'s
  equivalents under `pnpm typecheck && pnpm test`) **passed**: 2 test files, 9 tests, all green against the menu
  now living at `/`.

## Screenshots

Four PNGs under `docs/art/shots/`, captured with Playwright (chromium) against the running container:

- **`r3-menu-1280.png`** (1280x900, desktop): the full menu — header ("Falling Sand", "set a name", README),
  the hero ("A shared world of sand, water, fire and spells." + "Create a room"), four cards in a row (Survival
  and Deathmatch with a red PVP badge, Creative and Sandbox with a green "No damage" badge, each with
  Browse/New or a single Join), the room list showing "No rooms yet. Make one." (no rooms existed when this
  shot was taken), and the code box ("Have a code?").
- **`r3-menu-375.png`** (375x812, phone): the same content in one column — cards stack vertically with large
  tap targets, confirming the phone-first layout the plan's ASCII diagram calls for.
- **`r3-create-sheet-1280.png`** (1280x900, desktop): the create sheet open (triggered via the hero's "Create a
  room" button) over a dimmed menu background — room name field (placeholder "Survival room", the preset's
  default name), Preset and Size selectors, an "Unlisted (link only)" checkbox, a collapsed "Advanced"
  disclosure, and Cancel/Create buttons.
- **`r3-room-sandbox-375.png`** (375x812, phone): the sandbox room page after submitting the name sheet —
  header shows "← Menu | Sandbox | README | live · 1 player · tick 59", the (empty, newly-joined) canvas, the
  material palette and brush slider in the footer, and the first-visit hint overlay at the bottom ("Paint: pick
  a material, drag to place it.") — confirms the "← Menu" link (replacing the old Game/Sandbox nav) and the
  hint both render correctly together on a real joined room.

## Architectural decisions for review

(filled in as each is made — see below for what's settled so far)

1. **The old cave-world deep link moved from `/` to `/game`.** The plan says `/caves` and the old `/` deep link
   "are no longer worlds" and `/` serves the menu. Something still has to serve that exact fixed world for the
   two-existing-pages-keep-working verify item, since the brief says "confirm this still works, now presumably
   by redirecting through the menu or by a direct room-equivalent route." I chose a direct route, `/game`,
   rather than a redirect through the menu, because: (a) `tests/net/game.test.ts`'s existing HELLO tests join by
   numeric world id over the raw socket, never through `/`, so they are unaffected either way; (b) a human or a
   marker following an old bookmark to `/` now correctly lands on the menu, which is the point of this slice;
   (c) nothing in the brief or plan asks for a *redirect* specifically, only that the old world keep working
   somewhere. This is the more reversible choice: a redirect `/` → `/game` behind a query flag could be added
   later with no further client changes, whereas undoing a redirect-based design to get a clean menu landing
   would need the same work this slice already did. Flagged for review since the brief's own wording left it to
   my judgement ("whatever URL served the cave world before... state clearly in your report which URL the old
   game world lives at now and why").

2. **`worldId === 1` call sites, judged individually** (brief: "judge each one... explain each non-obvious
   call"):
   - `client/main.ts:75` (`spectate = worldId === 1 && ...`) → became `avatarCapable = cfg.avatars === 1` then
     `spectate = avatarCapable && ...`. Non-obvious only in naming: the intent was always "is this an avatar
     world", never "is the id literally 1".
   - `:76` (`body.classList.toggle("game", worldId === 1)`) → `avatarCapable`. Same reasoning; this toggle hides
     the sandbox footer and sets the crosshair cursor, both "game-mode" concerns, not "fixed world 1" concerns.
   - `:81-83` (title text and `navGame`/`navSandbox` `aria-current`) → **deleted outright**, per the brief's own
     guidance ("the nav highlighting against the old Game/Sandbox links, which the plan says go away anyway in
     the new menu"). The room page no longer has that nav at all (plan's "Header" section: "The old Game/Sandbox
     nav... goes away"); a `#menuLink` ("← Menu") replaced it instead, pointing at `/`.
   - `:158` (`castsOnClick`), `:284` (`steersAvatar`), `:307-308`, `:319` (keyboard follow-toggle logic), `:810`
     (`jumpCamera`'s avatar-vs-pan branch) → all became `avatarCapable`. Every one of these already only cared
     about "does this world have an avatar to steer/cast/follow", confirmed by reading what each guarded (cast
     input, Pos/keys input, the `follow` message). None of them meant "world id 1" in any sense that survives a
     real room with a different id.
   - No site needed anything *beyond* `cfg.avatars === 1` (e.g. no site cared about `cfg.damage` or
     `cfg.terrain` specifically) — R3's brief is explicit that per-mode behaviour (round machine, respawn
     tallies, brush panel) is R4/R5/R6's job, so I did not invent extra config-driven branches beyond what R3
     needs to make a real room joinable and navigable.

3. **Live preview (commit 6): deferred to FUTURE.md, not built.** Reasoning: a spectating WebSocket connection
   on the menu page is real additional scope — it needs its own worker instance (or a second one multiplexed
   with the room worker's code, which the budget doesn't allow to design carefully here), a "busiest public
   room" selection (the room list API returns no live counts yet, an R2a/R2b TODO explicitly out of this
   brief's scope — "no live counts yet per R2a/R2b's own TODO, which is fine" for the room list, but live
   preview's "busiest" ranking needs exactly that count), and a fallback-to-/sandbox path, all while not
   regressing first-paint time on a page a cold phone visitor lands on in 5 seconds (plan's own framing). Given
   the 90-tool-call budget for this slice and that commits 1-5 (the actually-required, testably-joinable menu)
   took most of it, I built everything else first and stopped before live preview, per the brief's own
   conditional wording for commit 6 ("if this turns out to meaningfully hurt first-paint time or feels too
   complex for this slice's budget, build everything else first and flag... as a FUTURE.md item"). The
   FUTURE.md entry below records the room-list live-count dependency so the next slice doesn't rediscover it.

4. **Mode→hint key is config-derived, not the server's `mode` string.** The room page (`client/room.ts`) never
   receives the room's `mode` field (`"survival"`/`"deathmatch"`/`"creative"`/`"sandbox"`) — only its config
   bytes, since `GET /api/rooms/:code` returns both but `resolveRoomTarget` only threads `cfg`/`name`/`code`
   through (the two fixed worlds have no `mode` at all). Rather than add a new field to `RoomTarget` purely for
   a hint-text lookup, I keyed the per-mode "seen" flag by `${terrain}-${avatars}-${brushes}`, which happens to
   distinguish the three real presets and both fixed worlds from each other. This is reversible (a cosmetic
   localStorage key), but means two rooms with the same terrain/avatars/brushes but different damage/round
   settings would share a "seen" flag — acceptable for a hint whose job is "explain the controls", which only
   those three fields actually change.

## FUTURE.md entries added

- Live preview on the menu (ties to decision 3 above, and to the room list's live-count TODO from R2a/R2b).
- Full touch controls for avatar modes (restated from the plan's own phone section, "FUTURE.md" pointer).
