# Your harness

This file is yours, and it arrives empty on purpose. The rules you hold the
agent to are part of what gets marked, so they should be rules you decided on.

Nothing about the template is recorded here. What the repo ships is explained
where it lives --- `fly.toml`, the `Dockerfile`, the CI workflow and
`spec/README.md` each say what they fix --- and the course website publishes the
[final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/).
What the agent needs to carry from any of it is your call.

## Commit as you go, push every batch

Small, frequent commits are the record of how the work came together, and
that record is read, not just the final state. A trail that grew alongside the
code is the strongest evidence of process; a single dump the night before is
the weakest. In a past assignment here, a whole feature arc sat uncommitted
across ~2400 lines and 19 files for a session and had to be reconstructed into
three retroactive commits afterwards, losing the true chronology --- commit as
each piece lands instead.

A commit that only exists locally isn't evidence yet: `PROCESS.md`'s citations
need to resolve on GitHub for a reader, not just in this working copy. Push
after every batch of completed work, not just at the end of a session.

## A dispatch needs a cap before it needs ambition

Agent fan-out (subagents, parallel research, bulk generation) needs an explicit
cap stated in the prompt --- how many, which model, what reasoning effort --- or
it inherits the dispatching session's settings, which is how an ordinary task
acquires an extraordinary price. One research dispatch in this course ran 23
subagents on Opus at maximum effort with no cap and burned a week's entire
budget in about twenty minutes, with almost nothing reaching disk before it
stopped. Make subagents write their findings to a file as they finish, not only
report them back through the orchestrator, so a run that dies still leaves
something behind. Check `/comp4020:balance` before a large fan-out, not after.

This app is multi-user and real-time, which is exactly the kind of brief that
invites "spin up five agents to build the client, server, schema, sync and
tests in parallel." Resist that by default; the pieces are coupled enough
(shared schema, shared event shape) that parallel agents will disagree with
each other about the contract between them.

## Triage every development task, and delegate down

Before starting any development task, decide which is the cheapest model that
can do it well, and hand it to that model as a subagent rather than doing it in
the session's own (usually more expensive) model. In practice:

- **Haiku**: mechanical work with no design judgement --- bulk renames,
  scraping or extracting from structured pages, reformatting data, running a
  known command and summarising its output.
- **Sonnet**: ordinary implementation --- a route, a page, a migration, a test
  file, a restyle --- given a brief that names the files, the contract it must
  reuse, and how to verify it.
- **The session model keeps** only what genuinely needs it: planning and
  slicing, writing the briefs, reviewing and merging what comes back, and
  decisions the user has to weigh in on. A change of a few lines is done
  directly; briefing it would cost more than doing it.

A delegated task still follows the dispatch cap above, and its brief says
which files it may touch. Review what comes back before it's pushed: the
cheaper model writes the code, but the session model answers for it.

### Architectural decisions go to review, not straight in

Every delegated brief asks for a section "Architectural decisions for review":
each choice that shapes code later milestones build on, with what was chosen,
the alternatives, why, and what it costs later. When a worker is unsure about a
hard-to-reverse choice it takes the more reversible option and flags it. The
session model reviews these before pushing; anything it would change goes back
to the same worker, and anything that changes the design gets a row in
`docs/DECISIONS.md`.

Slices that set structure (a milestone's core, anything touching the shared
input path, the snapshot format or the ABI) also get an independent Sonnet
reviewer that reads the diff cold and writes to `docs/research/review-*.md`.
Its findings are checked against the code before they're acted on. The M3
review found a snapshot buffer overrun and a server stall that every test had
passed over.

Name commit boundaries in a brief as a checklist. Left as a suggestion, a
worker landed one slice as a single 1000-line commit (D-046).

### A test that passes on a retry is a bug, and `&&` is not a gate

A merge was committed on a red `pnpm test:net` run because the commit was
chained after the test with `;`, so it ran whatever the test said (`d24bf69`).
Gate commits on the exit code (`pnpm test:net && git commit ...`), and never
on output piped through `grep`, which exits 0 whatever the tests did. A test
that fails one run in three is a real defect: in lockstep code, intermittent
means a race until shown otherwise. Find which assertion is timing-dependent
before calling it flaky. The first one turned out to compare two independent
clocks' tick numbers.

## Log good ideas in `FUTURE.md`

When a good idea for a feature turns up and isn't part of the current task,
write it into `FUTURE.md` rather than building it or letting it go. It might
come while developing, while reviewing a worker's output, or while looking at
another site for prior art. Each entry says what the idea is, where it came
from, and why it might be worth doing. Nothing obliges an entry, and an entry
obliges no work: the file exists so a good idea outlives the session that had
it. Delegated workers can suggest ideas in their reports; the session model
decides what goes in.

## Open it and look

A green check is not the same as a correct page. Multi-user and real-time
behaviour in particular --- two sessions going out of sync, a change that
lands in the database but never reaches the other open tab, a reconnect that
drops state --- is exactly the kind of bug a test can miss and a second open
browser tab catches immediately. Open the app in two browser contexts and
watch them interact; don't trust the test suite alone for anything concurrent.
The `agent-browser` CLI (course site, backpressure topic) is a way to do this
from the agent itself.

## Treat a red check as authoritative

The app is wrong until `pnpm check` is green, not until you decide it should
be. Never commit a red state. When a check fails, read its output before
changing anything --- the failure usually says more precisely what's wrong
than a guess would.

## `PROCESS.md` has a length, and `check:evidence` now knows it

The final project brief asks for 900--1100 words and says work that badly
overshoots can lose marks for concision. Nothing enforced that until now, and a
sibling deliverable's `PROCESS.md` quietly grew to ~2000 words this way: every
batch of work appends its own disclosure paragraph and nothing ever trims what
came before. `scripts/check-evidence.ts` now counts prose words (code fences,
images and link URLs excluded): over 1100 fails, under 900 only warns, since CI
runs it before every deploy and the file is still growing through crits 8--10.
Treat the warning as owed by the final deadline. When you add a
paragraph, condense an older one in the same commit --- never fix an overshoot
by deleting a disclosed gap, since the disclosure is the point of the file.

## This file is yours

A starting point, not a rulebook. As the schema, the identity model and the
real-time transport take shape, write down what you learn here --- a
convention the work has to hold to, a sensor that keeps catching you out, a
fact about the stack that's easy to get wrong --- and wire it into `check`.

## Falling-sand simulation invariants (the `multa` branch)

The code must hold to these; they are not harness guidance. The full design is
`docs/plan.md` and the decisions log is `docs/DECISIONS.md`. Break one only after
asking the user.

1. **All logic that affects shared state lives in `sim/` (the WASM module).** TypeScript only captures input, renders, handles networking and predicts the local avatar. TypeScript never writes to simulation state except through `push_input`.
2. **The simulation ABI accepts and returns integers only.** Quantize floats (aim angle, avatar position) in TypeScript *before* they become inputs.
3. **No floating point in `sim/`.** Enforce with `#![deny(clippy::float_arithmetic)]`. Use fixed-point (plan section 6).
4. **No host imports.** `sim.wasm` must import nothing. CI asserts that `WebAssembly.Module.imports(module)` is empty. This makes it impossible for the simulation to read clocks, randomness, or the JS engine.
5. **No `HashMap`/`HashSet` in `sim/`** (ban via clippy `disallowed-types`). Use `Vec`, sorted `Vec`, or `BTreeMap`. No `std::time`, no threads, no entropy-seeded RNG.
6. **Randomness is counter-based:** `rng(seed, tick, x, y, salt)`. There is no stateful RNG.
7. **Hash only fixed-width integers** (`u8`/`u16`/`u32`/`u64`), never `usize`. `usize` is 32-bit on wasm32 and 64-bit natively.
8. **Chunk sleeping must be semantically invisible.** Results are identical with sleeping disabled (test D7).
9. **Outputs never feed back.** `dirty_rects`, `events` and `entities` are read-only views for rendering and UI. Nothing read from them may become an input, except where explicitly specified (Pos inputs come from the local controller, which is allowed).
10. **All clients in a world run the identical `sim.wasm`.** The server rejects a client whose sim build hash differs from the world's.
11. **No server-side stepping, no P2P/WebRTC, no rollback, no WASM threads, no per-cell ownership tags.** See plan section 16.

Run the determinism suite before every commit that touches `sim/`,
`shared/protocol` or the input path. Build and test commands go here as they
come into existence.

- **Two Rust toolchains are installed and the wrong one is first on PATH.**
  Homebrew's `/usr/local/bin/rustc` has no wasm32 target, so wasm builds and
  clippy fail with "can't find crate for `core`". Prefix sim commands with
  `PATH="$HOME/.cargo/bin:$PATH"`.
- **Sim commands** (from `sim/`): `cargo test --release` (debug is about 25×
  slower on the 512×512 sandbox); `cargo clippy --target wasm32-unknown-unknown
  --release -- -D warnings`; `cargo build --target wasm32-unknown-unknown
  --release` writes `target/wasm32-unknown-unknown/release/sim.wasm`, which must
  have zero imports.
- **Determinism suite:** `pnpm test:determinism` (about 50 s) builds both
  wasms and runs D1, D2 (Node, Chromium, Firefox, WebKit), D3, D6, D10 and D11.
  It is separate from `pnpm check`, which needs a running server; run both
  before committing anything in `sim/`, `shared/` or the input path.
- **An input must not be able to cost unbounded work.** Every client runs every
  input, so one huge `Paint` freezes the whole room. The sim clamps paint
  endpoints to the world and the radius to `MAX_PAINT_RADIUS`; new input kinds
  need the same bound.

## Server logging and identity

- **Every server-side action logs through `log.event`** (`server/log.ts`) with a
  name from the catalogue in `shared/events.ts`. No `console.*` in `server/`.
  Anything a client can trigger repeatedly goes through `log.limited`, or one
  client floods the ring the admin dashboard reads. Never log one line per
  input: per-input counts go into `input.summary`.
- **Never log a raw IP or a token.** Use `log.ipTag(ip)`.
- **Players only ever see the plain name they chose.** `name#id` is for logs,
  the database and the admin dashboard. The public `/dashboard` and
  `/api/summary` show aggregates only.
- **`server/` and `shared/` never import from `client/`.** The runtime image
  copies only `server/` and `shared/`, so such an import passes every test and
  crashes the deploy (review crit 10 S1). `tests/net/imports.test.ts` checks it.
- **CI does not run on `multa`**, only on `main` and pull requests. Before a
  merge, build and boot the real Docker image, or let a PR's CI run do it.
- **Probe output from a passing vitest test is swallowed.** Write to a file
  under `/tmp` instead of `console.log` when measuring something mid-test. A
  test written to catch a bug must be shown red without the fix first.
