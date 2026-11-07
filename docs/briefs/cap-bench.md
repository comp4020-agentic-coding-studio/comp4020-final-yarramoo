# Worker brief cap-bench: steady-state room ramp on today's build (Sonnet, $6 cap)

From the Opus capacity lead, 7 Nov. Parent brief: `docs/briefs/capacity-2026-11-07.md`. You are a **Sonnet worker**.
**Do not dispatch subagents.** Stop and report if you reach **$6** of spend (read it with
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`
at the start and every ~20 tool calls), or if it ever reads **$190 or more**.

## Where and what you may touch
- Work only in `/tmp/wt-cap` (branch `capacity-research`). Never touch `/Users/mitch/code/...` or any server on :8080.
- You may edit **only** `tests/soak/capacity-rooms.ts` (or add `tests/soak/capacity-ramp.ts` beside it) and write
  `docs/research/capacity-2026-11-07-bench.json` and `docs/research/capacity-2026-11-07-bench-notes.md`.
  No server/client/shared/sim changes; if the bench cannot work without one, stop and say so.
- Port **8094** only. Docker container name `cap-bench-rooms` (the script's literal name). Image already built:
  **`cap-app:9cfd24f`** (do not rebuild; edit the script's `"app"` image name to this).
- `node_modules` is not installed in this worktree: run `pnpm install --frozen-lockfile` once in `/tmp/wt-cap`.
- **Write your findings to `docs/research/capacity-2026-11-07-bench-notes.md` as you go** (after each run), not only
  at the end. The script must save JSON after every step (it already does `save()`; keep that).
- Every `rm` names a literal absolute path; no globs on variables. `docker rm -f cap-bench-rooms` is the cleanup.

## Host load (important)
Another agent runs cargo/vitest gates on this 8-core machine. **Before every run**: `uptime` and
`pgrep -fl "cargo test|vitest|test:determinism"`. Wait (check every 60 s, up to 15 min) until no such process and
the 1-minute load is under ~4; record the load before and after each run in the notes. If it never gets quiet, run
anyway and label the run "under load N".

## The bench to build (extend capacity-rooms.ts)
Today's rooms (copy the configs, do not import client code into the bench beyond what it already imports):
- **Survival M**: `{ ...SURVIVAL }` from `shared/room.ts` (size 1, maxPlayers 8), mode `"survival"`, **4 bots**.
  A Survival round only starts when every player has readied: each bot sends one READY input after it is live:
  `encodeInput(++seq, KIND_READY, encodeReady(0, 1).subarray(5))` (`shared/inputs.ts`; this is exactly what
  `client/worker.ts:1297` sends). Check `/api/summary` `worlds[].round` turns `"running"`. If a bot dies (Survival is
  one life), it is fine for it to keep sending Pos; record how many rounds ended.
- **Deathmatch M**: `{ terrain: 0, size: 1, avatars: 1, damage: 2, spells: 0, brushes: 0, death: 0, respawnSecs: 3,
  pickupRespawn: 1, round: 0, maxPlayers: 8, enemies: 0 }` (`client/menu/screens.ts:141`), mode `"deathmatch"`, **8 bots**.
- Input mix per bot: Pos every 33 ms (as now) **plus one Cast every ~2 s** (`encodeCast(0, spell, angle, castSeq)`,
  `KIND_CAST`; spell 0, any angle, castSeq incrementing; send `.subarray(5)` like Pos). Casts may be refused by the sim
  for lack of charges; that still costs the server the relay, which is what we measure.
- **Room creation is rate-limited to 10 per IP per hour** (`ROOM_CREATES_PER_IP_HOUR`): send a distinct
  `fly-client-ip` header per POST (e.g. `10.8.0.<n>`), the same way bots already vary theirs.

**Ramp in rooms, two scenarios, each its own container run:**
- Scenario A, Survival: 1, 2, 4, 6 rooms of 4 (4 -> 24 members).
- Scenario B, Deathmatch: 1, 2, 3, 4 rooms of 8 (8 -> 32 members).
Add rooms cumulatively: at each step create and fill the new rooms, settle 15 s, then **sample for 45 s** at 1 Hz.
Each step must include at least one snapshot verify per room (a room's cycle is 30 s; extend the hold if
`snapshotsAccepted` did not advance for every room, up to 75 s).

**Per step, record** (to JSON, one object per step):
- `cpuCores`: server CPU from the cgroup, `usage_usec` delta in `/sys/fs/cgroup/cpu.stat` over the 45 s window divided
  by the wall time (this is the number that matters most); also `nr_throttled` and `throttled_usec` deltas.
- cgroup `memory.current` mean/max and `memory.peak`; RSS from `/api/summary`.
- per room: `ticksPerSec` min over samples, `lastVerifyMs` (collect every distinct value seen), `snapshotsAccepted`,
  `snapshotsRejected`, `snapshotBytes`, `hashFails`, `resyncs`, `round`.
- `lagP99Ms` (call `/api/summary` normally; note the histogram covers since the last reset).
- outbound bytes per second per member (bots already count received bytes; use the delta over the window).
- `dbBytes`, `walBytes` at the start and end of the step (growth per minute).
- the bots' own worker-thread `lagMax` (if bots lag, the bench host is the bottleneck: say so).

**Runs, in order** (stop after the first two if you are near $4):
1. `--cpus=1` Scenario A, then B (demand: how many cores does each step need?).
2. `--cpus=0.0625` Scenario A (does the quota hold 60 tps? where does it break: tps < 58, lag p99 > 500 ms, verify
   rejected "unavailable (timeout)", bots dropped?). Stop the ramp at the first failing step plus one.
3. `--cpus=0.0625` Scenario B, same rule.
Also record **idle**: a fresh container with no rooms, `cpuCores` over 30 s, and memory (once per CPU setting).

Keep `--memory=256m --memory-swap=256m --tmpfs /data` as the script has. Clean up the container after every run.

## Verify the numbers
- A step whose `ticksPerSec` is 0 for a room means it never started or is held: find out why before moving on (a
  held room waits for a LIVE from a catching-up bot).
- Sanity: at 1 CPU the old 24 Oct bench measured ~0.16 core at 8 members and ~0.28 at 32 on two worlds
  (`docs/research/capacity-rooms.md`). A result 10x off either way needs a second run before you report it.

## Report back (final message) and in the notes file
A table per run: step, rooms, members, cpuCores, throttled, cgroup MB max, tps min, verify ms seen / rejected, out
KB/s per member, DB growth; host load per run; anything surprising. Then a section **"Architectural decisions for
review"** (anything in the bench that shapes later work: e.g. how you count CPU, how you start rounds) and
**"FUTURE.md ideas"** (suggestions only). Commit the bench script and the JSON/notes on `capacity-research` as you go:
1. [ ] commit: bench script extended (Survival/Deathmatch, casts, ready-up, cpu.stat, ramp) after a 1-room smoke run works
2. [ ] commit: `--cpus=1` results (JSON + notes)
3. [ ] commit: `--cpus=0.0625` results (JSON + notes)
Commit messages end with `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` (use your actual model name).
Do not push.
