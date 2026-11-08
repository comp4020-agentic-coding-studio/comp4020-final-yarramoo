# Brief: re-measure server capacity with warm verify lanes (Sonnet worker)

Written 8 Nov by the Opus lead of backlog item 1 (warm verify, D-213 recommendation 1, D-row draft D-214).
**Model: Sonnet. Cap: $7. Stop and report at about 120 tool calls**, or when the lead's spend line is reached, whichever comes first. You never dispatch agents.

## Goal
The same capacity scenarios as `docs/research/capacity-2026-11-07.md` (the "before"), on the branch's build (the "after"),
so the lead can state: **how many rooms/members hold at the sustained Fly quota (`--cpus=0.0625`) before and after warm
verify lanes**, and whether anything changed at `--cpus=1`. If nothing moves at the quota, that is a valid answer: say so.

Read first: `docs/research/capacity-2026-11-07.md` (method, tables) and `docs/research/capacity-2026-11-07-bench-notes.md`;
the branch's `docs/research/warm-verify-report.md` (what the lanes do: one worker per occupied **cave** room, prewarmed at
the first join, lingering 60 s after the last leave; box rooms get none; budget 100 MB estimated, cgroup cap 160 MB);
`tests/soak/capacity-ramp.ts` (the bench; `--scenario A|B --cpus 1|0.0625 [--idle]`, env `PORT`, `IMAGE`, `OUT`,
`BOTS`, `MAXSTEPS`, `SETTLE_S`, `WINDOW_S`); `tests/soak/verify-micro.ts`; `server/verify.ts` (the lanes: a worker per
occupied room, prewarmed at the first join; `verify.lane_*` events; the `snapshot.accepted` event now carries
`verify_cold` and `verify_path`).

## Where and what you may touch
- Worktree `/tmp/wt-warm` (branch `warm-verify`), already rebased and gated. Work only there. Never touch
  `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo` or anything on port 8080.
- Port **8085** for the container (`PORT=8085`), container name as the bench sets it. Image tag **`warm-app:<short sha>`**
  built from `/tmp/wt-warm` (`docker build -t warm-app:$(git rev-parse --short HEAD) .`). Data inside the container is tmpfs.
- Files you may create or edit: `docs/research/capacity-2026-11-08-warm*.json` (raw output, via `OUT=`),
  `docs/research/capacity-2026-11-08-warm-notes.md` (your notes and tables), and `tests/soak/capacity-ramp.ts` **only**
  to add what the comparison needs (for example: read `verify_cold`/`verify_path`/`verify.lane_*` from `docker logs` per
  step, count `snapshotsAccepted`, a default `IMAGE` from env). Do not change anything under `server/`, `shared/`,
  `client/`, `sim/`, `tests/net/`. Do not write the 7 Nov JSON files.

## Host rules (CLAUDE.md, binding)
- **One heavy job at a time.** Before each run: `uptime`, `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"`,
  `docker ps`. Start only when nothing of ours runs and the 1-minute load is under about 6 (the owner's Chrome is not
  ours). Record host load before and after every run, as the 7 Nov notes do. If load from elsewhere rises past ~8 mid-run,
  mark that step "under load".
- Each run is long; run it with `run_in_background` and wait for the notification, do not poll in a loop.
- `docker rm -f` your container after every run (the bench does it; check with `docker ps -a`). Remove the image at the
  end only if the lead asks; leave it.
- **Every `rm` names an explicit literal absolute path**, never a variable or glob on a variable, never relative.

## Runs, in this order (stop early if the cap nears; quota runs matter most)
1. **Floor at the quota**: `--cpus 0.0625`, scenario A, `BOTS=2 MAXSTEPS=1`, `WINDOW_S=150` (before: 0 of 5 verifies
   accepted, every verify 10-17 s, lag p99 1.3 s, 0.061 core).
2. **Quota, Survival M of 4**: `--cpus 0.0625 --scenario A`, `MAXSTEPS=2` (before: step 1 failed: 57.7 tps, lag p99 6.2 s,
   8 rejected; step 2 45.7 tps, 25.5 s lag, 25 rejected).
3. **Quota, Deathmatch M of 8**: `--cpus 0.0625 --scenario B`, `MAXSTEPS=2` (before: step 1 lag p99 2.7 s, 2 rejected,
   step 2 incomplete).
4. **Full core**: `--cpus 1 --scenario A --idle`, then `--cpus 1 --scenario B` only if the cap allows (before: tables
   in the 7 Nov report). Memory with lanes is the thing to watch here (each M lane ~30 MB).
5. **Skip the verify micro** (`tests/soak/verify-micro.ts`): it times the worker job itself, which the lanes do not
   change; the 7 Nov cold/warm numbers stand. Say so in the notes.
6. **Memory**: from the runs above, the cgroup max with lanes vs before (lanes hold ~30 MB per M room up to a 100 MB
   budget and a 160 MB cgroup cap; then rooms verify cold on the overflow worker). Note how many lanes opened and how many
   were refused per step (`verify.lane_opened` / `verify.lane_refused` in `docker logs`).

For each step record what the 7 Nov tables record (core, throttled periods, cgroup MB max, tps min, lag p99, verify ms
seen / rejected / **accepted**), plus **cold vs warm verifies** and lanes opened/refused. The headline question per
scenario: does it now **hold** at the quota, where "holds" means tps >= 58 min, verifies **accepted**, lag p99 under 1 s
(the 7 Nov reading; state if you use another).

## Commit checklist (small commits as each piece lands, on `warm-verify`; never push, never merge)
- [ ] Any change to `tests/soak/capacity-ramp.ts`, alone (`tests/soak/` is the docs tier: run `pnpm check:evidence`
      and chain the commit on it with `&&`).
- [ ] After each scenario: its JSON plus the notes file updated (`git add` by name, `&&`-chained on `pnpm check:evidence`).
- [ ] Final: the notes file with a before/after table against the 7 Nov numbers and the headline sentence.
Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Report
Write `docs/research/capacity-2026-11-08-warm-notes.md` **as you go** (after every run), so a run that dies leaves
numbers behind. End it with: the before/after table, the headline ("rooms held at the quota: before N, after M"),
caveats (host load, single samples), **"Architectural decisions for review"** (anything you chose about method), and
FUTURE ideas. Your final message: the headline, the table, the commits, and the path.
