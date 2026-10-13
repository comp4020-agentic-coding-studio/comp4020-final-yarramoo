# Final project brief (summary)

A paraphrase of the official brief, fetched 2026-10-13. The source of truth is the
[course page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/).
Check it there before relying on any detail here.

## The brief

"Make a multi-user, real-time website that's good."

- **Multi-user:** at least two people, each in a separate browser, act on shared
  state, and the app can tell them apart. Who counts as a person is my choice.
- **Real-time:** a change appears in every other open session within about a
  second, with no reload. The transport is my choice and must be justified.
- **Persists:** actions survive sessions, restarts and redeploys.

What "good" means is mine to define and defend. The definition lives in three
places that must agree: `README.md` (the argument, with sources, published at
`/readme/`), `CLAUDE.md` (the rules) and `spec/` (the checks). Design for
co-presence: the app should be better because others use it at the same time,
with the showcase room as the target situation.

## Fixed constraints

From `fly.toml`, the `Dockerfile` and `spec/README.md`:

- one `shared-cpu-1x` machine with 256 MB, region `syd`, auto-stop when idle
- one 1 GB volume at `/data`, the only storage that survives a restart; no
  database server
- two shipped checks: `/` answers 200, and `/readme/` carries the README's
  headings in server-sent HTML
- CI builds the Docker image, runs `pnpm check` against it with a throwaway
  `/data`, then deploys `main` (once the repo is public)

## Crits in this repo

- Week 9, crit 8 "It's alive!" (done): first working version and first README.
- Week 10, crit 9 "All at once" (Wed 14 Oct, noon cutoff): real-time, plus one
  recorded decision about multi-person behaviour.
- Week 11, crit 10 "Fly by instruments" (Wed 21 Oct, noon cutoff): multi-user;
  two classmates use it from the URL alone while I read the logs.
- Week 12: studio session for finishing.

## Submission

Due **noon Monday 9 November 2026**. Individual. 40% of the course.

- the deployed app at its `*.fly.dev` URL, working at both marking viewports
- the source repo with code and checks; `pnpm check` and `pnpm check:evidence`
  pass
- `README.md`: 400–600 words on what good means, with sources
- `PROCESS.md`: 900–1100 words, rewritten (not appended) at each crit,
  justifying the stack and agent workflow with citations; ADRs may be linked
- `CLAUDE.md`, three crit reflections, and the commit history

## Marking

| Criterion | Weight |
|---|---|
| Legibility of process | 50% |
| Deployed full-stack application | 25% |
| Response to the brief | 25% |

- Markers start from `/readme/` with only the URL.
- Multi-user: two Chrome profiles (incognito counts), no shared storage.
- Real-time: both sessions visible at once, one at each marking viewport
  (desktop and phone).
- Persists: the marker returns the next day, after the machine stopped and
  restarted.
- The top band needs the app to withstand unplanned use: simultaneous actions,
  a slow connection.
- No feature checklist; extra features earn nothing. Marked down: "a chat room
  with the nouns swapped", unjustified features, README promises that never
  appear in the rules or checks.
- Process is read against commits, `CLAUDE.md` and `spec/`; a trade-off with no
  trace in the commits counts as asserted rather than shown. Corrections should
  land in the harness (`CLAUDE.md`, `spec/`), not be retried until green.
