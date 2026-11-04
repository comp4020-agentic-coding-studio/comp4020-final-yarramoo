# Brief HB2: make the scripted boss fight winnable, then see Victory in a real room

**Why:** brief HB (`docs/research/hb-boss-win.md`) built the dev-teleport plumbing and `pnpm soak:boss-win`, but in
about 12 runs both scripted players died in 3-8 s with the boss at 520-800 of 800 hp. So the Victory banner, the
"Deep Mage slain" toast in both pages, the room leaving `GET /api/rooms` and `round.end` win have still never been
seen in a real room. That is the goal of this brief. Changing the boss is **not**.

**Worker:** one Sonnet worker on `multa` in `/Users/mitch/code/courses/comp4020/comp4020-final-yarramoo`. Use no
subagents and stay within **about 60 tool calls**. If the goal is not met by then, stop and report what you
measured. Rules:
- the binding rules in `CLAUDE.md`;
- every commit only on a green gate chained with `&&` (never `;`, never through `grep` or `tail`);
- stage explicit paths only; **no pushing**; `rm` only on literal absolute paths;
- server port 8103 only; kill everything you start, by PID, before you finish.

**Files you may touch:** `tests/soak/boss-win.ts`, `docs/research/hb-boss-win.md`, `docs/art/shots/boss-win-*.png`, and
`client/room.ts` only to expose more **read-only** values to the script (as `__boss` does). **Not** `sim/`,
`server/`, `shared/`, or any tuning. `BOSS_HP` and the boss's attacks stay as they are.

## Step 1: find out what kills them (measure before changing anything)

The session model's lead, to confirm or refute: **a player's own Bomb damages them.** `sim/src/spells.rs:763` skips
explosion damage for *other* players when PvP is off (`id != owner`), not for the owner. A Bomb's damage reach is
`BOMB_RADIUS * 3 / 2` = 27 cells (D-179), and the script fights from 14-30 cells. A Fire bolt's fire cells near the
caster may also burn them.

Record the cause of every hp drop per player during a run. The sim emits events with a cause: find how the client
sees damage and death causes (the death toast or `EV_DEATH`'s cause, `CAUSE_*` in `shared/`), and expose a
read-only list for the script if needed. Run once with the current script and report the cause breakdown (own Bomb,
boss Fire bolt, boss Bomb, imp, lava, contact).

## Step 2: a bot that fights like a careful human

Change only the script. Choose from what step 1 shows. Likely moves:
- **Bombs only from beyond 30 cells** (lobbed), or not at all; Fire bolts from range (the boss's fire range is
  `BOSS_FIRE_RANGE` = 120 cells, so standing far away doesn't avoid its bolts, but it does avoid its contact,
  `BOSS_CLOSE_CELLS` = 14, and lava rings in phase 3);
- dodge: teleport a few cells up or sideways right after the boss fires (`BOSS_FIRE_TICKS` = 60, one bolt per
  second in phases 1-2; a 3-bolt fan every 90 ticks in phase 3);
- the two players on **opposite sides** of the boss, so its single aimed bolt only hits one at a time;
- pick up the supply pile's other damage spells too (see `docs/research/enemies-design.md` and the spell table in
  `shared/names.ts`), and take heals when they drop (summoned imps drop them 1 in 3).

## Step 3: the win

When a run wins, it must pass every check the script already makes: Victory in both pages, the toast in both, the
room off the public list, `round.end` win, `hash_fail` 0. Take screenshots of both pages at the win
(`SHOTS=docs/art/shots/boss-win`). Then run it **two more times** and report all three: time to kill, the cause
breakdown of damage taken, min hp, heals picked up, spells used.

## Balance (report only)

From those runs, say whether 800 hp looks right for two careful players, too long or too short, with the
reasoning. Don't change it; the user decides after playing.

## Commit checklist

- [ ] The script's damage-cause readout (and any read-only client value it needs), with step 1's numbers in the report.
- [ ] The careful bot, the three winning runs (or the best attempt), screenshots, and the updated report.

## The gate

`pnpm typecheck && pnpm test:net && git commit ...`. If you touch only `tests/soak/` and docs, `pnpm typecheck` alone
is enough; say which you ran. If you touched `client/room.ts`, run `pnpm test:net` too.

## Report

Update `docs/research/hb-boss-win.md`: step 1's cause breakdown, what the bot does now, the runs, the balance
reading, and "Architectural decisions for review" (anything exposed on `window` for scripts, and why it is
read-only and harmless in production).
