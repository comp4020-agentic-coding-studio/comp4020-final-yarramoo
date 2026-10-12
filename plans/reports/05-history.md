# 05 History report

## Shipped
- `GET /missions`: In progress (code, sequence, crew by seat, started, Watch link) and Flown (newest first, 50 per page, outcome pill, date, go-on-caution count, link to replay). Server-rendered, empty states.
- `GET /missions/:code`: 302 to `/m/:code` unless done; 404 for unknown. Outcome panel, crew, then "The record" (poll reports with GO-on-CAUTION rows highlighted and labelled; faults with real/glitch, appeared, resolved), then a CSS-only marker bar and a vertical timeline.
- Nav link "Missions"; "Full replay" link in the console.js outcome panel.
- Lobby reseat fix: `reseat` now only reconnects; Take/Leave seat forms are built client-side from the `lobby` message and `data-callsign` on `#mission` (markup-only change in mission.ts).
- Read-only store queries: `eventsOf`, `seatsOfMany`, `liveMissions`, `doneMissions`, `countDone`, `goOnCautionCounts`.

## Sentence mapping
One `sentence(event)` switch on `kind`, reading ids from `data_json` and resolving them to labels from the sequence (step, poll, fault); unknown kinds fall back to "Role: kind". Role tag from `role`, null shown as "System". Steps read "Propulsion completed: Pressurise propellant tank", not a conjugated verb, since labels are imperative.

## Verified
`pnpm typecheck`; `pnpm check` green against a fresh app on :8098 (65 tests, 3 new in spec/history.test.ts). Two agent-browser sessions: h2's seat take and leave reached h1's lobby with `window.__marker` intact (no reload) and Start enabled/disabled correctly. Mission started and scrubbed; /missions and replay screenshots taken (05-missions.png, 05-replay.png, 05-replay-phone.png); at 390 px scrollWidth equals 390.

## Not verified
- The replay of a mission with polls, faults and go-on-caution rows was never rendered in a browser (only a scrub), so the highlight styling is untested visually. The counts come from `poll_report` data (`report`, `showing`), matching the engine.
- Once, my first Start click in h1 did not start the mission (a second click did); not reproduced or investigated.

## Weak spots
Dates are UTC strings. Seats shown are the current seats table (stays after done). The bar is unlabelled beyond endpoints.

## FUTURE.md suggestions
- Per-crew stats page (go-on-caution rate per callsign).
- Replay scrubber that animates the bar with a playhead.
- Shareable "blame card" image of a mission's worst GO-on-caution.

## Session review

Played a "reckless crew" mission (fix steps skipped, GO always) to T-0 in two
sessions: Propulsion reported GO on a caution twice, the vent fault was real,
and it exploded. The replay (`05-review-replay.png`) shows both reports
highlighted, the fault marked real, and a readable timeline. Fixed in review:
crew callsigns and T-times wrapped mid-word in the record table.

The "first Start click does nothing" seen here and in phase 4 is an
agent-browser quirk, not an app bug: when only the top pixel of a button is in
the viewport the tool skips scrolling and clicks its centre, off-screen.
Scroll the element into view first.

Design gap found: Ground's cross-check read ABNORMAL for the real vent fault,
yet Ground's GO was recorded as "showing NOMINAL", because `showing` counts
only a seat's own cautions and values. Taken into phase 6.
