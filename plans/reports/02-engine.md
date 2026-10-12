# 02 Engine report

Engine in `src/engine/`, `data/sequences/mvp.json` (Kestrel-1, 12 steps, 2 polls, 2 faults), vitest split into `engine` and `spec` projects, `COPY data` in the Dockerfile. Typecheck, 50 engine tests and `pnpm check` against the app on :8092 are green. Contract and deviations: header of `src/engine/types.ts`.

## Contract changes vs the brief
- State gains `elapsedMs` and `anchors`; `drift` is the base rate and real-fault effects are added on top. Values are exact functions of these, so tick granularity gives bit-identical state (the brief's float problem).
- `apply` failures return `{ok:false, error, state, events}`: the state/events from ticking before rejection (an outcome or hold can happen first); persist them.
- Poll status gains `missed`; polls gain `history`. A poll closed with a no-go can be re-opened by flight (new round); otherwise a no-go would make T-0 unwinnable.
- `after` may name steps and polls (one namespace). Fix steps stay locked until their fault is active, must be `required:false`, same role.
- Views: flight gets `checklist`; every view gets `polls` (who reported what, never `showing`); a `debrief` (real/glitch, reported vs showing) appears only when `phase` is done. Cross-check readouts are always present ("normal" until a real fault is active).
- Events carry real/glitch truth: log only, never broadcast.

## T-0 with unmet requirements
Hold with the clock set back to T-1 s (tMs = -1000), `holds += 1`. Resume runs into T-0 and re-evaluates; values keep drifting, so stalling can still explode. Explosion is checked first.

## Tests (50 engine)
Validator, determinism, granularity (random chunking through holds and T-0), immutability, JSON round trip, permissions, dependencies, window miss and late fix, drift in hold, `showing` on a caution, no-go and re-poll, scripted win, 60-seed win, ignored glitch, ignored real fault, T-0 hold, view redaction.

## Weak spots
- Seeds are found by scanning, so retuning fault chances changes which seed each test uses.
- A seat that nobody occupies blocks its polls; phase 3 must seat all roles (one player may hold several).
- Balance untested with humans: poll_1 and igniter windows are the tight spot.

## FUTURE.md ideas
- Replay page from the event log plus `debrief`, "reported go while showing caution" highlighted.
- Fault severity ladder (hold, pad abort, explosion) rather than all-or-nothing at T-0.
