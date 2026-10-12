# Morning report: Mission Control overnight run

Branch `mission-control`, pushed. **`main` is untouched and nothing was
deployed**; the live site still serves Makers Wanted.

## What exists now

A playable cooperative launch game. Each seat sees only its own console; a
server-owned countdown runs; consoles depend on each other; the Flight
Director polls GO/NO-GO, and the record keeps what each seat reported beside
what its console was showing. Three sequences: Kestrel-1 (3 seats, ~4 min),
Kestrel-2 (adds Weather, ~5 min) and Kestrel-3 (adds Range Safety and an
ascent anomaly, ~6 min). Outcomes run from success through scrub, pad abort
and explosion to termination and range violation. Every flown mission has a
public replay, every callsign a record of GO-on-caution versus speaking up,
and one shared agency (budget, reputation, pad, rockets) carries consequences
from crew to crew.

Try it: `D=$(mktemp -d); DATA_DIR=$D PORT=8080 node src/server.ts`, then open
two browser profiles at http://localhost:8080.

## Phases

| Phase | Commit | Spend |
|---|---|---|
| 1 Strip Makers Wanted | d213cb7 | $2.32 |
| 2 Pure engine | 17f1864 | $2.64 |
| 3 Server, identity, SSE | 05fe9d9 | $2.53 |
| 4 Consoles | 1de51f1 | $3.83 |
| 5 History and replay | 08e9f18 | $1.93 |
| 6 Outcome ladder | 2eb0458 | $1.74 |
| 7 Shared agency | 88c357f | $2.12 |
| 8 CLAUDE.md, FUTURE.md + S1 robustness | 15c7635, 5363e60 | $4.49 |
| S2 Cold review fixes | 9c5698b | $2.15 |
| S3 Phone layout | 2f4b15e | $0.89 |
| S4 Weather / Kestrel-2 | 28b450d | $4.26 |
| S5 Crew records | 340e06c | $1.40 |
| S6 Range Safety / Kestrel-3 | 6c3708a | $4.63 |

About **$34.90 of $80**. 193 tests green (engine and spec). Each phase's
report is in `plans/reports/`.

## Seen working in a browser

Two-browser missions to T-0: a careful crew launched successfully; a reckless
crew (fixes skipped, GO always) exploded, and the replay and both crew records
showed every GO-on-caution. Also seen: live lobby seats, hold-window
countdown, agency page updating live, phone layouts at 390 px.

**Not seen in a browser:** a pad abort, a weather scrub, and any Kestrel-3
flight past T-0 (the ascent UI was checked with real engine views in jsdom).
Nothing has been played by humans talking to each other.

## Found and fixed in review (not by the workers)

- A click could be lost when the console re-rendered each second.
- The Flight Director's checklist leaked other consoles' faults.
- The shared agency could soft-lock (broke and grounded); there's now an
  emergency appropriation that costs reputation.
- The stream watchdog would have reconnected every second on slow links.
- Sign-ups were limited to 10/min per IP, too tight for a class on one NAT.

## Questions for you

1. **The README argument is yours to write**, and nothing should merge to
   `main` until it is: `/readme/` still serves Makers Wanted, and so do
   `PROCESS.md` and `PHILOSOPHY.md`. The game is built to argue that teams
   should report what they see; Vaughan (normalization of deviance), the
   Challenger record and Edmondson (psychological safety) are the obvious
   sources.
2. **Reputation encodes that argument**: a GO on a caution costs reputation
   even when the launch succeeds. Keep it?
3. **Should fleet size cap concurrent missions?** Tonight, missions share a
   rocket rather than queue, so three rockets never stop ten crews playing.
4. **The `CLAUDE.md` section** "Mission Control conventions" was drafted by the
   agent. Review it and make it yours.
5. **Week 11 strangers need to find each other.** "Open crews on the home
   page" is the top `FUTURE.md` item and isn't built.

## Known weak spots

Weather readouts sit flat for the first ~40 s; a glitch anomaly's return to
zero hints at its nature; the old `app.db` stays on the Fly volume, unused;
identity is a cookie, so clearing it loses the record.
