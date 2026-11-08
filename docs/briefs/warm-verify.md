# Brief WARMVERIFY: keep snapshot verification warm per room, then re-measure capacity (Opus lead)

Written 8 Nov by the session model. The user approved "fix 1" from `docs/research/capacity-2026-11-07.md` (D-213):
**a verify sim per loaded room, so verifies stay warm**, then another capacity test. You are the **Opus lead**: design,
brief **Sonnet/Haiku** workers (one at a time), review, gate, and re-measure. The deadline is **Mon 9 Nov 12:00**:
a small, correct, reviewed change beats a clever one.

## Budget and stopping (hard)
- **$20 total** for you and every worker. Week spend was **$194.70** when this was written; the user's weekly
  ceiling is **$220** (it resets Thu 12 Nov 9:00). Read `/api/me` at the start, after every worker, and every ~20 of
  your own tool calls:
  `curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`.
  **If it reads $214 or more, stop at once**, commit what you have to your branch, and report (the session model needs
  the remaining few dollars to merge). Stop dispatching at $211.
- **At most 3 workers, one at a time.** Workers never dispatch. Write `docs/research/warm-verify-report.md` **as you go**.

## Where
`git worktree add /tmp/wt-warm -b warm-verify multa`; you and every worker work there only. Never touch the main
checkout or the user's :8080 server (PID in `HANDOVER.md`); never push or merge into `multa`. Ports: your servers on
**8086**, Docker benches on **8085** (8094 is the old bench default: change it via env), data dirs `/tmp/warm-*`,
removed by literal path. Check `docker ps` and `pgrep -fl "cargo test|vitest"` before every bench: one job at a time.

## The problem (read the evidence first)
- `docs/research/capacity-2026-11-07.md` and its JSON; D-213 in `docs/DECISIONS.md`.
- `server/verify.ts` (`SnapshotVerifier`: **one** worker, `check(compressed, maxRaw)`, a 10 s `VERIFY_TIMEOUT_MS`,
  a timeout kills the worker and fails all pending jobs) and `server/verify-worker.ts` (**one** `Sim`, `sim.restore(raw)`
  then `stateHash()`).
- The sim keeps the pristine generated world for one (seed, config) as `Base` (`sim/src/sim.rs` ~21, D-088), and
  `restore` keeps it only when the next snapshot has the same seed and config (`sim/src/lib.rs` ~177). With two or more
  rooms (each has its own random seed since D-201) every verify regenerates the world: cold 6-18 s (M) and 35-50 s (L)
  at the Fly quota, warm 0.1-2.9 s.
- Callers: `World` verifies uploads (`server/world.ts`, search `verifier`), and start-up verifies a stored snapshot
  under a new build (`server/world.ts` ~482, `loadFromDb`: an "unavailable" there refuses to start rather than reset,
  D-014). Rooms load and unload (`server/main.ts`: `getOrLoadRoom`, `deleteRoom`, the unload timer; caps
  `MAX_LOADED_ROOMS` 16 with L counting 2, `MAX_LOADED_L_ROOMS` 4, `ROOM_LOAD_MEMORY_CAP_BYTES` 200 MB).

## The job
1. **Design (you)**: keep one warm verify sim **per loaded room**. Weigh, and record in "Architectural decisions for
   review": (a) one worker holding a `Map<worldId, Sim>` (one wasm instance per room, or one `Sim` whose base cache is
   keyed by world: the sim keeps one `Base` per instance, so one instance per room is the no-sim-change route); (b) a
   worker per room (isolation, more threads and memory); (c) anything better. **No change in `sim/`** unless you can't
   avoid it: if you need one, stop and report why (the session model and user decide). Decide the bound: the memory per
   warm room (measure it: M and L, a played world), the eviction policy (drop the room's sim when the room unloads or is
   deleted, LRU past a cap), and how it interacts with the 200 MB room-load memory gate.
2. **The trust path must not weaken.** A verify still decompresses with the size cap, restores, and compares the hash
   and tick exactly as now; a hostile snapshot is still refused. A timeout must not now lose *every* room's warm sim
   (today it kills the one worker): say what happens and keep it bounded. Start-up's "unavailable means refuse to
   start" (D-014) must still hold.
3. **Implement** (a Sonnet worker, or you if it's small): `server/verify.ts`, `server/verify-worker.ts`, the call sites
   in `server/world.ts` / `server/main.ts` (pass the world id; drop on unload/delete). Log through `log.event` with a
   name in `shared/events.ts` (e.g. a cold/warm marker on the existing verify line, never one line per tick).
4. **Tests, shown red first** (`tests/net/`): two rooms with different seeds alternating verifies: the second verify
   of each room is warm (assert regeneration does not happen: e.g. time it against a cold one, or expose a counter of
   cold restores from the worker for tests); a deleted room's sim is dropped; a timeout in one room does not make the
   next verify of another room cold, or if it must, the test says so; a hostile snapshot is still refused. Existing
   verify tests (`grep -rln verif tests/net`) stay green unchanged.
5. **Gate**: no `sim/` change expected, so `pnpm typecheck && pnpm test:net` and
   `APP_URL=http://localhost:8086 pnpm check` against your own server on the branch's build. If `sim/` changed, the
   full `run-tests` gate.
6. **Re-measure** (a Sonnet worker, reusing `tests/soak/capacity-ramp.ts` and `tests/soak/verify-micro.ts` from the
   capacity research, Docker `--memory=256m`, on port 8085): the same scenarios as before at `--cpus=0.0625` and
   `--cpus=1`: verify times and outcomes (cold vs warm), ticks/s, lag p99, cgroup memory, CPU. The question: **how
   many rooms/members hold at the sustained quota now**, and at burst. Quiet host only; label load. Compare with
   `capacity-2026-11-07.md` in a before/after table.
7. **Cold review**: a read-only Sonnet reviewer on the diff of `server/` (the trust path), writing to
   `docs/research/review-warm-verify.md`. Check its findings against the code before acting.

## Hand back
`docs/research/warm-verify-report.md` (headline: rooms at the quota before and after), the before/after table, gate
results with log paths, the review and what you did about it, **Architectural decisions for review**, a D-row draft
(it implements D-213's recommendation 1) and an engineering-decisions entry draft, FUTURE.md ideas (listed). Branch
`warm-verify` committed, not pushed; commits end with the writing model's `Co-Authored-By` line (Opus
`Claude Opus 5.5 <noreply@anthropic.com>`, Sonnet `Claude Sonnet 5.5 <noreply@anthropic.com>`, Haiku
`Claude Haiku 5.5 <noreply@anthropic.com>`). Kill every server and container you started.
