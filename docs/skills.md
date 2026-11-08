# Project skills, and where they were used

Claude Code loads project skills from [`.claude/skills/`](../.claude/skills/). They are committed there (the rest of
`.claude/` stays ignored, since its settings can hold the course key), so the files below are the ones the agents
actually read, not copies. A skill holds a how-to that grew too long for `CLAUDE.md`: `CLAUDE.md` keeps a one-line
pointer to each and the rule that sends an agent to it.

| Skill | What it holds | Why it exists | Added, changed |
|---|---|---|---|
| [`run-tests`](../.claude/skills/run-tests/SKILL.md) | The smallest test run for each question; the five-step gate chained on exit codes; the planner that picks a gate tier; rules learned the hard way | On 4 Nov eleven agents gated at once, the load reached about 575, every gate timed out and the noise hid two real bugs. The gate's rules had outgrown `CLAUDE.md` | `f3d4034` (5 Nov); `2fe4c58` the tiered gate (D-220); `b630cff` classify a merge by what it brings in; `a2c0ea8` a worker's gate counts when nothing moved under it |
| [`dev-server`](../.claude/skills/dev-server/SKILL.md) | Rebuild, restart and verify the user's local server on :8080; agents check on their own port | The server hashes `sim.wasm` once at start (invariant 10). On 5 Nov an agent rebuilt the client to show a fix and left the old server running, so the user's next tab was refused with "new version, reload" | `f3d4034` (5 Nov) |
| [`dev-tools`](../.claude/skills/dev-tools/SKILL.md) | The game's built-in debug hooks: dev routes and URL flags, console hooks (`__devPaint`, `__devGoto`, `__devGotoEnemy`, `__devBossHp`, `__activeBox`), material, spell and enemy ids, the generator preview, and what each can't do (there is no hitbox overlay) | Agents kept rediscovering the hooks from the source, or looking for tools that don't exist. With them an agent can stage a scene (stand by a boss at a given hp, paint lava) and screenshot it | `c44eb37` (6 Nov); `042ef8b` the vite block overwrites the remote hooks |

## In use

**`run-tests`.** Briefs since 5 Nov point workers at it instead of restating the gate, for example
[`review-fixes.md`](briefs/review-fixes.md), [`overnight-2026-11-08.md`](briefs/overnight-2026-11-08.md) and
[`backlog-2026-11-08.md`](briefs/backlog-2026-11-08.md). Reports then state the tier the planner gave and why:

- [`chat-report.md`](research/chat-report.md): full tier, because `client/protocol.ts`, `client/worker.ts` and
  `shared/protocol.ts` changed.
- [`warm-verify-report.md`](research/warm-verify-report.md): one commit on the server tier, its paths classified with
  `gate-plan.ts --files`.
- [`sound-report.md`](research/sound-report.md): full tier, on `client/protocol.ts` and `client/worker.ts`.
- [`rock-int-remerge-report.md`](research/rock-int-remerge-report.md): "Gate (run-tests skill, chained with &&,
  background)".

**`dev-tools`.** Screenshots in reports were staged with its hooks:

- [`int-boss-report.md`](research/int-boss-report.md): each Sand Colossus phase, set with `__devBossHp`
  (`int-boss-colossus-p2.png` at 380 hp, bar orange at 63%).
- [`int-enemies-report.md`](research/int-enemies-report.md): the frost sprite in the ice biome and the wisp over a lava
  lake.
- [`f6-worker-report.md`](research/f6-worker-report.md): `__devGotoEnemy(4)` puts the avatar 14 cells from the boss,
  in the arena.
- [`fix-c-hotbar-report.md`](research/fix-c-hotbar-report.md): `__devGoto(4)`, then a Fire bolt count checked on the
  hotbar.

**`dev-server`.** After every merge that rebuilt the wasm, the session model restarted the user's :8080 server with
the same data directory and checked the hashes and a real join before telling the user to reload. The owned-sandbox
lead restarted its own server on its own port to prove a world survives a restart
([`owned-sandbox-report.md`](research/owned-sandbox-report.md)).

## Related

- The gate planner itself: [`scripts/gate-plan.ts`](../scripts/gate-plan.ts) and its test
  [`tests/net/gate-plan.test.ts`](../tests/net/gate-plan.test.ts), which was shown red against a planner that skips
  every step.
- The rules each skill implements are in [`CLAUDE.md`](../CLAUDE.md); the incidents behind them are in
  [`ARCHITECTURE.md`](../ARCHITECTURE.md) section 5 and [`docs/engineering-decisions.md`](engineering-decisions.md)
  entry 40.
