# Brief HB: a scripted boss win in a real room (slice I)

**Why:** nobody has seen Victory in a real two-browser room. The win banner, the "Deep Mage slain" toast in
both browsers, the room leaving the public list and `round.end` in the server log have only been unit- and
net-tested. Playing a real Survival descent by hand takes too long and isn't repeatable. Heal drops (D-181)
also changed the boss arithmetic, and 800 hp has never been checked against a real party.

**Worker:** one Sonnet worker on `multa` in `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`,
**after** brief HF (format 12) has landed. Use no subagents, and stay within about 110 tool calls. Rules:
- the binding rules in `CLAUDE.md`, the 11 invariants above all;
- every commit gated on exit codes chained with `&&`, never through `grep`;
- red-first tests; `rm` only on literal absolute paths; **no pushing**; never weaken a test;
- prefix cargo with `PATH="$HOME/.cargo/bin:$PATH"`;
- no `console.*` in `server/`, every new log name in `shared/events.ts`, client-repeatable lines through
  `log.limited`;
- your own ports: vite 5176, server 8103; `agent-browser` sessions named `hb-*`;
- kill every server, vite and browser session you start, by PID, before you finish.

## The constraint

**Invariant 1:** nothing writes sim state except `push_input`, and every client runs the same `sim.wasm`
(invariant 10). So the hook can't patch the boss's hp in a real room (the local-only `__devBossHp` does that
by restoring a patched snapshot, which in a real room would desync everyone). What a real room *can* accept is
ordinary input: the dev avatar's Pos and Cast, the same as a human sends.

The obstacle is getting there: the server's Pos validation (`shared/avatar.ts` `maxPosJump`, D-067) rejects a
teleport, and walking to the arena takes minutes.

## What to build

1. **A dev-only server flag**, e.g. env `SIMULTA_DEV_TELEPORT=1` (name it in `shared/` or `server/`
   constants), **off by default and refused in production**: if `NODE_ENV=production` or `FLY_APP_NAME` is
   set, the server logs a warning event and ignores it. With it on, the server accepts a Pos jump of any
   size for a room created with that server (or only for rooms whose creator asked; pick and flag).
   Log `dev.teleport` once per (member, minute) through `log.limited`.
2. **A client hook** in the built client (the real-room path, not only the vite dev route): `__devGotoEnemy(4)`
   and `__devGoto(spell)` working in a real room when the server says dev teleport is on (for example a flag
   in WELCOME or in `GET /api/rooms/:code`; adding a field to WELCOME is a protocol change, so prefer the HTTP
   route and flag your choice). The avatar teleports through the existing local controller, which then
   reports through the normal Pos path. In a production server none of this is reachable.
3. **A script**, `tests/soak/boss-win.ts` (run as `pnpm soak:boss-win`, a script not a vitest test, like
   `tests/soak/n1.ts`): start a real server with the flag, create a Survival room (size S), open two
   Playwright Chromium clients, ready both up, teleport each to deep pickups (`__devGoto`) then beside the
   boss, and cast at it until it dies. Check and print:
   - "Victory" (or the game's win banner text) visible in both pages;
   - the "Deep Mage slain" achievement toast in both;
   - the room gone from `GET /api/rooms`;
   - `round.end` with result win in the server's log ring (the admin dashboard data or the log file);
   - `hash_fail_w*` counters at 0 for the whole run;
   - the time to kill, both players' hp over the fight, how many heals dropped and were picked up, which
     spells landed.
   Write the summary JSON to `OUT` if set. Exit non-zero if any check fails.
4. **A net test** for the flag's gate: with the flag on, a big Pos jump is accepted; with it off, or with
   it on and `NODE_ENV=production`, it is rejected. Red first.

## Boss balance (measure, then propose; don't change)

Run the script three times (different seeds or room ids). Report the kill time and the damage taken. If 800 hp
looks wrong for two players with deep spells and heals, **propose** a number with the reasoning, in the report.
Don't change `BOSS_HP` or any tuning: that's the user's call after they play it.

## Look at it

Run the script headed once, or take screenshots from it: both browsers at the win, saved to
`docs/art/shots/boss-win-*.png`.

## Commit checklist

- [ ] The server flag and its gate, with the net test.
- [ ] The client hook in real rooms.
- [ ] `tests/soak/boss-win.ts` and its `package.json` script.
- [ ] The report `docs/research/hb-boss-win.md`, with the three runs' numbers and the screenshots, and a
      `docs/DECISIONS.md` row (D-186, or the next free number).

## The gate (every commit)

```
cd sim && PATH="$HOME/.cargo/bin:$PATH" cargo test --release && cd .. && pnpm typecheck && pnpm test:determinism && pnpm test:net && git commit ...
```

(Skip clippy and the cargo step only if you touch nothing in `sim/`; you shouldn't need to.)

## Report

`docs/research/hb-boss-win.md`: what changed, commits, the run results, the balance numbers and any proposal,
and **"Architectural decisions for review"**: how the flag is gated, where the client learns about it, and
why that can't reach production, with the alternatives and the later cost. Suggest FUTURE.md ideas there.
