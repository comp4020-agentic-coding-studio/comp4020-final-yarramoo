# S6 Range Safety and ascent (Kestrel-3)

## Contract (header of src/engine/types.ts documents all of it)
- Role `range` ("Range Safety"). `Sequence.ascentSec?`, `Sequence.anomalies?: AnomalyDef[]`; Phase `ascent`; Outcome kinds add `terminated`, `range_violation`; action `terminate`; State `anomalies`; views get `terminateAvailable` (range, ascent only) and static `ascentSec`; debrief `anomalies`.
- A good T-0 with `ascentSec` emits `liftoff` and runs on as T+; otherwise ends as before. Hold/resume/scrub/step/poll are refused in ascent.
- Anomalies are rolled after faults and fronts (3 draws each). Real: +driftPerSec forever. Glitch: +rate for 8 s, -rate for 8 s, then flat (triangle, peak = 8 x rate, validator keeps it inside the limit). Granularity-independent because ticks split at activation, +8 s, +16 s, and at the real crossing (found in whole ms), re-anchoring each time, like fronts.
- Precedence in ascent: range_violation (value reaches limit), then success at T+ascentSec, both before an action at that instant (apply ticks first, so terminate at the crossing ms is "the mission is over").

## Agency
`terminated`: -300, rocket lost; +3 "Range made the call" if a real anomaly was active, else -5 "Healthy vehicle destroyed". `range_violation`: -500, -25, rocket lost, pad -10. `consequences(outcome, reports, truth?)` takes `{anomalyReal}`; agency.ts derives it from state.

## kestrel3.json
kestrel2 plus range steps (hazard_clear after pad_clear; fts_arm after hazard_clear and ground's range_confirm), range in both polls, ascent 60 s, one anomaly T+5..40 (0.6/0.5, 0.5 km/s, cross-check on propulsion). Real anomaly crosses +-8 km 16 s after appearing. I softened the weather fronts slightly (ceiling min -5, lightning [-0.1, 0.4]); with kestrel2's, only 87.5% of seeds avoided a closed window.

## Tests
+37 engine (range.test.ts), +5 spec (spec/range.test.ts), +3 agency rules. Existing tests untouched. Bot (weather-aware, terminates only when propulsion reads abnormal): 400 seeds, 350 lift off, all 350 succeed or terminate correctly; 93.75% overall (losses are closed launch windows).

## Verified
typecheck; engine 152 green; `pnpm check` green twice on fresh :8106 (193 tests). Two browser sessions seated five roles, started, range console rendered (S6-range.png). Ascent UI (T+ clock, TERMINATE with confirm, outcome panel, debrief) checked in jsdom against real engine views, not in a real browser.

## Outside the file list
`src/routes/mission.ts` (add `terminate` to the action allowlist; without it the button cannot work) and `src/routes/crew-pages.ts` (two outcome labels).

## Weak spots
Not flown to T+ in a real browser. Terminate confirm is `window.confirm`. A glitch's value returns to 0 after 16 s, a hint to a patient range officer. Replay timeline bar now scales to the end of ascent.

## Session review

Accepted both out-of-list edits (`terminate` in the action allowlist, which
still goes through the seat check and the engine's range-only check; two
outcome labels on crew pages). Kestrel-1 and Kestrel-2 data are unchanged.
Re-ran: full check 193 green. Not done by anyone: a real browser flight past
T-0 into ascent. The ascent UI was checked by feeding real engine views into
jsdom; the first human Kestrel-3 flight is its real test.
