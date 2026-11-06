# Phone play: touch controls and a scrolling spell bar (branch `phone-play`, D-209)

Client-only. No edits under `sim/`, `shared/protocol*` or `server/`. Touch produces only `keys` and `cast` messages.

## What changed
- `client/slots.ts`: `isTap` (release within 10 px and 300 ms, same slot). Tested in `tests/net/slots.test.ts`.
- `client/room.ts`: slot handlers (touch press picks nothing, a tap on release picks; mouse path unchanged); the selected tile is scrolled into view only when the selection changes; `sendKeys()` also reads `touch-left/right/up` from `held`; three buttons built on a coarse pointer, one pointerId set each; a second finger clears `castHeld`; the forced phone spectate is gone (`?spectate=1` stays).
- `client/index.html`: `touch-action: pan-x` on `#spells`; `.tbtn` styles (60 px, 68 px for jump, bottom 92 px so they clear the HUD and bar).
- `docs/DECISIONS.md`: D-209 overturns D-011.

## Verified (Playwright iPhone 12 emulation with CDP `Input.dispatchTouchEvent`, real touch events; agent-browser has no touch gestures, only `set device`)
- Dev route 390x844: swipe on the bar moved `scrollLeft` 0 to 182 of 556 (`phone-play/ph-port-2-swiped.png`); a tap on the 6th slot moved the selection 0 to 5 (`ph-port-3-tap.png`); right and jump held together moved x 555.5 to 584.5, y 116 to 108, both buttons lit (`ph-port-4-walkjump.png`).
- Real Survival room on :8092, desktop plus phone: no "spectating" text; lobby Ready tapped on the phone; phone walked and jumped and the desktop shows it (`ph-room-port-walkjump.png`, `ph-room-port-desktop.png`); server `input.summary` for the phone shows `casts: push:5` and `pos` inputs, 0 rejected; `hash_fail_w*` stayed 0 in every `process.minute` line.
- Landscape 844x390: lobby, buttons, HUD usable (`ph-room-land-lobby.png`, `ph-room-land-walkjump.png`). The hotbar is partly under the controls hint toast for its first seconds.

## Not testable without a real phone
Thumb ergonomics and button size; iOS Safari behaviour (`touch-action`, pointer capture, rubber-banding, address-bar resize); multi-touch on real hardware; held-cast frequency and battery; my cast-cancel-on-second-finger check printed 0 casts because I read WebSocket frames as strings (they are binary), so that one is code-reading only, plus the server count above for plain casts.

## Architectural decisions for review
1. Buttons write into the keyboard's `held` set (synthetic names `touch-*`) so one `sendKeys` serves both. Alternative: a second state object. Cost later: any code that clears `held` also releases touch buttons (blur, hidden do this on purpose).
2. Touch aim is the finger's position (no virtual stick). Alternative: a drag-aim stick or auto-aim. Cost: a thumb covers its target.
3. Buttons only exist when `(pointer: coarse)` at load (not re-evaluated; a hybrid laptop that switches modes would need a reload).
4. Slot selection into view only on change, so a manual swipe is never fought.
5. Fixed pixel button positions, not scaled to the viewport.

## FUTURE.md ideas
Floating left stick; auto-aim assist; dedicated jump-hold for levitate indicator; dismiss the controls hint toast on first touch (it covers the bar on a phone).
