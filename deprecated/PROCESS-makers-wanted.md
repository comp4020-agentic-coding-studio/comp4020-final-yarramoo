# Process overview

## From brief to idea

I went through two ideas before writing any code. The first was a tool that
rations how much text an LLM may generate. The second instrumented how long
people spend reading machine-written text. Both were about the same worry,
that text arrives faster than anyone understands it. I dropped both for
something more human: a board where people post DIY engineering projects and
find local collaborators. The worry came back as the site's founding rule.
Everything posted is human-written (not for demoing the site though obvs), 
and the reasons are in README.md and on`/philosophy`.

## Harness first

The first commit was the harness, not the app,
[`ae2778a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/ae2778a).
I had the agent survey the CLAUDE.md files from my earlier deliverables, and
kept only the five rules that came from things going wrong:

- commit and push as you go
- cap every agent dispatch by count, model and effort, after an uncapped
  fan-out spent a week's budget in twenty minutes
- open the app in two browsers for anything concurrent
- treat a red check as authoritative
- keep PROCESS.md to its word band

That last rule is enforced in `check:evidence`. It fails over 1,100 words and
only warns under 900, because CI runs it before every deploy and this file
grows across three crits.

Two rules were added later as the workflow settled. One makes every
development task go to the cheapest model that can do it well, with Opus kept
for planning, briefs and review,
[`e7284ea`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/e7284ea).
The other logs good ideas in `FUTURE.md` rather than building them or losing
them,
[`ea38d62`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/ea38d62).
FUTURE.md now holds about a dozen ideas, each saying where it came from.

## Stack decision

**Decision:** one Node 24 process running TypeScript directly, with no build
step. Hono handles routing and server-rendered HTML through auto-escaping
tagged templates. `node:sqlite` in WAL mode stores everything on the `/data`
volume. Real-time updates use an in-memory publish/subscribe bus pushed to
browsers over server-sent events. Photos are resized in the browser before
upload, so there's no native image library on the server.

**Why:** the course machine is one 256 MB instance with one volume. A single
process means a single database writer, so concurrent writes can't race, and
no message broker is needed. Server-sent events are enough because browsers
only need pushes; actions go up as ordinary form posts. Every page also works
without JavaScript.

**Rejected:** Astro, which is static-first and the wrong shape for a live,
stateful app; Postgres, which would be a second Fly app outside the course
setup; WebSockets, which add two-way complexity the app doesn't need.

## How I directed the agents

I worked with one Opus session as orchestrator and gave all the building to
Sonnet workers. Mechanical jobs like seeding data and scraping went to Haiku.
Each brief named the files the worker could touch, the shared contract it must
reuse, how to verify, and what it must not do. Slice 0 fixed that contract
(schema, auth, live bus, layout) before anything ran in parallel,
[`24a385f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/24a385f).
After that, join requests and progress updates were built at the same time in
separate git worktrees and merged by hand,
[`6f81e6f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/6f81e6f).
The session never needed a context compaction, and the overnight run of four
slices cost about $7 of the weekly course budget.

## Grounding

Facts the site states come from checked sources, not model memory. I had the
rocketry club links confirmed before any went in,
[`e7d7477`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/e7d7477).
A Haiku research pass on Australian hobby groups returned 16 links; I only
published the 13 that loaded,
[`622007a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/622007a),
and left out about 15 groups it named without a link. The safety research
records which sources couldn't be confirmed,
[`99426bf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/99426bf).

## Corrections

**Review caught contract bugs.** Slice 0 applied CSRF protection to only one
router, and its live client silently dropped event types it didn't know. Both
would have bitten every later slice. I fixed them before anything was built on
top,
[`ee3666f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/ee3666f).

**I redirected the honesty system.** The first Q&A build let users flag posts
as machine-written and showed a public "pasted text" badge,
[`13b15e1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/13b15e1).
That made people police each other, which is the opposite of the feeling I
wanted. I had it replaced with a positive pledge up front and quiet behaviour
signals in the backend that only an admin sees,
[`3966117...68c1c7a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/compare/3966117...68c1c7a).

**A worker's success claim was false.** The Haiku seed script reported
accepted join requests and finished projects. The database had none, because
the script never checked a response,
[`1ce1772`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/1ce1772).
The fix asserts every request,
[`c488435`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/c488435).
Since then I check each report against the real data before relaying it.

**A worker broke the dev server.** One worker built in a scratch copy with
`node_modules` symlinked and committed the link. Merged, the link replaced
the real folder and crashed the dev server. The worker rewrote its unpushed
commits, and I changed `.gitignore` so a symlinked `node_modules` can't be
committed again,
[`64a4d9e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-yarramoo/commit/64a4d9e).
Later briefs said "work in the repo, never symlink `node_modules`."

## Backpressure

Every spec in `spec/` runs against the real running app: 97 tests at this
point. They include real-time checks that an event reaches another session
within a second, and checks that the honesty labels never leak to the page. I
ran the suite twice before each push, so a flaky pass couldn't slip through.
No red state was committed.

## Shipping

I deployed to Fly by hand from the private repo throughout, to test on the
real 256 MB machine. Before the crit I backed up the live database, which held
only test data, and reset it.
