# Fix H1: UI review groups 2-6

## Commits
- 02af59b group 2: no main padding, Who and zoom on the minimap row, 1 px world edge, Health/Levitate beside the hotbar, violet Levitate (#b07cff).
- 79bc339 group 3: minimap terrain silhouette, outlined viewport rectangle, coloured player dots, own dot white with ring.
- 0ff3211 group 4: gap after Push/Blast/Dig, top-left square swatch, tooltip on zero-count slots ("Found in caves").
- 89db239 group 5: README as share-btn, speaker and note SVG icons with aria-label/title, connection dot, debug text behind ?debug=1.
- 291dcfd group 6: own-avatar chevron, pickup halo, Blast cone preview (Dig preview already existed).
- Commit 6: screenshots and this report.

## Screenshots (all viewed)
- fix-h1-g2-1280.png: bar flanked by Levitate (left) and Health (right), no overlap, thin edge round the world, Who and zoom on the minimap row.
- fix-h1-g2-390.png: 390x844, HUD stacked above the bar, nothing overlapping.
- fix-h1-g3-1280.png: terrain silhouette in the minimap, outlined viewport, own white dot.
- fix-h1-g4-1280.png: gap after Dig, swatches top-left, infinity signs.
- fix-h1-g5-1280.png (?debug=1): icon buttons, green dot, debug text. fix-h1-g5-390.png: no debug text, dot only.
- fix-h1-g6-blast.png: dashed Blast cone from the avatar toward the cursor.
- fix-h1-sandbox-1280.png: only shows the name prompt (see below).

## Not verified
- /sandbox at 390x844 and past the name prompt: the sandbox needs the server (registration), none running. Only its header/footer got the shared CSS.
- Other-player dots, the amber and red connection states, the tooltip text on hover, pickup halo and the chevron up close: not screenshotted (no second client, no pickup in view). The chevron and halo are drawn but I did not inspect them zoomed in.
- The optional bar above the avatar was not built.
- Full gate (pnpm check, determinism) not run; sim untouched.

## Architectural decisions for review
1. **Layout: crisp over full-bleed.** Chose: remove main padding, keep `layout()`'s whole-number scaling. At 1280x800 the canvas is 2x (960x540), so side margins remain (480x270 is a fixed aspect and 3x does not fit). Alternative: fractional scale to fill. Why: crisp pixels were asked to win. Cost: dead margin stays at in-between window sizes; a 2x/3x stepper or a wider GAME_VIEW would use it. Also the stage now reserves 34 px of top padding (`has-mini`) for the minimap row, and `layout()` subtracts top and bottom padding.
2. **HUD beside the bar** uses a CSS grid with an 840 px middle column (the bar's width). Alternative: put HUD bars inside `#spells`. Cost: 840 and the 1150 px breakpoint are tied to 12 tiles at 62 px; adding a slot means retuning them. Below 1150 px the bars stack above and `has-bar` padding grows to 84 px.
3. **Minimap terrain.** The worker posts a new `terrain` message (client protocol only) once a second: 256x24 mask, 4x4 samples per block, ~98k reads, a 6 KB transfer. Solid = ids 1,2,3,4,6,21. It reads `matView()` and writes nothing back. Alternatives: sample every 16th column (cheaper, aliased), or read the GPU texture (stalls). Cost: ids are hard-coded in worker.ts (new solid materials need adding); the silhouette lags by up to 1 s; the mask is drawn in one fixed brown.
4. **`?debug=1`.** Shows player count, tick, step times, chunks and uploads in the header, replacing "live . N players . tick". The existing `?stats` is kept as an alias and the old `localKind !== null` auto-show was dropped, so local single-player now needs the flag too. Cost: anything that read `#info` text for "live" breaks (grep found nothing in tests or scripts); `window.__net` and `__stats` are unchanged.
5. `FromWorker` "players" list gained `rgb`, and a new "terrain" message exists; both are client-only types in `client/protocol.ts`.

## FUTURE.md suggestions
- Mini bar above the avatar on damage or levitate.
- Pick integer scale 2x or 3x by window size, or enlarge GAME_VIEW on wide windows, to cut the side margins.
- Collapse zero-count consumables until first found.
