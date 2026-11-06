# Phone play report (in progress)

- Commit 1: spell bar touch (slots.ts isTap, room.ts slot handlers, index.html touch-action: pan-x).
- Commit 2: touch movement buttons (#tLeft/#tRight/#tJump in room.ts, feed `held` + sendKeys; .tbtn css).
- Commit 3: touch aim/cast reuses the canvas pointer path; a second finger now clears castHeld (pinch does not cast).
- Commit 4: forced phone spectate removed; D-209.
