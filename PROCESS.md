# Process overview

## The project and its central decision

A multiplayer falling-sand world in the style of Noita, where everyone shares one
destructible world of sand, water, fire and lava, live. Earlier ideas in this repo
("Makers Wanted" and "Mission Control") are kept on their own branches.

Players should see a shared world however it was left by those before them, effects
should arrive in real time, one slow player must not slow anyone else, and coming back
should reveal a world that went on without you.

**Decision:** server-paced deterministic lockstep. Every browser runs the same simulation,
written in Rust and compiled to WebAssembly, on the same ordered inputs, so all players
hold an identical world. The server orders inputs and checks agreement; it never runs
the world. The course machine has one shared CPU and 256 MB, too little to simulate for
everyone, while players' browsers are free compute. The cost is that determinism is
all-or-nothing, so the first milestone was a test harness that compares the same inputs
across four browser engines and native Rust,
[`d911c8f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d911c8f).
The plan, [`7a99056`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/7a99056),
became hard rules in `CLAUDE.md` before any game code,
[`bc033ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/bc033ad).

## Long-running agentic sessions

Most of the build ran with the agent working largely on its own, including one
overnight run that I set a spending cap on before going to bed. One session planned and
reviewed. Cheaper Sonnet workers built each slice from a brief naming the files they could
touch and how to verify their work, one slice at a time, because the pieces share a
protocol and parallel workers would disagree about it. In one night the run added
damage, death, spells, dropped loot, achievements, logging and an admin dashboard, each
gated on the full test suite.

Every structural slice was then read cold by an **independent reviewer**: a fresh
agent with no stake in the code, told to find what was wrong. They found real bugs that
every test had passed:

- **Anonymous spectators could forge deaths.** Votes on whether a death happened counted
  anonymous tabs, so a dozen of them could outvote real players,
  [`accef4f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/accef4f).
- **One input counter could corrupt the saved log.** While the world waited for a joiner,
  inputs piled into one tick past what its 16-bit count could hold,
  [`5da1a9f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/5da1a9f).
- **A slow check could wipe the live world** on a deploy,
  [`bbd5d73`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/bbd5d73),
  later ported to the live site,
  [`d1c43c5`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d1c43c5).
- **Tests that could not fail:** a "corpses can't be hit" test fired away from the corpse,
  [`fa2deab`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/fa2deab).

Each finding was checked against the code before it was acted on, and every new test was
shown failing without its fix first, so a green test meant something.

## A bug that only time could find

The live site went down days after a clean deploy. A new visitor catches up by replaying
every move made since the last saved snapshot, and only a visitor who has caught up can
save the next one. With a long log, catch-up took minutes, visitors left before finishing,
and no new snapshot was saved for four days. The log grew past 130,000 moves, and one
ordinary restart then overflowed the server's stack while loading it. I reproduced the
crash in the real image and fixed it,
[`2c70ceb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/2c70ceb).

When the cause was unclear, I asked for research into how other games handle late
joiners. It came back confident that a long log "never recovers". A side-by-side test of
the old and new code then showed the old code was slow, not stuck, and the account was
corrected rather than rewritten,
[`943cefc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/943cefc).
The real cure was to pause the world while a lone visitor catches up.

## Proof before trust

Before merging the game onto the live branch, I had the merge rehearsed: built the real
Docker image and booted it on data written by the live build. Every test was green, yet it
found two bugs that would have taken the site down. On a simulation change the server
exited while starting up, invisible to tests because the test runner keeps the process
alive,
[`e2851ed`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/e2851ed).
And the course's own checks failed because the first visitor to an empty world froze it,
[`d0d0634`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d0d0634).
With both fixed, the merge deployed and kept the live world,
[`d9c6ed1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d9c6ed1).

Oversight runs both ways. Mid-session I caught the agent running `rm -rf $D/*`, where `$D`
came from a temporary file. Had that file been empty it would have expanded to
`rm -rf /*`. It only emptied the folder it meant to, but by luck. Every `rm` must now name
an explicit path, written into `CLAUDE.md` so every worker inherits it,
[`aedb377`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/aedb377).

## Reasoning visually

The codebase is now larger than I will read line by line, so for the hardest problems I
asked for diagrams rather than code reviews. They are Mermaid, written as text beside the
explanation, so they render on GitHub and cannot drift from it. They cover where the world
is simulated and what the server can see, the stack overflow and its fix, a late joiner
catching up, and the merge rehearsal,
[`43e3dba`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/43e3dba),
[`83d0774`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/83d0774).
The biggest decisions and challenges are collected in `docs/engineering-decisions.md`,
[`87eed2d`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/87eed2d),
and every change is a row in `docs/DECISIONS.md`.

## What is open

Bots in a 30-minute soak kept every client in sync but never reached the deep caves, so
combat sync rests on a scripted cross-browser test rather than a live soak. With two players
present, one modified client could award itself a kill achievement; I chose to accept that
in a co-op game. The final README and polish come before the submission on 9 November.
