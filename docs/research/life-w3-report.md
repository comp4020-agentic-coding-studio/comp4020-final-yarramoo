# Life W3 report

## Commit 1: grass shader
FRAG gets `grassTop()` (dirt, air/plant above, within 6 rows of uSurf ground line, gated on uBands.x) used for the green top cells, a darker transition cell, and 1/2-cell blades over empty sky (sway shifts columns with sin only when uSky.y > 0.5).
Test: `tests/net/background.test.ts` "grass shader guard". Shown red by removing the `uBands.x < 0.5` gate from grassTop (failed), restored.

## Commit 2: ambient layer
`client/ambient.ts` (`Ambient`: own pool cap 120, <=3 spawns/frame, <=40 sampled cells inside the camera rect; leaves, butterflies (cap 6, day/dawn), fireflies (cap 25, sky 0/4 above ground near plants, any sky near Moss/Mushroom), drips (stop at a solid cell)). Wired in `worker.ts` (`applySky` -> setSky/setReduced; ground line kept in `ambientSurf`; update+toRects after `spellFx`, before `fx.toRects`' later push). Reduced motion spawns nothing.
Tests in `tests/net/ambient.test.ts`, each shown red by mutation then restored from a copy: cap (cap raised to 5000: first run stayed green because the fixture was too sparse to reach 120, so a dense-canopy test was added and then failed red), reduced-motion check removed, night gate on fireflies removed, drip solid-cell check removed. Not shown red: the spawn-inside-view assertion (only checks fresh particles' origin column; weak).

## Cut
Shrub sway (out of scope), sounds. Butterfly/firefly spawn sampling is simple, not clustered.

## Architectural decisions for review
- Ambient is its own class and pool, not `Particles`: spells never lose slots; cost is a second update loop. Easy to delete.
- Grass is shader-only (no cells): reversible, sim never sees it; cost is that blades can appear over cells avatars stand in.
- Ambient uses `Math.random` (cosmetic, injectable in the constructor for tests).
- Ground line kept in a worker variable `ambientSurf` next to the renderer's copy (reset on world change).
