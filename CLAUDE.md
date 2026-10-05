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
