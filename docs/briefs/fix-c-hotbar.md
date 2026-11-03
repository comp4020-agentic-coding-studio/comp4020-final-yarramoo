# Brief C: hotbar fixes that block play

**Why:** 3 Nov playtest notes 15 and 10, group 1 (`docs/playtest-2026-11-03.md`). The hotbar has five problems:
- it covers the bottom of the canvas, and its tiles are see-through;
- it wraps (Black Hole sits alone on a second row);
- labels and counts are clipped;
- only 1-9 have keys;
- slots can't be clicked.

Q/E already cycle through the bar, but nothing on screen says so. Read `CLAUDE.md` (the client rules, and
"Open it and look").

**Worker:** one Sonnet worker. Use no subagents, and stay within about 70 tool calls. You work in the worktree
`/tmp/wt-hotbar` on branch `fix-c-hotbar`. Another worker is changing `sim/` on `multa` at the same time, so
**touch nothing outside the files listed below.** Rules:
- `CLAUDE.md`;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- stop any vite you start;
- use **port 5193** for vite (`npx vite --config client/vite.config.ts --port 5193 --strictPort`), because other
  ports may be in use.

Build the wasm in the worktree first: `pnpm build:sim && pnpm build:sim:devpaint` (with
`PATH="$HOME/.cargo/bin:$PATH"`).

## What to change (client only: `client/index.html` CSS and markup, `client/room.ts`, `client/spells.ts` if needed)

1. **Clickable slots:** clicking a slot selects it (`selectedSpell`), exactly like its key, and updates the
   dig preview and the bar. Slots are currently `div`s inside a `pointer-events: none` container
   (`#spells`). Make the slots themselves receive pointer events. A click on a slot must **not** also cast or
   paint into the world beneath. Check the canvas pointer handler in `room.ts` and stop propagation, or check
   the target.
2. **Keys past 9:** slot 10 = `0`. Slots 11 and 12: use `Shift+1` and `Shift+2`. **Don't** take `-` and `=`, which
   are zoom. Show each slot's key on the slot (for example "0", "⇧1", "⇧2"). The bar has 12 slots (`BAR` in
   `client/spells.ts`). Make the mapping general so a 13th slot gets `Shift+3`.
3. **A Q/E hint:** a small label at the right end of the bar ("Q/E"), dim, plus the room's hint text
   (`room.ts`, the "Move: WASD..." line) mentioning "1-0, Q/E or click to pick a spell".
4. **One row, no clipping:**
   - the bar must be one row at 1280 x 800 with all 12 slots; drop `flex-wrap`;
   - shrink the slots to fit, with a smaller font or shorter labels if needed. Long names (Acid Flask, Oil
     Flask, Lava Flask, Black Hole) may become two short lines **inside** a taller tile, or be abbreviated
     ("Acid", "Oil", "Lava", "Hole"), with the full name in a `title` tooltip. Your call; say which;
   - the count must never be cut off or overlap the key;
   - use "∞" instead of "inf";
   - at phone width (390 px), the bar may scroll horizontally inside itself (`overflow-x: auto`) rather than
     wrap.
5. **No covering the world:**
   - make the tiles opaque;
   - reserve the bar's height **below** the canvas, so no row of the world is hidden. The canvas sits in
     `#stage` inside `main`; look at how it's sized in `room.ts` and the CSS;
   - the Health and Levitate HUD (`#hud`, bottom left) must stay visible and not overlap the bar;
   - keep it simple: a bottom padding on the stage equal to the bar's height in avatar rooms is fine.

## Verify (this slice's acceptance check)

- **Unit-level:** add a small test if there's an existing client test pattern for the bar. Otherwise
  `pnpm typecheck` plus the browser look.
- **The browser look, required:**
  - in the worktree, run vite on 5193, then open
    `http://localhost:5193/game?world=game&avatar=1&cfg=survival` with
    `agent-browser --session hb` (viewport 1280 x 800 first; run through `zsh -ic`);
  - screenshot the bar; click slot 12 and screenshot; press `0` and screenshot; press `Shift+2`;
  - use `__devGoto(4)` to collect a pickup so a count shows;
  - also screenshot at 390 x 844;
  - **look at each screenshot before citing it.** Save them to `docs/art/shots/fix-c-*.png`;
  - at the end: close the session, and kill vite by PID.

## Gate

```sh
pnpm typecheck && npx vitest run --config vitest.net.config.ts tests/net/avatar.test.ts tests/net/spells-table.test.ts && git commit ...
```

(Client-only: the session model runs the full gate when merging.)

## Commit checklist (commit each separately)

- [ ] 1. Clickable slots, keys past 9 with labels, the Q/E hint.
- [ ] 2. One row, opaque, no clipping, ∞, reserved space below the canvas.
- [ ] 3. Screenshots and your report.

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/fix-c-hotbar-report.md`. It should cover:

- per commit: the hash and what changed;
- the screenshots you looked at;
- what you couldn't verify;
- "Architectural decisions for review": the key mapping, how the canvas reserves space, and how a click on a
  slot is kept out of the world. For each: what you chose, the alternatives, why, and what it costs later.
- FUTURE.md ideas, suggested only (the rest of the UI review, group 2 onward, is already planned).
