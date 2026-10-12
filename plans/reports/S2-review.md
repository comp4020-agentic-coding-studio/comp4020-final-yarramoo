# S2 review: correctness and security

### 1. Flight Director's master checklist reveals when a fault is active on another console  — severity: medium — confidence: confirmed
- Where: src/engine/view.ts:131-141 (checklist), src/engine/engine.ts:111-118 and 120-126 (fix step unlocks only while its fault is active), data/sequences/mvp.json (fix_vent, fix_bus have no window)
- Failure scenario: fix_vent / fix_bus are optional steps that sit "locked" until their fault becomes active, then flip to "ready" (and "done" once cleared). The flight view lists every step of every role with its status, so the Flight Director sees "Cycle tank vent valve: READY" the moment Propulsion's fault appears, before any player has said a word. That defeats the "each console sees only its own data" rule and gives the Flight Director a free signal on whom to poll.
- Evidence: ran the engine directly (seed 1, arm_retract done): flight checklist `fix_vent:locked` at T-180, `fix_vent:ready` at T-165 with vent_stuck.active=true.
- Suggested fix: leave steps with a fixStep out of the flight checklist, or report them as "locked" until done, or show them without status.

### 2. /missions?page=<huge> returns 500  — severity: low — confidence: confirmed
- Where: src/routes/history.ts:32 (pageNo) into src/game/store.ts doneMissions OFFSET
- Failure scenario: `/missions?page=1e18` (or 1e308, 9999999999999999999): (pageNo-1)*50 is no longer a safe integer, node:sqlite binds a float and throws "datatype mismatch". Caught by onError and logged with a stack, so a 500 page and log noise, not a crash.
- Evidence: curl against a local server gave 500 for those values and 200 for -5.
- Suggested fix: clamp pageNo to Math.min(pageNo, pages) (or to a sane maximum) before querying.

### 3. Two live missions can share one rocket  — severity: low — confidence: plausible
- Where: src/game/agency.ts:44-50 (pickRocket falls back to ready[0] when all ready rockets are held), 62-67 (previewStart keeps m.rocket_id if it is ready, with no check that another live mission holds it), 102-110 (applyOutcome)
- Failure scenario: with more concurrent unfinished missions than ready rockets (3 seeded), missions share a rocket. If one explodes (rocket "lost") the other still flies and finishes. applyOutcome then adds a flight and condition changes to a lost rocket and ledger lines for a rocket that no longer exists.
- Evidence: code reading only.
- Suggested fix: claimForStart should refuse (or reassign) when another status='live' mission holds that rocket, and applyOutcome should skip a rocket already 'lost'.

## Areas checked and found sound
- SSE isolation: per-role bus topics are subscribed from the DB-held roles at connect time only; observers get only the lobby message (phase, tMs, seats, outcome, which is null until done). Seat changes only happen in the lobby and trigger a "reseat" reconnect.
- view.ts builds each view field by field. Fault real/glitch, events and debrief appear only when phase is "done". The cross-check reading is the intended truth signal.
- /missions, /missions/:code and the agency ledger expose events or fault truth only for done missions (the replay redirects otherwise). The ledger rows are written inside the done transaction.
- Authorisation on /act: seat held is checked against the DB; action fields are allowlisted and type-checked; no client time. Start is flight-only and lobby-only; stale-m races do not occur because the handlers are synchronous after the (cached) body parse.
- CSRF double-submit applies to every POST via global middleware; body limit runs first; cookies httpOnly, SameSite=Lax, secure behind HTTPS. Parse results are type-checked (arrays and Files fail the checks).
- Atomicity: spend() is a conditional UPDATE inside tx; repairs use conditional updates; seat claim relies on the primary key; the done transition is guarded by status != 'done' and runs once; applyOutcome shares the transaction.
- Clock: offset plus downtime on boot, monotonic nowOf, persistence atomic with state, actions and events, SIGTERM flush; the abandoned-mission scrub always succeeds from count or hold.
- XSS: all server templates use html`` escaping (the raw README is author-controlled); the client uses esc()/textContent for every server string (enumerated classes aside); callsigns are regex-limited.
- Rate limiters and the SSE heartbeat/abort cleanup are bounded (the limiter sweeps expired keys).

## Session response

1. Checklist leak: confirmed and fixed. Fix steps stay off the flight
   checklist until someone does one; engine test added, and the existing
   checklist-length expectation updated (an intended change).
2. Page overflow: confirmed and fixed by clamping `page` to 1,000,000.
3. Shared rocket: confirmed. Blocking the start when every ready rocket is
   flying broke the spec (more simultaneous missions than rockets) and would
   cap a showcase at three concurrent crews, so instead a start prefers a free
   rocket and shares one only when none is free, and an outcome no longer
   changes a rocket already lost on another mission (ledger notes it). Whether
   fleet size should cap concurrent missions is left to the owner.
