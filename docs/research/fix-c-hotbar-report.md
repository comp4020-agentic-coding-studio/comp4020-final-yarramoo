# Fix C: hotbar

## Commits
See `git log fix-c-hotbar`. Commit 1: room.ts (clickable slots, keys 0 and Shift+digit, Q/E hint, hint text, short names, infinity sign, stage reservation in `layout`). Commit 2: index.html CSS (one row, opaque, padding). The two files are interdependent, so the split is by file, not by feature. Commit 3: screenshots and this report.

## Screenshots (all viewed)
- fix-c-1280-bar.png: 12 slots in one row, opaque, keys 1-9, 0, shift1, shift2, "Q/E" at right; HUD bottom-left clear; canvas ends above the bar.
- fix-c-click-slot12.png: after clicking slot 12 (Hole) it is highlighted; no cast into the world.
- fix-c-key0.png: `0` selects Wall (slot 10).
- fix-c-shift2.png: Shift+2 selects Hole (slot 12).
- fix-c-pickup-count.png: after `__devGoto(4)` and pressing 6, Fire shows count 10, not clipped; infinity sign on Push/Blast/Dig.
- fix-c-390.png: 390x844, bar scrolls horizontally inside itself, HUD sits above it.

## Not verified
- A click on a slot not casting was checked by structure (slots are siblings of the canvas, pointerdown stops propagation) and by no visible cast; I did not assert the sim input stream.
- Dual-tools (Creative) room not opened; same code path (setBarHidden).
- Shift+digit uses e.code, so non-US layouts that move digits are untested.

## Architectural decisions for review
1. **Key mapping.** `digitSlot(e)` reads `e.code` (`Digit0-9`): plain digit n = slot n-1, `0` = slot 10, Shift+n = slot 10+n (general; a 13th slot gets Shift+3). Alternative: `e.key`, but Shift'd digits give "!" and "@" and vary by layout. Cost: physical-key semantics (AZERTY users press the shifted keys that the layout puts on that physical key).
2. **Reserved space.** `setBarHidden` toggles `.has-bar` on `#stage`, giving it 58px bottom padding; `layout()` subtracts the computed padding from the fit height. Alternative: put the bar outside the stage in the flex column. Chose padding as the brief suggested; cost: the 58px is a CSS constant that must match the tile height (46 + borders + gap), and a ResizeObserver on the stage does not fire on padding change alone in every case (it does fire since content box shrinks).
3. **Click kept out of the world.** Slots are children of `#spells`, a sibling of the canvas, so canvas pointer handlers never see the event; the slot handler also stops propagation and prevents default. `#spells` no longer has `pointer-events: none`, and spans the stage bottom (`left/right: 8px`), so it also blocks clicks in the gutters beside tiles (small cost, acceptable). Alternative: target check in the canvas handler.
4. **Labels.** Abbreviated (Acid, Oil, Lava, Hole) with full name in `title`; chosen over two-line tiles to keep tiles short.
5. **Empty slots** no longer use opacity (would show the world through); they use a darker opaque background and dim text.

## FUTURE.md suggestions
- Show cooldown/ready state as a number or glow on the selected slot.
- Remappable slot order / drag to reorder the bar.
