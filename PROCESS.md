# Process overview

## Earlier attempts

Before this project I built two ideas in this repo and dropped both. The first,
"Makers Wanted", was a board for posting DIY projects and finding local
collaborators (crit 8). The second, "Mission Control", was a co-operative
rocket-launch game with hidden roles. Neither had real-time play at its heart,
and neither held my interest, so I moved on. Makers Wanted is preserved whole
on the `social-builder` branch and under `deprecated/`.


## Defining good
Players should log in and see a shared world, however destroyed or beautified by previous 
players. They should have a range of spells that interact with the simulated world and 
other players. They should see effects in real time and one slow player should not 
slow the simulation for any other players. Logging off and logging back in should 
reveal a world that exists without the player. 

## The idea and the plan

I settled on a multiplayer falling-sand world in the style of Noita: everyone
shares one destructible world of sand, water, fire and plants, live. Keeping a
world like that in sync between players is a real problem, which is why I
chose it. I planned it in a separate conversation and wrote the result into a
brief, [`docs/plan.md`](docs/plan.md),
[`7a99056`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/7a99056).
An outline of the networking design is in
[`docs/lockstep-networking.png`](docs/lockstep-networking.png).

**Decision:** server-paced deterministic lockstep. Every browser runs the same
simulation, written in Rust and compiled to WebAssembly, on the same ordered
stream of inputs, so all players hold an identical world. The server only
orders inputs and keeps the log; it never simulates.

**Why:** the course machine is one shared CPU with 256 MB, which can't run a
60 Hz world for everyone, while players' browsers are free compute. Lockstep is
exactly consistent by design, so any desync is a bug that hash checks can
detect and the input log can reproduce.

**Rejected:** a server-side simulation (too much CPU for the machine), and
syncing world state instead of inputs (a single explosion changes tens of
thousands of cells). The cost is that determinism is all-or-nothing, so the
first milestone was a test harness before any game code.

## Harness first

The plan was written without seeing this repo, so I had the agent check it
against the real setup before any code: no Postgres, 256 MB not 512, an
individual project, a phone marking viewport. It rewrote the plan to fit and
logged each change,
[`bc033ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/bc033ad).
The plan's hard rules became invariants in `CLAUDE.md`: no floating point in
the simulation, no host imports, counter-based randomness only. I fixed the
byte formats shared by Rust and TypeScript before splitting the work, so
separate workers couldn't disagree about them,
[`e10ed73`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/e10ed73).
Every decision since is a row in `docs/DECISIONS.md`.

## Working from the plan, largely autonomously

I then let the work run largely on its own overnight, from the plan's
milestone order. One Opus session orchestrated and reviewed. Sonnet workers
built each slice from a brief naming the files they could touch, the contract
to reuse and how to verify. Haiku handled mechanical jobs. Before leaving it I
set a spending stop line, so some budget was kept back for the morning, and
told it not to deploy or merge to `main`.

It worked through milestones in order:

- M0: the simulation core and a determinism gate, where the same inputs give a
  bit-identical world in Node, Chromium, Firefox, WebKit and native Rust,
  [`d911c8f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d911c8f)
- M1: the single-player sandbox
- M2: live multiplayer, persistence, verified snapshots and hash checks,
  [`ac44fc3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/ac44fc3)
- M3: a generated cave world, informed by research into how Noita builds its
  caves
- M4: players, pickups and the first spells,
  [`3fed726`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/3fed726)

I stayed in the loop for the calls that were mine: which milestone to stop at,
what to spend, and anything that changes how the game plays. When performance
was over budget, the fix would have slowed water for everyone, so it came back
to me as a question rather than a change.

Only the multiplayer sandbox went live,
[`22ec30b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/22ec30b).
I decided to keep the sandbox deployed for now and the game world on the
`multa` branch.

## Backpressure

A green test wasn't taken as proof. Three kinds of check held the work to
account:

- **Determinism tests**: the same inputs in four browser engines and native
  Rust must hash identically. A deliberately broken "canary" build must be
  caught, which proves the check can fail.
- **Independent review**: each structural slice was read cold by a fresh
  reviewer. This became a standing rule in `CLAUDE.md`,
  [`86cf96c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/86cf96c).
- **Opening it and looking**: two browsers, one at phone size, and a check
  that the live site survives Fly stopping the machine when idle.

## Corrections

**Reviewers found bugs the tests missed.** These included a snapshot buffer
overrun,
[`d6f8921`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d6f8921),
and a two-message teleport exploit,
[`08b1dd7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/08b1dd7).
One found a crash any visitor could trigger on the live site with a single
request. That was fixed straight on `main` and checked by CI before deploying,
[`1403310`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/1403310).

**A wrong diagnosis was corrected by looking.** I reported that lava settled
into a staircase. The first fix's unit test said liquids were now level, but
the sandbox still showed steps. Comparing against the deployed build showed
liquids were never stuck, only slow, and the account was corrected,
[`42e167a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/42e167a).

**The harness learned from a slip.** A merge was committed on a failing test,
because the commit was chained after the test regardless of its result,
[`d24bf69`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d24bf69).
`CLAUDE.md` now requires commits to be gated on exit codes, and treats a test
that only sometimes passes as a defect,
[`b862348`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/b862348).

## What is open

One speed-up, caching the generated world for faster joins, is held back
unpushed. A late-join test fails with it for a reason I haven't explained, and
I won't ship it until I have. Performance with a slowed CPU is still over
budget; the fix would slow water for everyone, so it's a gameplay decision
left to me.
