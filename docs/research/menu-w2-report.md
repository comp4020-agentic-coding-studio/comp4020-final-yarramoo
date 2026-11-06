# W2 report: menu screens and routing

Spend: start $132.38 (week total), end $133.92 (about $1.55 for this slice).

## Commits
1. `5572a29` router (pure parse/format/parent) + test. Red first against a stub returning the title for everything:
   `Tests 8 failed | 3 passed (11)`. Green after implementing: `11 passed`.
2. `1ed444d` title screen, top strip, players live, death log; `client/menu/live.ts` (relTime, deathLine via
   `formatDeath`, visibility-aware poller, fetchLive), `client/menu/screens.ts`, `client/menu.ts` rewritten around the
   router, screen rules in `client/menu.css`. relTime and deathLine tests added (`13 passed`).
3. `86bb666` types screen, themed Survival/Deathmatch settings, create flow (public goes in, private to share).
4. `1ac4aed` share screen and join screen.
5. This commit: phone/landscape shots and the report.

## What each screen does
- Title: wordmark at an integer scale 3..8 (about 80% of the viewport), tagline, New game / Join game slabs, players-live line
  with a blinking dot (static when 0 players), death log (5 newest, older lines fade to 0.5 opacity, new lines slide
  in, `aria-live="polite"`), `/api/live` polled every 5 s, paused while `document.hidden`, immediate on becoming visible.
  A failed or 404 fetch hides both the stat and the log.
- Types: three real-button cards. Survival and Deathmatch show "Desktop to play" on coarse+narrow screens.
  Sandbox goes through `ensureName` to `/sandbox`.
- Settings: room name, S/M/L pressed-button group from `SIZE_DIMS` with the plain-language line, steppers
  (Deathmatch respawn 1-10, max players 2-8), Public/Private segmented control with its explanatory line, Advanced
  `<details>` with every `CONFIG_FIELDS` number input kept in sync. Survival: dark descent gradient and a moss depth
  gauge down the left edge. Deathmatch: lava accents and a hazard-stripe edge.
- Share (`#share/<CODE>`): code in 44 px, read-only link field, Copy link (clipboard, execCommand fallback, "Copied!"
  1.5 s), Enter room (via `ensureName`), Back. Reload shows it again.
- Join: All/Survival/Deathmatch toggles, live list (5 s poll only while shown and visible), empty state with New game,
  "Have a code?" box with the old validation and messages. Room names go in with `textContent`.
- Routing: `""`, `#new`, `#new/survival`, `#new/deathmatch`, `#join`, `#share/ABC123`; unknown hashes and bad codes
  go to the title. Focus moves to each screen's heading. Escape on a non-title screen is Back.

## Verification
- Before each commit: typecheck, `menu-router`, `menu-room`, `imports` net tests green, commit gated on the exit code.
- Browser (agent-browser on :8091): a public deathmatch room created from the UI went straight to `/r/62VJ7S`; a private
  survival room went to `#share/FH73MG`, and the copy button showed "Copied!". The name sheet appears on first create
  and Escape cancels it. Keyboard: Tab order is sensible, focus lands on the heading after each route change, Escape
  walks settings -> types -> title, and a deep link `#new/deathmatch` then Escape goes to `#new` then `/`.
- Screenshots: `docs/research/shots/menu-w2-{title,types,deathmatch,share,join}-{1280,390,844}.png` and
  `menu-w2-survival-1280.png`. `scrollWidth` equals the viewport width at 390 (no horizontal scroll).
- Fixes made from the screenshots: a white box round the logo was the programmatic-focus outline on the heading
  (suppressed for `[data-focus]`); `[hidden]` was overridden by `display:flex`, so the live line and log showed empty
  (added `.mn [hidden]{display:none!important}`); the oldest death line was unreadable (fade floor now 0.5); stepper
  buttons enlarged from 11 px to 22 px; share code letter-spacing tightened; removed an unverifiable "room stays up"
  sentence; panel padding tightened at 390 px.
- The title shots at 1280/390/844 use a mocked `/api/live` (6 deaths) injected from the console, because the real
  server had none. The mock is not in the code. The backdrop looks dark in the 390 and 844 shots only because they were
  taken about 1 s after load (it fades in over 1.2 s); the 1280 shots show it.
- Not verified: the touch variants ("Watch", "Desktop to play": no coarse pointer emulated), the reduced-motion path
  (CSS only), the real slide-in of a new death (needs live deaths), and the screens against the real `/api/live` with
  deaths in it.

## Architectural decisions for review
1. **Hash routing with a depth counter in `history.state` (`mnDepth`).** Back uses `history.back()` only when the previous
   entry is ours, else `replaceState` to the parent. Alternatives: History API paths (needs server routes), always set the
   parent hash (leaves duplicate entries). Cost: the depth is inferred from a flag set by our own `go()`, so a manual hash
   edit can leave it off by one.
2. **Screens are plain DOM builders in `client/menu/screens.ts`, no framework**, each returning a cleanup (pollers, timers).
   Alternative: innerHTML templates (rejected: user strings). Cost: verbose, one 400-line file; split per screen later.
3. **One `cfg: RoomConfig` plus view widgets kept in sync by `sync()`**; the Advanced inputs stay the complete config
   surface. Cost: two-way sync code for size, max players and respawn.
4. **The Deathmatch preset still lives in screens.ts** (it was in the old menu.ts, size 1), not in `shared/room.ts`.
   Moving presets to shared is a later cleanup.
5. **Respawn stepper is 1-10** as briefed, while `CONFIG_FIELDS` allows 0-30 (Advanced can still set those).
6. **The name sheet is restyled with `mn-*` classes and has a Cancel button** (the old one closed on backdrop click only);
   Escape cancels it, and the screen-level Escape handler skips while it is open.
7. **`menu.css`: screen rules added below the primitives; tokens and primitives unchanged.** `menu.ts` imports
   `./menu.css` itself. The old `.menu*`, `.cards`, `.sheet`... rules in `index.html` are now dead until the lead's cleanup.
8. **`startPoll` is visibility-aware and non-overlapping**, shared by title and join. A hidden (headless) tab never
   polls, which is a trap when mocking; override `document.hidden` as I did.
9. **Death-log lines are built by `formatDeath` with a synthetic victim 1 / killer 2 mapping**, so wording stays identical
   to the in-game feed, and names go in with `textContent`.

## FUTURE.md ideas
- Remember the last type, size and visibility per browser and preselect them.
- A "same settings again" button on the share screen.
- Show world size and max players in Join rows.
- A net test with a fake `/api/live` fixture covering the death-log slide-in and the 404 path.
- Split `screens.ts` per screen once the backdrop slice lands.
