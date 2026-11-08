# Brief HM: the menu, built two ways (playtest note 2, slice H2)

**Why:** the user's note: "The dashboard, while very cool and functional, could use an overhaul. Something
that makes the particle simulation really pop." "Dashboard" means **the menu at `/`** (confirmed). Today the
menu (`client/menu.ts`, `client/index.html`, its CSS) is static: a hero, mode cards, a room list. A visitor
sees no falling sand until they enter a room. The user will compare two branches and pick one, so build each
as a finished, demonstrable thing.

**Two Sonnet workers in parallel, one per variant.** Each works only in its own worktree and branch:

| Variant | Worktree | Branch | vite port | server port |
|---|---|---|---|---|
| local | `/tmp/wt-menu-local` | `menu-local` | 5174 | 8101 |
| live | `/tmp/wt-menu-live` | `menu-live` | 5175 | 8102 |

Both branches start at `0099809`. Run `pnpm install` in your worktree first. Start vite with
`pnpm build:sim && pnpm build:sim:devpaint && pnpm exec vite --config client/vite.config.ts --port <yours> --strictPort`.
**Never use 5173 or 8080**, and never touch the main repo or the other worktree.

Rules: use no subagents and stay within about 100 tool calls; every commit gated on exit codes chained with
`&&` (never through `grep`); `rm` only on literal absolute paths; **no pushing**; never weaken a test; prefix
cargo with `PATH="$HOME/.cargo/bin:$PATH"`; kill every vite, server and browser session you started by PID
before you finish.

**Files you may touch:** `client/menu.ts`, `client/index.html`, the menu's CSS, new files under `client/`
(e.g. `client/menu-preview.ts`), `tests/net/**` for new tests, and for **live only** `server/main.ts`'s
`listRoomsRoute` and its test. **Not `sim/`** (the sim must stay byte-identical; both variants only use the
existing ABI), not `shared/protocol*`, not `client/worker.ts` unless reusing it needs a small additive
message type (flag it if so).

## The design (both variants)

- **The simulation is the hero.** A full-bleed canvas behind the whole menu, rendered with the game's own
  renderer and palette (`client/render.ts`, the worker), at the game's crisp whole-number scale. The heading
  "Simulta", the mode cards and the room list float over it on translucent, blurred panels
  (`backdrop-filter`), readable on any material behind them. Keep the existing layout, names, buttons and
  flows working exactly as now (name sheet, create sheet, share bar, join).
- **It has to be in motion within a few seconds,** and look good: sand pouring, water finding its level,
  lava meeting water into steam and glass, fire catching wood. The point is "this world is alive".
- **Muted:** no sound effects from the preview. The menu's music button keeps working as today.
- **Cheap when it should be:** pause the preview when the tab is hidden; with `prefers-reduced-motion`, show a
  single still frame (or step very slowly); on a phone (`isTouch()` in `menu.ts`) use a smaller world or a
  lower step rate. Never block the menu's first paint on wasm: show the menu, then fade the preview in.
- **No input from the preview ever reaches a real room.** Clicking the canvas does nothing.

## Variant local (`menu-local`)

A local sandbox world (no network) runs behind the hero. Use the existing local-mode path (the sandbox route
already runs a local sim in the worker). A small deterministic **director** script feeds it Paint inputs over
time through `push_input` (invariant 1): emitters over a pre-built scene, e.g. a sand pour onto a ledge, a
water fall, a lava pocket by a pool, a little wood with fire. Loop it: after N seconds, restore a snapshot of
the start (or reset) so the scene never fills up and never freezes. Size S. Tune the scene by eye in the
browser; take screenshots.

## Variant live (`menu-live`)

A muted, read-only view of the **busiest public room**, falling back to the local scene (copy variant local's
idea in a smaller form: a few emitters is enough; don't wait for the other branch) when no public room has
players.

- **Server:** `GET /api/rooms` gains a live `players` count per room (from the in-memory `worlds` map; 0 for an
  unloaded room) and sorts by players, then `last_active` (FUTURE.md "Live player counts"). Net test, red
  first.
- **The view must not be a player.** It must not appear in Who, count toward Survival's ready-up or
  `playerCount`'s capacity limit, send any input, or keep a room loaded on its own. Find out whether a pure
  spectator connection exists today (D-171 and F7's "Spectate record" work in `docs/briefs/fun9-f7-polish.md`
  section 3). If a real spectator connection would need a protocol change, **stop and flag it**, and use the
  cheapest honest option instead (for example, render the room's latest stored snapshot, refreshed every few
  seconds, without stepping), and say what it costs.
- **Measure the catch-up:** joining a room replays its log. Say how long the preview takes to show a live
  frame on a busy room, on a laptop and at 4x CPU throttle, and what it costs the server per menu visitor.
- Test it with a real server (`pnpm build:client`, then `PORT=8102 DATA_DIR=/tmp/hm-live node server/main.ts`),
  a room with a player in it (`agent-browser --session hm-live-player`), and the menu in a second session.

## Measure (both)

Cold first paint and "preview moving" times of `/` from a production build (`pnpm build:client`, served by
the real server on your port), with Playwright or `agent-browser`: once unthrottled, once at 4x CPU throttle
with a 390x844 viewport. Also the JS and wasm bytes the menu now loads compared with before. Put the numbers
in your report.

## Look at it

Use `agent-browser` via `zsh -ic`, viewport 1280x800 first, then 390x844. Save screenshots to
`docs/art/shots/menu-<variant>-*.png` (a few, not dozens). Check the panels stay readable over every material
and that every existing menu flow still works: open a room from the list, create a room, the name sheet.

## Commit checklist

- [ ] (live only) `GET /api/rooms` live counts and sort, with its net test.
- [ ] The preview canvas behind the menu, the panels restyled over it.
- [ ] The scene: the director (local) or the room view plus the fallback (live).
- [ ] Hidden-tab pause, reduced motion, the phone path.
- [ ] Screenshots and the report.

## The gate (every commit)

`pnpm typecheck && pnpm test:net && git commit ...`. If you touched nothing in `sim/`, `shared/` or the input
path you may skip `pnpm test:determinism`; say so in the report.

## Report

Write `docs/research/hm-<variant>-report.md` **in your worktree** and commit it on your branch: what you built,
the commits, the measurements, the screenshots, what you'd do next, and **"Architectural decisions for
review"** (how the preview gets its sim and renderer, how it avoids being a player, anything you added to the
worker or the server), each with the alternatives, why, and the later cost. Suggest FUTURE.md ideas there.
