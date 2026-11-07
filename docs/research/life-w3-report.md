# Life W3 report

## Commit 1: grass shader
FRAG gets `grassTop()` (dirt, air/plant above, within 6 rows of uSurf ground line, gated on uBands.x) used for the green top cells, a darker transition cell, and 1/2-cell blades over empty sky (sway shifts columns with sin only when uSky.y > 0.5).
Test: `tests/net/background.test.ts` "grass shader guard". Shown red by removing the `uBands.x < 0.5` gate from grassTop (failed), restored.
