# N3: skies

Each room's sky is picked from its seed (`client/sky.ts`, `skyForSeed`: a 64-bit mix mod 5), so a room looks the same
to everyone and rooms differ. Kinds: night (twinkling stars), day (sun glow), dawn (warm horizon gradient), rain
(grey, falling streaks), aurora (stars plus drifting green/violet bands). The sandbox and the menu backdrop (seed 7)
get one the same way. Dev only: `?sky=<kind>` forces one. Client-only; `sim/`, `server/`, `shared/` untouched.

Screenshots: `docs/art/shots/n3-{night,day,dawn,rain,aurora}.png` (surface, with a cave mouth in each frame),
`n3-menu.png` (menu backdrop, rain).

## How it draws

In `client/render.ts` the fragment shader's empty-cell colour `bg` is replaced by `skyColor()` where the cell is
"sky". In a game world a cell is sky when it lies above its column's surface; in the sandbox every empty cell is.
Surface heights are a 1-D `R16UI` texture (`uSurf`) built on the CPU for the visible columns only, refreshed about
5 times a second or when the window moves sideways (about 500 columns x up to a few hundred rows of reads, no per-frame
cost). Stars and rain are hashed from the screen cell, so they stay put as the camera moves and nothing is simulated.
`prefers-reduced-motion` sets `uSky.y = 0`, which freezes time inside the sky only.

## Architectural decisions for review

1. **Sky is a screen-space function inside the existing shader**, not a separate background pass. Alternative: a
   second program drawn under the cells. Chosen: one draw, one uniform pair. Cost: sky effects cannot be blended
   with translucent cells except through `bg` (steam and smoke already use `bg`, so they pick the sky up for free).
2. **Surface = first cell with three solid cells below it in a column**, so a falling grain or a flying fragment
   does not pop sky into the cave. Cost: a floating ledge thinner than 3 cells is treated as sky, and a column with an
   overhang counts the overhang as the surface (the cave beneath stays dark, which is the wanted look). The
   surface refresh lags by up to 200 ms after digging a new roof/hole: a deliberate trade for no per-frame scan.
3. **The sky choice rides the existing worker `init` and `world` messages** (`sky`, `reduced`, `skyMotion`), in the
   fewest lines of `room.ts` (one in `base`, one in the `world` case for the main-thread fallback).
4. **Seed hash in `client/`**, because `shared/` was off limits. If the server later needs the sky (a lobby card), move it.
