# 04 Consoles report

`pnpm typecheck` and `pnpm check` (62 tests) green against a fresh app on :8095. Nothing committed; `public/mission.js` removed via `git rm` (staged).

## Pages
- **Home**: pitch plus callsign form; with a callsign, how-to-play paragraph, "Start a mission", "Join by code", and the server's existing "your open missions" list (no free-seat list: the server does not provide one). Title duplication fixed in `layout.ts`.
- **Lobby**: huge code, Copy link, three seats with holders and Take/Leave (full-page POSTs), fill note, Start button (disabled until all seats filled). Live from the `lobby` message; `reseat` in lobby does `location.reload()`.
- **Console**: header (countdown, phase badge, holds), cautions, telemetry gauges (limit band amber, nominal green, marker), cross-checks, steps (Do it button when ready, waiting-on text), polls (flight Open/Re-poll; others GO/NO-GO), flight checklist and HOLD/RESUME/SCRUB (scrub confirms). Several roles: grid at 900px+, tabs below.
- **Outcome**: SUCCESS/EXPLOSION/SCRUBBED panel with reasons, poll record (GO-on-caution rows highlighted) and fault truth table when `debrief` is present.

## Countdown
`tMs` and phase from the latest message, then advanced by `performance.now()` only in `count`, redrawn every 100 ms on every `.countdown` element, independent of console re-renders (which skip when the HTML string is unchanged).

## Verified (agent-browser, sessions a and b)
Callsigns, mission, seat updates reaching the other browser live, start, both consoles rendering, countdown running, B pressing a step and A's checklist showing DONE, HOLD pulse animation, scrub then outcome panel on both. Screenshots: `plans/reports/04-lobby-a.png`, `04-a.png`, `04-b.png`, `04-a-phone.png` (390 px: no horizontal scroll, no button under 44 px), `04-outcome.png`. No JS errors reported.

## Not verified
Polls (GO/NO-GO, Re-poll), faults and cautions, explosion/success outcomes and the debrief table with data, observer view, reconnect indicator, reduced-motion, T+ display.

## Weak spots
- Console HTML rebuilds when a value changes (about 1 Hz while drifting); a click straddling a rebuild could be lost.
- A page loaded as observer does not become a seat-holder without reload (by design).
- Duplicate hidden `_csrf` inputs on the page (same token).

## FUTURE.md
- Free-seat open lobbies list on home.
- Patch the DOM instead of replacing innerHTML.
- Sound cue on caution and poll open.

## Session review (play-through)

The session played a full mission in two `agent-browser` sessions (kestrel:
flight + ground, wren: propulsion) on a fresh data dir. Seats appeared live
across browsers, both polls ran, a ground fault appeared and was fixed, and the
launch succeeded at T-0 with the debrief on both browsers
(`04-review-outcome-a.png`, `04-review-outcome-b.png`).

Fixed in review: each console's HTML included the countdown text, so every
push rebuilt the whole console, buttons included, and a press straddling a
rebuild could be lost. Consoles now render as slots and only changed slots are
rebuilt; the clock is drawn separately. Verified that the steps slot keeps its
DOM node across pushes.

Noted, not fixed: on a `reseat` message the lobby reloads the whole page, which
can swallow a click made during the reload (the test tool tripped on it).
