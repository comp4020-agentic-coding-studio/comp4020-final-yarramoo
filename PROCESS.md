# Process overview

This project has grown significantly in complexity since starting and a number 
of development factors are worth discussing. 

First are the engineering choices. 
I chose a multiplayer simulation like Noita largely to challenge the harness and 
see what it could do - this project is way beyond what I could reasonably 
implement myself. Claude did a fantastic job of designing a client/server architecture 
that was able to run independent client-side simulations with server-side hash checking
and event broadcasting. 

Second is the prompting strategy I landed on, which produced most of `docs/`. Third is CLAUDE.md and eventually
skills, which mattered more as testing became a long and arduous task. 

## Engineering Choices

I generated the initial plan over a back-and-forth chat with the Claude chatbot using 
my personal subscription. I asked it to research specifically issues encountered in 
making particle simulation games multiplayer. In this conversation I first started asking for architecture diagrams, 
which I continued to do over the course of development. After asking for the design to 
be written as a prompt, I gave it to the harness which landed it in `docs/plan.md`.

I've picked the most interesting decisions and let Claude explain them below. These were the decisions 
that would've taken me months to upskill enough to make intelligent decisions about.

**Determinism.** Lockstep only works if every browser computes the identical world, bit for bit, forever. Three
choices carry that. The simulation is Rust compiled to wasm, and its build forbids floats, clocks, randomness and
hash maps, so the rules are enforced rather than hoped for. All arithmetic is integer, with fixed-point maths where a
float would be natural. Randomness is a counter-based function `rng(seed, tick, x, y, salt)` with no state to drift
([`92ed2f0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/92ed2f0)).

**What runs where.** The browsers compute; the server only orders inputs, relays them, and checks that everyone
agrees: hash votes every second, and snapshots it verifies in a worker but never steps
([`43a1cab`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/43a1cab)). Events
like deaths count only when a majority of players report them. The diagram is `docs/architecture/components.png`.

**The test harness.** The gate is five steps chained on exit codes: native Rust tests, clippy, typecheck, the
determinism suite and the network suite. The determinism suite runs the same inputs in Node, Chromium, Firefox,
WebKit and native Rust
([`3cff05c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/3cff05c)), plus a
deliberately broken "canary" build that must fail, proving the harness can see nondeterminism at all. 


## Prompting

My strategy for prompting was fairly straightforward. I had a main Claude Code session that 
I first asked to read the `README.md` and to "familiarise yourself with this project". I 
then asked for an Opus subagent to be dispatched to implement a new feature, do optimisation, 
code-review, etc. I asked the top-level session to add in a reasonable budget-cap which 
almost always was an over-estimate for the task (models systematically wayyy over-estimate 
time and tokens required). 

These subagent delegations result in entries in `docs/briefs/`, which create a nice record 
of features and things I've asked for. These documents could have been arranged more 
systematically, but the files all have edit-dates which makes that information derivable. 
The results of subagent R&D sat in `docs/research/` which is further documentation. 
Additionally, a `DECISIONS.md` register records every engineering decision from start to 
end. The quality of this document and its contribution to coherency of the project is 
questionable, but I occasionally caught agents referencing a previous decision so it 
seemed useful at times. 

At a more human level, I tried to create long-running agentic sessions for overnight 
runs or runs during work. Part of doing this was creating a `FUTURE.md` file that held 
ideas that sprung to mind as extensions once an agent had finished something. For example 
a bunch of enemy ideas or biomes, that would be more feasible once the first one or two 
had been implemented. Another interesting file is `HANDOVER.md` which I eventually started 
asking the top-level agent to keep up-to-date, so that a `/clear` context could be recovered 
from with a "please read the handover". 

Lastly, I asked subagents to create longer-form documentation and graphics to make the project 
documentation more centralised. The main outputs are `ARCHITECTURE.md` and 
`docs/architecture/doc-index.md`. 

## Harness Interventions

`CLAUDE.md` was useful in two broad scenarios - informing the model of game invariants and good development practice, 
such as git hygiene and agent dispatch principles around budgeting and model selection. It was also where I 
instructed the harness to continually interact with running documents in the project like `FUTURE.md` and `engineering-decisions.md`. 

It additionally gave me a way of enforcing that mistakes weren't repeated. 
- **Cold reviews as a standing rule.** A reviewer with no context found a snapshot buffer overrun that every test had
  passed over ([`86cf96c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/86cf96c)).
- **Every `rm` names a literal path.** I caught an agent running `rm -rf $D/*` with `$D` read from a file; had the file been empty, that is `rm -rf /*`. That seemed dumb to me, so every `rm` now names an explicit path ([`aedb377`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/aedb377)).

Skills came later when the project grew to a size that testing became a proper chore. The `run-tests` skill holds
"the gate", the tests that check simulation correctness and cross-browser agreement, plus the rules for running it
(one heavy job at a time). The `dev-server` skill restarts my local server after rebuilds,
since it refuses tabs with a stale build
([`f3d4034`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/f3d4034)). When the
full gate grew to 20 minutes, a planner script started picking only the steps a change can affect
([`2fe4c58`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/2fe4c58)).

A `dev-tools` skill was added to document in-game debug hooks, so agents could stage and screenshot scenes
([`c44eb37`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/c44eb37)).
At first agents were just making these tools but I was worried they would lose track of these tools and
continue making their own. `docs/skills.md` shows where each skill was used. 
