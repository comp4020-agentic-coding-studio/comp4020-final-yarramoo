# Brief N3: skies, different in every world

**Why:** the user, 4 Nov: "make the sky something interesting, and different between worlds. Night sky, day, morning,
rainy, etc." Today every empty cell draws the same near-black (`client/materials.ts:29`, Empty `0x0b0e14`), above
ground and below it alike.

**The design (agreed):**
- Each room's sky is **picked from its seed**, so every player in a room sees the same sky and different rooms look
  different. At least four: **night** (deep blue, stars that twinkle slowly), **day** (pale blue, a soft sun glow),
  **dawn or dusk** (a warm gradient low on the horizon), **overcast with rain** (grey, falling streaks). A fifth if
  cheap (a starry aurora, a red dusk).
- **Only the open air above ground** gets the sky. In the caves Empty stays dark. A simple rule that works: a cell is
  "sky" if it is Empty and above the surface height of its column (the first non-Empty cell from the top), or use
  the existing depth band uniforms (`uBands`, `SHALLOW_TOP`) to fade the sky into darkness with depth. Your choice;
  it must not look wrong where a cave opens to the sky, and it must not show sky colour inside a closed cave.
- The sandbox (`/sandbox`, the menu's backdrop) gets a sky too, picked the same way from its seed (fixed worlds have
  fixed seeds, so a fixed sky; fine).
- **Render-only:** rain is drawn, never simulated. Nothing writes to the sim, nothing reads the sky back
  (invariants 1 and 9). Shader work, or a background pass under the cells; whichever is cleaner.
- Cheap: one extra uniform or two and a little shader maths; no per-frame CPU work over the grid. If the surface
  height is needed per column, compute it in the shader, or upload a 1-D texture only when the grid's top rows change
  (they rarely do), never per frame.
- `prefers-reduced-motion`: stars don't twinkle and rain doesn't fall (draw it still or not at all).

**Worker:** one Sonnet worker in its own worktree. Create it first:
`git -C /Users/mitch/code/courses/comp4020/comp4020-final-yarramoo worktree add /tmp/wt-sky -b sky multa`, then
`pnpm install` in `/tmp/wt-sky`. Work only there. No subagents, about 80 tool calls. Rules: `CLAUDE.md`; commits only
on a green gate chained with `&&` (never `;`, never through `grep` or `tail`); `rm` only on literal absolute paths;
**no pushing**. Your ports: vite **5181**, server **8121**; `agent-browser` sessions `sky-*`. Kill everything you
start by PID and close your sessions before finishing.

**Files you may touch:** `client/render.ts`, `client/materials.ts`, a new `client/sky.ts` if it helps, and only the
lines of `client/worker.ts` or `client/room.ts` that pass the seed or sky choice to the renderer (another worker is
editing `room.ts` tonight: keep your change there to a few lines, so the merge is easy), `tests/net/**` for the
seed-to-sky test, `docs/research/n3-report.md`, `docs/art/shots/n3-*.png`. **Not** `sim/`, `server/`, `shared/`.

## Tests

- the seed-to-sky mapping is a pure function in `client/` (or `shared/` is off-limits, so keep it client-side), and
  every sky kind is reachable from some seed; the same seed always gives the same sky;
- the renderer still compiles its shaders (a test exists for the renderer or the fx; follow its pattern if it can
  run headless; if it can't, say so and rely on the browser look).

## Look at it

`pnpm dev:client` on 5181 serves the dev routes (`/game?world=game&avatar=1&cfg=survival`, `/sandbox`); find how the
dev route picks its seed and add a dev-only `?sky=<kind>` override so you can screenshot each kind. Screenshot every
sky at the surface, one looking into a cave mouth, and the menu backdrop, to `docs/art/shots/n3-*.png`.

## Commit checklist

- [ ] The seed-to-sky mapping with its test, and the sky passed to the renderer.
- [ ] The sky drawing, surface-only, every kind, reduced motion.
- [ ] Screenshots and `docs/research/n3-report.md` with "Architectural decisions for review".

## The gate

`pnpm typecheck && pnpm test:net && git commit ...` (client-only; say so).
