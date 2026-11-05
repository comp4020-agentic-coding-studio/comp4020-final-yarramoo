---
name: run-tests
description: Run Simulta's tests, from one file while iterating to the full gate before a commit, and read the results correctly. Use before committing anything in sim/, shared/, server/ or the input path, when asked to "run the tests", "run the gate", "is it green", when a test fails or seems flaky, or before dispatching workers who will run tests themselves.
---

# Running the tests

## Pick the smallest run that answers the question

| Question | Command (from the repo root unless noted) | Time |
|---|---|---|
| Does this sim test pass? | `cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release --test <file>` or `--lib <name>` | seconds |
| Does this net test pass? | `pnpm vitest run --config vitest.net.config.ts tests/net/<file>.test.ts` | seconds to a minute |
| Types? | `pnpm typecheck` | seconds |
| May I commit? | **the gate** (below) | 8-15 min |

Always `--release` for cargo: debug is about 25x slower on the 512 x 512 worlds. Always prefix cargo with
`PATH="$HOME/.cargo/bin:$PATH"`: Homebrew's `rustc` comes first on PATH and has no wasm32 target.

## The gate

Required before any commit touching `sim/`, `shared/`, `server/` or the input path, and before every push. Each step
writes its own log and the commit is chained on the exit code, so a red step stops everything after it:

```bash
(cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release > /tmp/g-cargo.log 2>&1) \
 && (cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo clippy --target wasm32-unknown-unknown --release -- -D warnings > /tmp/g-clippy.log 2>&1) \
 && pnpm typecheck > /tmp/g-tsc.log 2>&1 \
 && pnpm test:determinism > /tmp/g-det.log 2>&1 \
 && pnpm test:net > /tmp/g-net.log 2>&1 \
 && git add <the files, by name> && git commit -q -F /tmp/msg.txt; echo "gate exit $?"
```

Run it with `run_in_background` and wait for the notification; do not poll it. What each step guards is in
`docs/engineering-decisions.md` entry 40. `pnpm check` (what CI runs) is only a fast subset: it does not run
determinism or the net suite.

Read results from the logs, after the exit code:
`grep -E "^test .*FAILED|panicked" /tmp/g-cargo.log`, `grep -E "Tests " /tmp/g-det.log /tmp/g-net.log`.
To see *every* cargo failure (cargo stops at the first failing binary), add `--no-fail-fast`.

## Rules learned the hard way

**The exit code is the gate.**
- Never `;` between the test and the commit: a merge went in on a red run that way (`d24bf69`).
- Never gate on piped output: `cargo test | grep ...` and `| tail` exit 0 whatever the tests did. Redirect to a log
  file and chain with `&&`.
- Workers have committed on red, piped clippy through `tail`, and skipped `test:net`. **Re-run the gate yourself**
  before pushing a worker's commits.

**Run one gate at a time on this machine, and few agents.**
- The machine has 8 cores. Determinism launches three browsers and the net suite boots real servers on real time,
  so load slows them down and timing-sensitive tests fail for reasons that are not bugs.
- On 4 Nov eleven parallel agents took the load average to about 575. Most gates timed out, five finished pieces sat
  uncommitted until quiet reruns, and the noise hid two real bugs that the quiet reruns then found.
- Check before starting: `uptime` (load) and `pgrep -fl "cargo test|vitest"` (another gate). With cargo involved,
  one or two workers at a time, never ten. Tell workers to run single files while iterating and the gate once per
  commit, in the background.
- A gate result under heavy load is a weak signal both ways: re-run a timeout quietly before believing it.

**Never change files under a running gate.**
- It tests whatever is on disk at each moment, so the commit would rest on code the gate never saw. Don't edit
  `sim/`, stash, check out or merge in this tree while it runs. Stage edits in `/tmp` and apply them afterwards.
- If you edit after a green gate, the commit needs a new gate on the code it contains.

**A gate rebuilds `sim.wasm`, and that breaks the user's dev server.** The server on :8080 hashed the wasm at
start; after a rebuild a fresh tab is refused with "new version, reload". After a gate or build, if the user is
going to look, follow the `dev-server` skill and restart it. Never run your own browser checks against the user's
server or data dir: use another port and `/tmp` data dir.

**A test that has not failed proves nothing.**
- Show every regression test red against the real failure first, not a timeout or a setup accident. A restore
  test once painted water into dirt and passed on the buggy code. A wake test once woke its own chunk in setup.
- Prove a test can fail by breaking the thing it guards (stub the function, remove the input), and restore the file
  from a copy afterwards.
- Probe output from a passing vitest test is swallowed: write to a file under `/tmp`, not `console.log`.

**Intermittent is a race until shown otherwise.** A test that fails one run in three is a real defect. Trace the
timing-dependent value instead of retrying: `first_blood` was a 27-cell blast reach against a "far enough" 12 cells
(D-179). Make the suspect parameter tiny to reproduce it at once. A test that passes alone and fails in the full
suite is shared state or load.

**Pinned results change only on purpose.** `sim/tests/golden.rs` and `sim/tests/perf_equiv.rs` pin hashes. A change
meant to keep results identical must reproduce them exactly. A change meant to alter behaviour re-records them
(`HF_REGEN=1 ... --test golden -- --nocapture`, paste `SCRIPTED_HASH`; `PERF_REGEN=1 ... --test perf_equiv`). First
list which scenarios moved, and say so in the commit. If a scenario moved that shouldn't have, investigate.

**Green is not working.** Tests miss what they hold fixed: world size, route, entry path, two clients. After the
gate, open the build in a browser (the `dev-server` skill), and for anything structural get a cold read-only review.
