# Brief H1: the UI review, groups 2-6 (layout, minimap, hotbar information, header, readability)

**Why:** the UI review the user pasted on 3 Nov, note 10 in `docs/playtest-2026-11-03.md` (read its full text
there). Group 1 is done (slice C, D-178). This slice does groups 2-6. **The menu overhaul (note 2) is not part of
this slice**: it waits for the user.

Read these first:
- `CLAUDE.md` (the client is render-only; "Open it and look");
- `docs/research/fix-c-hotbar-report.md` (how the hotbar and stage padding work now);
- `docs/research/fix-j-music-report.md` (the Music button).

**Worker:** one Sonnet worker. Use no subagents, and stay within about 100 tool calls. You work on `multa` directly
(no other worker is running). Rules:
- `CLAUDE.md`;
- gate on exit codes chained with `&&`;
- `rm` only on literal absolute paths;
- **no pushing**;
- stop any vite or server you start;
- use **port 5197** for vite.

Build the wasm first (`pnpm build:sim && pnpm build:sim:devpaint`, with `PATH="$HOME/.cargo/bin:$PATH"`).

**Client only:** `client/index.html` (CSS and markup), `client/room.ts`, `client/worker.ts` (drawing only),
`client/fx.ts`, `client/render.ts`, `client/spells.ts`, `client/music.ts` (button only). **Nothing in `sim/`,
`server/` or `shared/`.**

## What to change (in this order; stop at a clean commit if you run short)

### Group 2: layout and space
- **Full-bleed canvas:**
  - let the canvas use the window's width and height (less dead margin);
  - put Who and zoom as a small overlay in a corner of the stage rather than their own band;
  - keep the minimap a thin strip;
  - keep whole-number pixel scaling where the code already does (`layout()` in `room.ts`), so pixels stay crisp.
    If full-bleed fights crisp scaling, prefer crisp and say so.
- **A visible world edge:** a subtle 1 px border round the world canvas, or a sky gradient. Pick one.
- **Health and Levitate next to the hotbar:**
  - move the two bars from bottom-left to either side of the hotbar (bottom centre), one on each side;
  - they must not overlap the hotbar at 1280 x 800, nor at 390 x 844 (there they may stack above the bar);
  - optionally show a small bar above your own avatar while it takes damage or levitates (fades after about 1 s).
- **Levitate's colour:** distinct from the selected-tile accent and from Water's blue. Try a violet or teal; say
  which.

### Group 3: the minimap
- Draw the viewport as an outlined rectangle, not two tick lines.
- Draw a thin terrain silhouette: sample the world's solid cells per column at low resolution. It's render-only;
  use the `mat` view the worker already has, throttled (for example once a second), never per frame on the full
  grid.
- Draw other players as coloured dots (their player colour). Your own dot is distinct.

### Group 4: hotbar information
- **Separate the infinite tools** (Push, Blast, Dig) from the consumables with a small gap or divider.
- **Swatches:** the coloured underline is there. Make it a small square swatch at the tile's top-left, or keep the
  underline and thicken it. Your call.
- **Explain zero-count slots:** a `title` tooltip such as "Found in caves" (or the real source, if spells.ts knows
  it). Don't hide slots.

### Group 5: the header
- **One button style:** README matches the Share, Sound and Music buttons.
- **Speaker icons:** Sound shows a speaker icon (on) or a muted speaker (off), with `aria-label` and `title`
  ("Sound on, click to mute"). Music gets a note icon, on and off, the same way. Use inline SVG or Unicode,
  **no image files**.
- **Connection status:** replace "live" with a small green dot (amber while catching up or reconnecting, red when
  rejected) and a `title` with the text. Drop "tick N" and "N players" from the header (Who (N) already shows
  the count). Keep the tick, step times and chunks visible behind `?debug=1` for development.

### Group 6: game-world readability
- **Mark your own avatar:** a subtle outline or accent (for example a 1-cell light outline, or a small marker
  above the name tag) so you stand out among other players.
- **Pickups:** check their current draw (they already pulse). Make them easier to spot at 1x: a soft glow or a
  slightly larger halo. Keep it cheap.
- **Brush preview:** check whether Blast and Dig already draw a radius outline under the cursor (`placeDigPreview`
  exists). Add one for Blast if missing, matching Dig's style.

## Verify (required)

- `pnpm typecheck` and `npx vitest run --config vitest.net.config.ts tests/net/avatar.test.ts tests/net/spells-table.test.ts`.
- **The browser look:**
  - vite on 5197; open `/game?world=game&avatar=1&cfg=survival` and `/sandbox` in
    `agent-browser --session h1` (through `zsh -ic`), at **1280 x 800** and **390 x 844**;
  - screenshot each group's change; **look at each one before citing it**;
  - check that no part of the world is hidden behind the HUD and that nothing overlaps at either size;
  - save to `docs/art/shots/fix-h1-*.png`;
  - close the session and kill vite by PID.

## Commit checklist (commit each separately)

- [ ] 1. Group 2: layout, world edge, HUD beside the hotbar, Levitate colour.
- [ ] 2. Group 3: minimap.
- [ ] 3. Group 4: hotbar grouping, swatches, tooltips.
- [ ] 4. Group 5: header buttons, icons, connection dot, `?debug=1`.
- [ ] 5. Group 6: own-avatar marker, pickup glow, Blast preview.
- [ ] 6. Screenshots and your report.

Gate per commit: `pnpm typecheck && npx vitest run --config vitest.net.config.ts tests/net/avatar.test.ts tests/net/spells-table.test.ts && git commit ...`
(the session model runs the full gate before pushing).

End each commit message with a blank line, then `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report

Write `docs/research/fix-h1-ui-report.md` as you go. It should cover:

- per commit: the hash and what changed;
- which screenshot shows what;
- what you couldn't verify;
- "Architectural decisions for review": the layout approach (full-bleed vs crisp scaling), how the minimap samples
  terrain (and its cost), and the `?debug=1` flag. For each: what you chose, the alternatives, why, and what it
  costs later.
- FUTURE.md ideas, suggested only.
