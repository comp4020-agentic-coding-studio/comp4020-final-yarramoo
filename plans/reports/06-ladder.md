# 06 Outcome ladder

## Contract changes (header of src/engine/types.ts updated)
- `Outcome.kind`: success | scrub | pad_abort | explosion.
- `FaultDef.severity` ("abort" | "explode"), required by the validator.
- `Sequence.holdBudgetSec` (required, > 0); `State.holdMs` (total ms in hold).
- `scrub` action takes optional `reason`. Server abandonment passes "Crew lost contact" (the one rooms.ts line). mission.ts allowlist untouched, so clients cannot set it.
- Events: `window_closed` then `outcome`; `scrub` events now carry `data.reason`.
- `showing` is "caution" also when a cross-check readout on that console is abnormal (active, real, unresolved fault).

## Precedence at T-0
explosion (value past limit, or real unresolved "explode" fault) > pad_abort (real unresolved "abort" fault, or value outside nominal but inside limit) > automatic hold at T-1 s for unmet requirements > success.
Window: in hold, the interval is split where holdMs reaches the budget; mission ends as scrub "Launch window closed after N hold(s)". Hold-at-T-0 time counts too. A snapshot without `holdMs` is treated as 0.

## Tests
68 engine tests (all green). Changed: one expectation, Ground's `showing` in the poll test is now "caution" (the intended semantic change). Added: cross-check showing (abnormal, glitch, fixed), abort, explode, swapped severities, glitch/fixed do not abort, caution-band value, limit beats caution band, pad abort beats unmet-requirements hold, window close (+ across holds, + T-0 holds), window granularity independence (chunked ticks equal one tick, lastNowMs stops at close), validator, scrub reason. Full `pnpm check` green (79) against a fresh app on :8099.

## mvp.json
holdBudgetSec 120; vent_stuck "explode"; bus_sag "abort". Bus sag drift changed -0.05 to -0.02 V/s: at -0.05 it fell past the 24 V limit and exploded, making "abort" unreachable; now it ends at 25 to 26 V (caution band). No third fault added (it would have disturbed the seed-scanning tests).

## Rendering
PAD ABORT (amber) in console.js outcome panel, history pills, outcome panel; history timeline sentences for pad abort, window_closed, scrub reasons; style.css appended (.outcome/.verdict.pad_abort, window_closed tick).

## Weak spots
- Not viewed in a browser. 120 s of hold may be tight or generous; untested with humans.
- Glitches that are fixed late still cost nothing; a seat's caution-band value without a fault only aborts at T-0.
- Crew-lost-contact scrub is indistinguishable from a Flight Director scrub in history except by reason text.

## Session review

Added in review: the launch window closed silently, so every view now carries
`holdLeftMs` and each console header shows "window Ns of hold left".
Checked in a browser: it counts down during a hold (120 → 115 s over 5 s) and
stops on resume. The pad abort rendering was not seen in a browser; it is a
label and colour change on paths already played in phases 4 and 5.
