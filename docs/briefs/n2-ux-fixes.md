# Brief N2: UX fixes from the agent playtests, then hover names

**Why:** two agent playtests (`docs/research/playtest-agent-newcomer.md`, `playtest-agent-survival.md`, screenshots in
`docs/art/shots/pt-*.png`) found things a first-time player trips on. The user approved all of these (4 Nov).

**Worker:** one Sonnet worker in its own worktree. Create it first:
`git -C /Users/mitch/code/courses/comp4020/comp4020-final-yarramoo worktree add /tmp/wt-ux -b ux multa`, then
`pnpm install` in `/tmp/wt-ux`. Work only there. No subagents, about 100 tool calls. Rules: `CLAUDE.md`; commits only on a
green gate chained with `&&` (never `;`, never through `grep` or `tail`); `rm` only on literal absolute paths;
**no pushing**; never weaken a test. Your ports: vite **5180**, server **8120**; `agent-browser` sessions `ux-*`.
Kill everything you start by PID and close your sessions before finishing.

**Files you may touch:** `client/**` except `client/render.ts` and `client/menu-preview.ts` (another worker is doing
the sky in `render.ts` tonight), `tests/net/**` for new client tests, `docs/research/n2-report.md`,
`docs/art/shots/n2-*.png`. **Not** `sim/`, `server/`, `shared/protocol.ts`. **Invariants 1 and 9:** everything here is
display; nothing read from the sim's views becomes an input.

## Part A: fixes (one commit each, or grouped where they share a file)

1. **The "party fell" overlay** (`client/room.ts` ~975): offer the same three exits as the late-join panel (Spectate,
   Find another room, Start a new room), reusing that panel's code rather than copying it. Add a line with the depth
   reached (the deepest any player got, from what the client already knows, or your own max depth if that's all
   there is; say which). "Victory" keeps its own text but gets the same exits.
2. **The death cause.** `EV_DEATH` already carries the killer (`a`, a player id or an enemy-owner id) and the cause
   (`b`: a spell id, `CAUSE_*` in `shared/sim.ts`, or `CAUSE_ENEMY_BASE + kind`; read `sim/src/spells.rs` around line
   553-598 and `shared/sim.ts` to get the encoding right). Show it on your own death: "Killed by a Fire imp", "Killed
   by the Deep Mage", "Your own Bomb", "Burned in lava", and so on, in the existing death text. Plain player names
   only, never `name#id`. Test the mapping from cause to text (every `CAUSE_*` and enemy kind has text, nothing
   reads "undefined").
3. **Survival card badge** (`client/menu.ts:153, 177`): "No damage" next to "Co-op, one life" reads as a contradiction.
   Show "Co-op" for the non-PvP modes (keep the badge style).
4. **The menu's music icon is black.** The `linklike` button (`client/menu.ts:171`) doesn't get the SVG stroke style
   that `.share-btn svg` has (`client/index.html:16`), so it draws as an unstyled black glyph. Style the icon in any
   button the same way.
5. **Lobby count** (`client/room.ts:940`): "Waiting for 1" → "1 of 2 ready" (counts only, **no player names**, the
   user's instruction).
6. **Empty spell slots:** a slot with 0 charges is dimmed and its tooltip says where charges come from ("Find
   pickups in the caves"). Starter spells (∞) unchanged.
7. **Phone header:** on a 390 px wide room page the header overflows (README is clipped). Make it fit: icon-only
   buttons under a width, or a wrap; your call, with a screenshot.
8. **Overlapping name labels:** two avatars spawning in the same place stack their labels. Offset labels that would
   overlap (render-side only), or nudge the second label up.
9. **Sandbox palette:** it scrolls off-screen with no cue (Glass, Coal, Erase hidden). Make every material reachable
   without guessing (wrap, or a visible scroll affordance).

## Part B: hover names

When the mouse rests over the world for about 200 ms, show a small label near the cursor naming what's under it:
- an **enemy** (by kind: "Slime", "Fire imp", "Acid slime", "Worm", "Deep Mage", with hp if easy), else
- a **player** (plain name), else
- a **pickup or bag or heal** (the spell name and charges, or "Heal +25"), else
- the **material** of the cell ("Water", "Lava", "Pebbles"; nothing for Empty or sky).

Read it from what the worker already has (the local sim's entities and the material grid) on the worker side, and
send a small display message to the main thread, or keep a copy main-side if that's already how the HUD works. Hit
tests use the same world coordinates the renderer uses. It must cost nothing noticeable per frame (look up only when
the pointer moves or every few frames), never send anything to the server, and hide while a key is held or during
catch-up. Not on touch devices. Test the lookup's priority order (enemy over player over pickup over material).

## Look at it

Run the real server from your worktree (`pnpm build:client`, then
`PORT=8120 DATA_DIR=/tmp/ux-data node server/main.ts`; create `/tmp/ux-data` first and remove it by that literal path
at the end). Check each item in a browser at 1280x800 and the phone ones at 390x844, with two sessions for the
lobby count, the labels and the party-fell overlay (die on purpose: walk into lava). Save before and after screenshots
of the main items to `docs/art/shots/n2-*.png`.

## Commit checklist

- [ ] Overlay exits and depth; death cause with its test.
- [ ] Badge, music icon, lobby count, empty slots.
- [ ] Phone header, labels, sandbox palette.
- [ ] Hover names with the priority test.
- [ ] `docs/research/n2-report.md` with screenshots and "Architectural decisions for review".

## The gate

`pnpm typecheck && pnpm test:net && git commit ...`. Client-only, so no determinism run; say so in the report.
