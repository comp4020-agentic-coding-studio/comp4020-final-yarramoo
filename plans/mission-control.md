# Mission Control: overnight implementation plan

Branch: `mission-control` (off `main` at `c7639ca`). Written 2026-10-12 for one
unattended overnight run. Nothing here merges to `main` or deploys: CI only
deploys `main`, and a push to this branch triggers nothing.

## The game, as built tonight

A cooperative launch-control game. Each player sits at one console and sees
only that console. A server-owned countdown runs. Steps on one console unlock
steps on another. The Flight Director runs go/no-go polls, and each seat
chooses what to report, so a seat can say "go" while its console shows a fault.
The record keeps both what was reported and what was showing, and the replay
puts them side by side. That record is the hook for the README's argument
(Challenger, Vaughan's normalization of deviance, Edmondson's psychological
safety). **The owner writes that argument; the agent does not.**

## Decisions taken (veto any of these in the morning)

| # | Decision | Why |
|---|---|---|
| D1 | Keep the stack: Hono, `node:sqlite`, server-rendered HTML, SSE + POST, no new runtime deps | Fits one Fly machine and one volume; actions are discrete clicks, not 60 Hz movement, so SSE is enough; no outside service to justify |
| D2 | A person is a **callsign + cookie**, created on first visit, no password | Markers and week-11 strangers join from the URL alone; two browser profiles = two people |
| D3 | **One shared agency** for the whole site: one budget, one reputation, shared pads and rockets | A crew that blows up the pad leaves it damaged for the next crew, so the campaign is multi-user, not per-crew save files |
| D4 | Fresh database file `mission.db`, migrations restart at `001` | The old `app.db` on the volume is left untouched; no migration chain through Makers Wanted tables |
| D5 | Roles tonight: Flight Director, Propulsion, Ground Systems. A seat may hold several roles | 2 players must be able to play everything (markers test with two profiles) |
| D6 | Engine is pure and seeded: `init / apply / tick / view` with a seeded PRNG | Unit-testable, replay is a re-run of the event log, and a restart rebuilds the same state |
| D7 | Sequences are JSON in `data/sequences/`, checked by a hand-written validator at boot | New steps and faults become data edits; no schema library dependency |
| D8 | Makers Wanted code is deleted on this branch, not archived | It stays in git history on `main`; README, PHILOSOPHY and FUTURE stay until the owner rewrites them |

## Out of scope tonight

- `README.md`, `PROCESS.md`, `reflections/`, `PHILOSOPHY.md` prose. These are
  the owner's writing and agent-like prose is marked down. README stays as it
  is so the `/readme/` invariant stays green.
- Merging, deploying, flipping anything on `main`.
- Weather and Range Safety roles, sound, explosion animation, hangar upgrades.
  They're milestone 3 material, and go into `FUTURE.md` if they come up.

## Architecture

```
src/
  engine/            pure: no I/O, no Date.now(), no Math.random()
    types.ts         Sequence, State, Action, Event, View
    sequence.ts      load + validate data/sequences/*.json
    engine.ts        init(seq, seed) · apply(state, action, nowMs) · tick(state, nowMs)
    view.ts          view(state, role) → only what that console may see
    rng.ts           mulberry32
    *.test.ts        unit tests (vitest include gains src/**/*.test.ts)
  game/              impure shell around the engine
    rooms.ts         live missions in memory, 250 ms tick loop, persistence
    store.ts         SQLite reads/writes: events, snapshots, agency
  routes/
    home.ts          landing: callsign, open crews, start a mission
    mission.ts       /m/:code (lobby, seat pick), /m/:code/console, POST /m/:code/act
    history.ts       /missions, /missions/:id (replay timeline), /agency
    readme.ts        kept
  bus.ts             kept; topics become mission:<code>:<role>
  auth.ts            kept CSRF; session → crew (callsign) instead of user
  views/layout.ts    kept, nav trimmed
public/console.js    small vanilla client: render pushed fragments, send actions
data/sequences/      mvp.json
```

**Server-authoritative clock.** A mission stores `t0` (server ms) and its holds.
Clients receive `serverNow` with every push and render the countdown from it;
nothing a client sends can move the clock or resolve an outcome. `POST /act`
accepts only `{ step, choice }` or `{ poll, report }`, checked against the seat's
roles.

**Redaction is enforced server-side.** Each SSE stream is per seat and carries
only `view(state, role)`. A spec test asserts that the Propulsion stream never
contains the Flight Director's checklist or another console's values.

**Reconnect and restart.** Every accepted action and every tick that changes
state appends to `mission_events`. On a reconnect, the seat's console is
re-rendered from the current state. On a server restart, live missions are
rebuilt by replaying the event log through the engine with the same seed, so
determinism is tested, not hoped for.

## Data model (`src/db/migrations/001_init.sql`)

```sql
crew(id INTEGER PK, callsign TEXT UNIQUE, created_at)
sessions(token PK, crew_id → crew, csrf, expires_at)
agency(id = 1, budget INTEGER, reputation INTEGER)          -- single row
pads(id PK, name, condition INTEGER 0-100)
rockets(id PK, name, condition INTEGER 0-100, status)       -- ready|repair|lost
missions(id PK, code UNIQUE, sequence_id, seed, rocket_id, pad_id,
         status, outcome, started_at, ended_at)              -- lobby|live|done
seats(mission_id, role, crew_id, PRIMARY KEY (mission_id, role))
mission_events(mission_id, seq, t_ms, kind, role, payload JSON,
               PRIMARY KEY (mission_id, seq))
```

## Sequence data (sketch of `data/sequences/mvp.json`)

```json
{
  "id": "mvp", "name": "Kestrel-1 suborbital", "countdownSec": 240,
  "values": { "lox_pressure": { "role": "propulsion", "start": 20, "driftPerSec": 0.4, "max": 100, "faultAbove": 85 } },
  "steps": [
    { "id": "arm_retract", "role": "ground", "label": "Retract crew access arm", "after": [], "window": [-240, -120] },
    { "id": "lox_fill", "role": "propulsion", "label": "Begin LOX fill", "after": ["arm_retract"], "window": [-200, -60] },
    { "id": "poll_1", "role": "flight", "kind": "poll", "after": ["lox_fill"], "window": [-60, -30] }
  ],
  "faults": [
    { "id": "vent_stuck", "at": [-150, -90], "chance": 0.4, "role": "propulsion", "real": true,
      "crossCheck": "ground", "effect": { "value": "lox_pressure", "driftPerSec": 1.2 } }
  ],
  "outcomes": { "ignitionChecks": ["..."], "explodeIf": ["..."], "holdIf": ["..."] }
}
```

The worker settles the exact shape in phase 2 and documents it at the top of
`src/engine/types.ts`.

## Phases

Each phase is: **brief → one worker → review by the session → `pnpm check`
green → commit → push branch → balance check.** Every worker writes its report
to `plans/reports/NN-<phase>.md` before finishing, so a dead run still leaves
its findings.

| # | Phase | Worker | Budget |
|---|---|---|---|
| 1 | **Strip.** Delete Makers Wanted routes, views, migrations, specs and seed scripts; keep layout, CSRF, bus, readme. `/` becomes a placeholder. Update Dockerfile `COPY` lines. Switch to `mission.db`. | Sonnet | $5 |
| 2 | **Engine.** Types, validator, seeded RNG, `init/apply/tick/view`, `mvp.json` with about 10 steps across Flight and Propulsion, success and explosion outcomes. Unit tests for dependencies, windows, drift, determinism and redaction. | Sonnet | $10 |
| 3 | **Server.** Callsign identity, missions, seats, tick loop, event log, rebuild on boot, per-seat SSE, `POST /act` with role checks. Spec: two sessions join, an action reaches the other within 1 s, redaction, a client cannot move the clock. | Sonnet | $12 |
| 4 | **Consoles.** Landing, lobby with seat picking and a shareable code, console pages, countdown rendered from server time, mobile layout. The session then opens two `agent-browser` contexts, plays a mission end to end, and saves screenshots to `plans/reports/`. | Sonnet + session | $12 |
| 5 | **Polls and the record.** Go/no-go poll, a report vs shown record per seat, hold and scrub, replay timeline at `/missions/:id` highlighting "reported go while showing a fault". | Sonnet | $10 |
| 6 | **Third console and pressure.** Ground Systems role, cross-console dependencies, a drifting value, one ambiguous fault resolvable by cross-check, and an outcome ladder of hold, scrub, pad abort, explosion. | Sonnet | $10 |
| 7 | **Shared agency.** Budget and reputation change per outcome, pad and rocket condition carry over, the `/agency` page, and the mission history list. | Sonnet | $8 |
| 8 | **Wrap-up.** A CLAUDE.md section on the new conventions (marked for the owner's review), FUTURE.md entries the workers suggested, and a morning report at `plans/reports/00-morning.md`. | Session | $3 |

The total is $70 against an $80 cap, which leaves a $10 buffer for one retry.

## If there's budget left: stretch phases

Taken strictly in this order, after phase 8 and before the final morning
report. A stretch phase starts only if `current_week_spend` plus its budget plus
$5 is still under the $80 stop, and it goes through the same gate (worker,
review, green check, commit, push). Stopping with money unspent is fine: the
budget is a ceiling, not a target.

| # | Stretch | Worker | Budget |
|---|---|---|---|
| S1 | **Robustness.** Two seats act on the same step in the same instant; an SSE drop and reconnect mid-countdown (`Last-Event-ID` or a full re-render); a server restart mid-mission rebuilds the same state; double-submitted POSTs are idempotent. Spec tests for each, plus a throttled-network run in `agent-browser`. The top band marks this. | Sonnet | $6 |
| S2 | **Independent review.** A fresh agent reads the branch diff cold, with no plan or conclusions given, and lists correctness bugs to `plans/reports/S2-review.md`. The session fixes the confirmed ones. | Sonnet | $5 |
| S3 | **Viewports.** Every page at phone and desktop widths in two sessions, with screenshots; fix overflow, tap targets and countdown legibility. | Sonnet | $4 |
| S4 | **Weather console.** A fourth role whose readouts drift during holds and feed the go/no-go decision. | Sonnet | $8 |
| S5 | **Crew records.** Per-callsign mission count, outcomes, and how often that seat reported go on a fault, on `/crew/:callsign`. | Sonnet | $5 |
| S6 | **Range Safety and in-flight anomaly.** A fifth role with a seconds-long terminate-or-ride decision after liftoff. | Sonnet | $8 |

Never stretch work, even with money left: README, PROCESS or reflection prose,
anything on `main`, sound, hangar upgrades, new dependencies.

## Rules for the run

- **Dispatch cap.** One worker at a time, never in parallel (the engine and
  server share a contract). At most 2 attempts per phase. No worker spawns
  subagents. Each brief lists the files the worker may touch.
- **Triage per `CLAUDE.md`.** Each brief states model and effort:
  - **Sonnet, high effort:** phases 2 and 3 and stretch S1, where the engine
    and server contract and the concurrency get settled.
  - **Sonnet, medium effort:** every other implementation phase, and the S2
    review.
  - **Haiku, low effort:** mechanical work only. Capturing the screenshot sweeps
    (S3 capture, and the repeat captures in phases 5 to 7 once the session has
    done the first play-through itself in phase 4), and tallying spend per phase
    for the morning report.
  - **The session:** briefs, review, the first two-browser play-through,
    fixes of a few lines, and the morning report.
- **Budget stop.** The balance is checked after every phase. If
  `current_week_spend` reaches **$80** (baseline $4.45 plus a $75 working
  margin), the run finishes the current commit and stops.
- **Red stops the run.** If `pnpm check` is still red after the second attempt
  at a phase, nothing red is committed: the run reverts to the last green
  commit, writes what failed into the morning report, and stops.
- **Check what you see.** Phases 4 to 7 end with two `agent-browser` contexts
  playing the change, not only tests. Use `agent-browser --session <role>`:
  each named session has its own cookies, so two sessions are two crew
  members. Close the sessions when done.
- **Ask, don't guess.** Anything that is the owner's call (the README argument,
  a veto-worthy design choice) goes into the morning report as a question.
- **Push every phase** to `origin/mission-control`.

## The morning report will say

What was built, by phase, with commit links; what was verified in a browser,
with screenshots; what failed or was skipped; spend per phase; questions for
the owner; and what the README needs to argue before crit 9.
