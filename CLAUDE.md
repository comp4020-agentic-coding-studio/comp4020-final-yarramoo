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
