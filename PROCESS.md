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
making particle simulation games multiplayer. This is where I added in details about 
the assignment machine (256mb single-cpu), and asked Claude to design an architecture 
that would suit. 

In this conversation I first started asking for architecture diagrams, 
which I continued to do over the course of development. After asking for the design to 
be written as a prompt, I gave it to the harness which landed it in `docs/plan.md` - 
the harness had access to the comp4020 course page and made some changes based on 
assignment spec. 

The plan landed as
[`7a99056`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/7a99056) and was
conformed to the course setup the same day
([`bc033ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/bc033ad)). The big
choice was deterministic lockstep: every browser runs the same Rust simulation compiled to WebAssembly, and the server
only orders inputs and checks hashes. The alternative, a server-side simulation, was ruled out by the 256 MB
single-CPU machine, and a JavaScript simulation by floating point differing between engines. The cost is that every
client must agree bit for bit forever, so the first thing built was a determinism suite running the same inputs in
Node, three browsers and native Rust
([`d911c8f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d911c8f)).

That choice kept costing. The live site went down on 18 October because a long tick log overflowed the stack on
boot ([`10247e2`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/10247e2)). An
independent review that read only the code found hash votes counted per socket rather than per player, so anyone could
outvote the truth by opening tabs
([`1298bd1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/1298bd1)). The full
reasoning is in `ARCHITECTURE.md` and `docs/engineering-decisions.md`.

Some bugs could only be found interactively. While playtesting I noticed poured water standing in walls 64 cells
apart that only slowly spilled over. Every test passed, because nothing tested what water looks like. I screenshotted
it and asked Claude to read the screenshot from my desktop. From that it worked out that the walls sat on chunk
edges: cells were updated chunk by chunk, so water at an edge got fewer moves per tick than water inside a chunk. The
fix updates whole rows across chunks
([`7bbf8ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/7bbf8ff)), with a
regression test. No agent running on its own would have seen it. 

## Prompting

My strategy for prompting was fairly straightforward. I had a main Claude Code session that 
I first asked to read the `README.md` and to "familiarise yourself with this project". I 
then asked for an Opus subagent to be dispatched to implement a new feature, do optimisation, 
code-review, etc. I asked the top-level session to add in a reasonable budget-cap which 
almost always was an over-estimate for the task (models systematically wayyy over-estimate 
time and tokens required). 

These subagent delegations result in entries in `docs/briefs/`, which create a nice record 
of features and things I've asked for. These documents could have been arranged more 
systematically, but the files all have edit-dates which I guess makes it derivable? 
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

Almost every rule in `CLAUDE.md` was added right after something went wrong, and each one names its incident so the
reason travels with the rule.

- **Delegate down.** Haiku for mechanical work, Sonnet for implementation from a brief, the session model only for
  planning, review and merging
  ([`e7284ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/e7284ea)).
- **`&&` is the gate.** A merge went in on a red test run because the commit was chained with `;`
  ([`d24bf69`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/d24bf69)), so commits
  now hang off the test's exit code
  ([`b862348`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/b862348)).
- **Cold reviews as a standing rule.** A reviewer with no context found a snapshot buffer overrun that every test had
  passed over ([`86cf96c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/86cf96c)).
- **Every `rm` names a literal path.** I caught an agent running `rm -rf $D/*` with `$D` read from a file; had the file been empty, that is `rm -rf /*`. That seemed dumb to me, so every `rm` now names an explicit path ([`aedb377`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/aedb377)).

Skills came later when the project grew to a size that testing became a proper chore. The `run-tests` skill holds
"the gate", the battery of tests that check simulation correctness and agreement across different browsers, plus the
rules for running it (one heavy job at a time). The `dev-server` skill restarts my local server after every rebuild,
since it refuses tabs with a stale build
([`f3d4034`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/f3d4034)). When the
full gate grew to 20 minutes, a planner script started picking only the steps a change can affect
([`2fe4c58`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/2fe4c58)).

A `dev-tools` skill was added to document in-game debug hooks, so agents could stage and screenshot scenes
([`c44eb37`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/c44eb37)).
At first agents were just making these tools but I was worried they would lose track of these tools and
continue making their own. `docs/skills.md` shows where each skill was used. 
