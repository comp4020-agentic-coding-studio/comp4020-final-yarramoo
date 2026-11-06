# Sky report

Changed (client/render.ts only): ground line = solid minus plants (Wood/Seed/Stem/Flower), so gas, smoke, steam, fire,
liquids and plants never make ground; shafts (>12 below both rims within 64 columns) take the lower rim; below the
line a dim back wall in the depth-band colours (brown, grey, blue-black) with two-scale hash noise. Draft reviewed and
kept unchanged: colours judged fine in the shots, no tuning. tsc clean. No client test touches the renderer.

Screenshots (docs/research/shots/):
- sky-1-gas.png: gas painted at the top rows above spawn; sky stays sky (a green wisp at top, no black bars).
- sky-2-shaft.png: Empty column dug beside spawn; narrow dark cave wall inside the dirt, no sky, no rim notch.
- sky-4-deepshaft.png: deep shaft down into the grey band and the deepest band; wall is dark grey and the terrain in
  front is clearly lighter; deep band reads blue-black. Existing caves in the earlier shot show brown wall in dirt.
- Sandbox: NOT captured (the local vite has no server, registration 404). The sandbox path is untouched (uBands.x < 0.5
  takes the sky branch), so it is all sky by construction.
- Trees: visible in sky-1/sky-2, sky shows between branches.

updateSurface cost: not measured. It now scans 128 extra columns plus 2x64 min reads per visible column (about
1000 columns x 128 = 130k reads) at 5 Hz: roughly doubles the old ~100k byte reads; still trivial but unmeasured.

## Architectural decisions for review
- Ground = MATERIAL_CLASS "solid" minus a hardcoded plant id set {6,7,8,9}. Alternative: a class for plants in
  shared/names.ts. Chose client-only; cost: ids must be kept in sync if materials are renumbered.
- Shaft closing by rim heuristic (depth 12, reach 64) rather than a flood fill from the sky. Cheap, but a wide pit
  (>128 columns) or an overhang shows sky/dark inconsistently; an open-sided cliff cave is still dark. Flood fill
  from the top would be exact but costs more and needs a texture rebuild.
- Back wall is a pure function of depth and cell hash (no per-world data), so it never needs sim state.

## FUTURE ideas
- Flood-fill sky mask from the top rows for exact "open to sky" semantics.
- Add a "plant" MaterialClass in shared/names.ts instead of the id set.
