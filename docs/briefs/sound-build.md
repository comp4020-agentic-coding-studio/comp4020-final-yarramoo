# Brief: sound build (Sonnet worker, branch `sound`)

You are a Sonnet implementation worker for the Opus lead of backlog item 3 (sound). **Cap: $6 of spend; stop and
report at $6 even if unfinished (finish the commit in hand first).** Read spend with
`curl -sf https://strproxy.comp.anu.edu.au/api/me -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" | python3 -c "import json,sys;print(json.load(sys.stdin)['current_week_spend'])"`
at the start (W0) and every ~20 tool calls; if the week reads $450 or more stop at once, commit what is green and report.
**Never dispatch subagents.** Work only in `/tmp/wt-sound` (branch `sound`, already has `node_modules`). Never touch
`/Users/mitch/code/...` (the main checkout), never the user's :8080 server, never push, never merge.

Read first: `/tmp/wt-sound/CLAUDE.md` (binds you: invariants 1 and 9 especially; every `rm` names a literal absolute
path, never a variable or glob), `docs/research/sound-report.md` (the audit: what exists, line numbers),
`client/sfx.ts`, `client/hazard.ts` + `tests/net/hazard.test.ts` (the pattern to copy), and in `client/worker.ts`:
`gameFrame` (~539-560, the lava sizzle), `sfxAt`/`sfxSelf`/`SPELL_SFX` (~853-872), `spellFx` (~875-1022).

## Hard limits
- **Client-only.** Do not touch `sim/`, `shared/`, `server/`. If you find you need to, stop and write why in your report.
- **Outputs never feed back (invariant 9).** Everything here reads `events()`, `entities()`, the material view and
  the camera, and produces only sound messages. No new input kind, nothing written to the sim.
- **Silent while catching up**: every new sound and the ambient level obey the existing `quiet`
  (`net === "catching-up" || !!ls?.fastForwarding`); the ambient level goes to 0 then.
- **Bounded**: no sound per cell or per tick; all one-shots go through `play()` (its `MAX_VOICES` cap) and the worker's
  `sfxBudget`; the water ambient is **one** persistent voice, not one per event. Respect mute: everything connects
  through `master` in `sfx.ts` (which mute zeroes); there is no volume slider, so "volume" is `MASTER_GAIN` plus the
  per-sound `vol`.
- Synthesised in the existing style (D-178): `tone()` / `noise()` recipes, no audio files.
- Do not change the chat input or any key handling in `client/room.ts` (D-229 key isolation).
- Only the files listed below.

## Files you may touch
`client/sfx.ts`, `client/sound-cues.ts` (new, pure helpers), `client/worker.ts`, `client/protocol.ts`, `client/room.ts`
(only: the `sfx` message case, a new `ambient` message case, the `__sfxCounts` hook, and the dev `cfg=creative` flag),
`client/hazard.ts`, `tests/net/sound-cues.test.ts` (new), `tests/net/hazard.test.ts`, and your report
`docs/research/sound-worker.md` (write it as you go, after each commit, so a run that dies still leaves it).

## What to build (the lead's design; deviations go in "Architectural decisions for review")

### A. Damage by cause, on the local player's hurts (`client/sound-cues.ts`, wired in `gameFrame`)
The sim reports a cause only on death (`EV_DEATH.b`). For a non-lethal hurt the client infers it, from outputs only,
when `gameFrame` sees my health fall (`prevHealth > mine.health`, alive, not spectating). `pendingEvents` at that point
already holds this frame's events (spellFx consumes them later in the same frame): **peek, do not consume**.
1. `hurtCause(input)` (pure), returning a cause number in the sim's numbering (`CAUSE_*` from `shared/sim.ts`,
   `40 + enemy kind`, or a spell id) or `null`. In this order:
   - an `EV_EXPLODE` (a = cx, b = cy cells, c = radius, `player` = owner) whose centre is within `radius + 2` cells of my
     chest (my x, y - 5 cells): owner with the high bit set (`>= 0x80000000`) -> `40 + ((owner >>> 16) & 0xff)`;
     owner 0 -> `CAUSE_GUNPOWDER`; else spell 5 (Bomb);
   - an `EV_IMPACT` with c = 4 (Fire bolt) within 4 cells of my hitbox: enemy owner -> `40 + kind`; else spell 4;
   - an `EV_KNOCK` for me with `c === 0`, `|a| === 40`, `b === -24` (enemy contact: tuning.rs `CONTACT_KNOCK_X/Y`):
     `40 +` the kind of the nearest enemy entity (`ENT_ENEMY`, `sub` = kind) to me;
   - else the hitbox contents, the sim's own priority (`hazard_scan`, sim/src/spells.rs ~860): lava -> `CAUSE_LAVA`,
     else fire (10) -> `CAUSE_FIRE`, else acid (16) -> `CAUSE_ACID`. Generalise `hitboxTouchesLava` in
     `client/hazard.ts` into a hitbox-materials reader (keep `hitboxTouchesLava` working; its test must stay green);
   - else `null`.
2. `damageSound(cause)` (pure) -> `SfxName`, every one distinct except where noted:
   lava `sizzle` (existing); fire `burn`; acid `corrode`; gunpowder `powderhit`; Bomb (5) `blasthit`; Fire bolt (4)
   `bolthit`; any other spell id `hurt`; enemies 40..47: slime `slimehit`, imp `imphit`, acid slime `acidhit`, worm
   `wormbite`, Deep Mage `magehit`, lava wisp `wisphit`, frost sprite `frosthit`, Sand Colossus `colossushit`; `null` or
   unknown -> `hurt`.
3. Rate limit (pure, like `shouldSizzle`): hazards (lava, fire, acid) at most one sound per `SIZZLE_GAP_MS` (280 ms)
   shared across the three; discrete hits (explosion, bolt, contact) at most one per 120 ms. This replaces the lava-only
   sizzle path: keep its dev log entry (`evLogOut` `k: 900`) when the cause is lava, and keep its
   `sfxBudget = Math.max(sfxBudget, 1)` trick (gameFrame runs before spellFx resets the budget).
4. On **my** `EV_DEATH` (exact cause in `e.b`) also play `damageSound(e.b)` alongside `death`.
5. Falling rock does not damage players in the sim (audit), so it gets no hurt sound. Write that down; do not add one.

### B. A distinct cast sound per spell (all 15)
Replace `SPELL_SFX` with a 15-entry table (export it from `sound-cues.ts` so it is testable): keep push, blast, water,
rose, fire, bomb, dig, `flask` (Oil Flask, 8), wall, hole; new `acidflask` (7: the flask's glass + a fizz), `lavaflask`
(10: glass + a low bubbling rumble), `freeze` (12: an icy rising shimmer), `quake` (13: a deep rolling rumble, longer
than `rumble`), `mudslide` (14: a thick wet glug/slurp). Test: 15 entries, all distinct, length === `NUM_SPELLS`.

### C. Ambient rushing water (one persistent voice)
1. Pure `waterMotion(mat, w, h, win, stride, prev, cx, cy)` in `sound-cues.ts`: sample the camera window on a
   **world-aligned** grid (x and y multiples of `stride`, e.g. 2), mark which samples are Water (5); compare with the
   previous sample set **at the same world cells** (only where the windows overlap), so a moving camera over still water
   reads 0. Changed samples are "moving water"; weight each by distance from (cx, cy) (my avatar, else the camera
   centre): `max(0, 1 - d / R)` with R about half the window width. Return `{ level 0..1, pan -1..1, next }` where
   `next` is the sample set for the following call. A few cells (a drip) must read 0: subtract a floor before scaling,
   then clamp. Tests, each shown red first: still water -> 0; the same water shifted down by a few cells (a falling
   mass) -> > 0; more moving water -> higher; the same motion farther away -> lower; the camera moving over still water
   -> 0; a handful of changed cells -> 0.
2. In the worker: run it at most every 200 ms (not every frame), on whichever sim drives `gameFrame`; smooth the level
   (e.g. attack fast, release slow); send `{ type: "ambient", water: level, pan }` only when it changed by more than
   0.02 or is 0 after being non-zero. Send 0 when `quiet`, when spectating... (spectators may hear it too: your call,
   flag it), and when the tab is hidden.
3. In `sfx.ts`: `setWater(level, pan)`: lazily one looping noise `AudioBufferSourceNode` (reuse `noiseBuf`) ->
   bandpass/lowpass (a rush: centre ~600-1200 Hz, Q low, maybe a slow LFO on the cutoff) -> gain -> stereo panner ->
   `master`, gain eased with `setTargetAtTime`. Level 0 eases to silence (stop the source after a few seconds of
   silence, restart on demand). It does not count against `MAX_VOICES`. Before unlock (no context) it does nothing.
4. `room.ts`: the `ambient` case calls `setWater`. Add `ambient` to `FromWorker` in `client/protocol.ts`.

### D. Instrumentation (for verification, every build, read-only)
In `sfx.ts` count every `play()` request by name at entry (before the mute/context checks) and keep the last and peak
water level; export a getter; `room.ts` exposes `window.__sfxCounts = () => ({ counts, water, waterPeak })`. Add a
dev-route flag `?world=game&avatar=1&cfg=creative` (vite only, like `cfg=survival`: `room.ts` ~144 and `worker.ts`
~1230) that runs the local sim with the `CREATIVE` preset from `shared/room.ts` (all spells, unlimited), so every spell
can be cast.

## Verify
- Unit: `pnpm vitest run --config vitest.net.config.ts tests/net/sound-cues.test.ts tests/net/hazard.test.ts` and
  `pnpm typecheck`. **Every new test shown red first** (write it against a stub that returns the wrong thing, record
  the failing output line in your report, then implement). Do not run the full gate: the lead runs it.
- In the browser (the `dev-tools` skill, `.claude/skills/dev-tools/SKILL.md`): your own vite on **port 5181**:
  `cd /tmp/wt-sound && pnpm build:sim && pnpm build:sim:devpaint` then
  `(cd /tmp/wt-sound && nohup pnpm exec vite --config client/vite.config.ts --port 5181 > /tmp/sound-vite.log 2>&1 &)`.
  Before any build or browser run: `uptime` and `pgrep -fl "cargo test|vitest|test:determinism|tests/soak"`; wait if
  a gate is running. agent-browser via `zsh -ic`, session name `sound`, viewport 1280x800, click the canvas once (a
  gesture unlocks audio). Stage and read `__sfxCounts()` after each:
  - `/game?world=game&avatar=1` (damage on): `__devPaint` fire (10) on yourself, then acid (16), lava (14), gunpowder
    (13) plus a fire spark next to it; `__devGotoEnemy(0)` / other kinds for contact; cast a Bomb at your feet if you
    have one. Record which hurt names fired (the counts) per stage.
  - `/game?world=game&avatar=1&cfg=creative`: cast each of the 15 spells (select the slot by key or click, then click
    the canvas; or `window.postMessage` is not available: use the real UI). Record the 15 cast names.
  - Paint a big block of water (radius ~12-16) above you, watch `water`/`waterPeak` rise and fall back to 0 after it
    settles; and that a still lake reads 0.
  Close the session and kill your vite (by its PID from `lsof -ti tcp:5181 -sTCP:LISTEN`, check it is node/vite first).

## Commit checklist (each commit: `pnpm typecheck` and the two test files green, chained with `&&`, never `;`)
- [ ] 1. `sound-cues.ts` tests red-first, then helpers (hurtCause, damageSound, rate limit, cast table, waterMotion)
       green; hazard.ts generalised.
- [ ] 2. New synth recipes in `sfx.ts` (14 hurt names + 5 cast names) and the counter.
- [ ] 3. Worker wiring: hurt sounds by cause, death cause sound, the 15-entry cast table.
- [ ] 4. Water ambient: `setWater`, the protocol message, the worker sampler; `cfg=creative` and `__sfxCounts`.
- [ ] 5. Report: `docs/research/sound-worker.md` with the browser results.
Each commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Gate commits like
`pnpm typecheck > /tmp/sound-tsc.log 2>&1 && pnpm vitest run --config vitest.net.config.ts tests/net/sound-cues.test.ts tests/net/hazard.test.ts > /tmp/sound-unit.log 2>&1 && git add <files by name> && git commit -q -F /tmp/sound-msg.txt`.

## Report (`docs/research/sound-worker.md`, written as you go)
What was built, red-first evidence (the failing lines), the browser results per stage (counts read back), anything
cut and why, spend (W0 and end), FUTURE ideas, and a section **"Architectural decisions for review"**: each choice later
work builds on, what was chosen, the alternatives, why, what it costs later. Where unsure about a hard-to-reverse
choice take the more reversible option and flag it.
