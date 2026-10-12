# S4 Weather console and Kestrel-2

## Contract (header of src/engine/types.ts updated)
- `weather` role; `ValueDef.fronts {everySec, driftPerSec}` and `atT0 "explode"|"abort"|"scrub"` (default abort); State gains `fronts` and `frontIdx`.
- Fronts: `init` rolls them after all fault dice (mvp rolls unchanged), one draw per front at elapsed k*everySec, covering countdown + hold budget + 2 spare; the last rate persists. `driftPerSec` is the pre-first-front rate (use 0); the validator refuses a step setting `driftPerSec` on a front value.
- Granularity: ticks split at each front on the elapsed clock (count and hold), re-anchoring the value there; chunked-equals-one tests cover holds, resume, T-0, window close.
- Ladder: explosion > pad_abort > requirements hold > scrub(weather) > success. Deviation from the brief: scrub sits below the requirements hold, since it applies only when every requirement (launch authority) is met; otherwise the T-1 hold comes first and weather is re-evaluated on resume. Reasons: "Weather outside launch criteria at T-0", then a line per value; `scrub` event then `outcome`. Weather past its limit: "Launched into ...", explosion.
- `showing` unchanged: GO over an amber readout records caution (tested).

## kestrel2.json
300 s, 150 s budget, mvp steps/faults retimed. Weather steps `balloon_release` (after pad_clear, gates tank pressurise) and `lcc_brief` (gates poll_1). Cloud base and lightning distance drift toward nominal (storm clearing); shear is a symmetric walk. (Symmetric walks cleared only ~30% in 90 s.) Amber at some poll in ~34% of seeds, median clear 40 s. Bot (nogo on amber, re-poll and resume when clear, Flight holds if it turns after the final poll): 87.5% wins over 400 seeds, 85% without the late hold; losses are window closes or weather scrubs, no explosions.

## Server/UI
`POST /missions` takes `sequence` (registry allowlist, default mvp, unknown gives 422) ; home radio choice; client-side trend arrows; weather CSS colour. Outside the file list: `src/game/store.ts` `createMission(crewId, sequenceId)` (it hardcoded the default). history.ts needed nothing.

## Tests
+26 engine (weather.test.ts), +5 spec. All 86 existing engine tests pass untouched. `pnpm check` green twice (144 tests) on :8104.

## Browser
Two sessions, kestrel2 from the home choice, four seats, started: the Weather tab showed three gauges with arrows after ~50 s (flat for 40 s, before the first front); replay lists Weather. S4-weather.png.

## Weak spots
Some seeds stay amber past the window; untested with humans; the Weather seat cannot call a hold.

## FUTURE.md
- Weather seat can request a hold or send Flight an advisory.
- Forecast band on the weather gauge.
- Re-attempt in a later window after a weather scrub.

## Session review

Accepted the precedence change (weather scrub below the requirements hold): the
brief contradicted itself and the worker's reading is the consistent one.
Accepted the one-line `src/game/store.ts` change outside the file list; the
default sequence was hardcoded there. Re-ran: full check 144 green. Noted for
the owner: weather readouts sit flat for the first ~40 s (no front yet), which
may make the Weather seat dull at the start.
