# Sound: audit and the most valuable gaps (Track D, backlog item 3)

Branch `sound` from `multa` a7d4e23, worktree `/tmp/wt-sound`. Lead: Opus. Cap $15; B0 (week spend at start) $381.37.
Client-only: nothing in `sim/` or `shared/` changes.

## 1. Audit (written by the lead, 8 Nov, from `multa` a7d4e23)

Where sound comes from today: the worker (`client/worker.ts`) turns sim events and the `entities()` view into
`{type:"sfx"}` messages via `sfxSelf` (no falloff, my own actions) and `sfxAt` (distance falloff and pan from the
camera centre); `client/room.ts` passes them to `play()` in `client/sfx.ts` (30 synthesised names, D-178; a cap of 10
voices; the worker budgets 24 messages a frame; every call carries `quiet` = catching up or fast-forwarding).

### Sim events (`shared/sim.ts` `EV_*`)

| Event | Sound today | Call site | Status |
|---|---|---|---|
| EV_SPAWN (join) | none | - | none (a join is not worth a sound) |
| EV_PICKUP | `pickup`, mine only | worker.ts:990 | has one |
| EV_CAST, spell 0 Push | `push` | worker.ts:903-904 (`SPELL_SFX`) | has one |
| EV_CAST 1 Blast | `blast` | same | has one |
| EV_CAST 2 Water | `water` | same | has one |
| EV_CAST 3 Rose | `rose` | same | has one |
| EV_CAST 4 Fire | `fire` | same | has one |
| EV_CAST 5 Bomb | `bomb` | same | has one |
| EV_CAST 6 Dig | `dig` | same | has one |
| EV_CAST 7 Acid Flask | `flask` | same | **shares** (with Oil and Lava Flask) |
| EV_CAST 8 Oil Flask | `flask` | same | **shares** |
| EV_CAST 9 Wall | `wall` | same | has one |
| EV_CAST 10 Lava Flask | `flask` | same | **shares** |
| EV_CAST 11 Black Hole | `hole` | same | has one |
| EV_CAST 12 Freeze | `push` (the `?? "push"` fallback: `SPELL_SFX` has 12 entries) | same | **shares Push's by accident** |
| EV_CAST 13 Quake | `push` (fallback) | same | **shares Push's by accident** |
| EV_CAST 14 Mudslide | `push` (fallback) | same | **shares Push's by accident** |
| EV_CAST_REJECTED | `reject`, mine only | worker.ts:910 | has one |
| EV_KNOCK | `knock` (all knocks: Push, explosions, enemy contact, Black Hole pull; 250 ms per player) | worker.ts:924-926 | shares across causes |
| EV_IMPACT | `impact` for every spell's landing and enemy bolts | worker.ts:930 | shares (15 spells, one sound) |
| EV_RESPAWN | `respawn` | worker.ts:954-955 | has one |
| EV_EXPLODE | `explode`, size-scaled (Bomb, gunpowder, the Mage's bomb) | worker.ts:938 | shares (scaled by radius) |
| EV_DEATH | `death` for every cause (the toast text differs by cause) | worker.ts:949-950 | shares across causes |
| EV_BAG_PICKUP | `bag` | worker.ts:981-982 | has one |
| EV_ENEMY_HURT | `hiss` for the acid slime, `squelch` for the other seven kinds, bosses included | worker.ts:962 | shares |
| EV_ENEMY_DEATH | `bossdeath` (Mage, Colossus), `screech` (imp), `crunch` (worm), `splat` (slime, acid slime, wisp, frost sprite) | worker.ts:968 | shares |
| EV_ROUND_END | none from sfx (music plays a victory/defeat sting via the `round` message) | room.ts:700 | none (music covers it) |
| EV_ENEMY_PHASE | not read as an event; the phase comes from the view | worker.ts:715, 726 | see `roar` below |
| EV_ROUND_START | `descend` | worker.ts:972 | has one |
| EV_HEAL | `heal` (+ a "+N health" toast for mine) | worker.ts:986-988 | has one |

### State-derived (the `entities()` view or the grid)

| What the game shows | Sound today | Call site | Status |
|---|---|---|---|
| **My health falls in lava** (hitbox mirror, `client/hazard.ts`) | `sizzle`, 280 ms gap | worker.ts:556 | has one |
| **My health falls to fire** (hazard, 1 HP per 6 ticks) | none (only the music's combat signal) | worker.ts:551 | **none** |
| **My health falls to acid** (1 HP per 4 ticks) | none | worker.ts:551 | **none** |
| **Hit by an explosion** (my Bomb, another's Bomb, gunpowder, the Mage's bomb) | `explode` + `knock` play for the blast itself; nothing says *I* was hurt | - | **none for the hurt** |
| **Hit by a Fire bolt** (a player's, an imp's, the Mage's fan) | `impact` + nothing for the hurt | - | **none for the hurt** |
| **Enemy contact** (slime 8, acid slime 15, worm 20, Mage 20, wisp 10, frost sprite 6, Colossus 20 HP) | `knock` (the contact knock) | worker.ts:924 | **shares `knock`; no per-kind hurt** |
| Falling rock | no sound; **it never damages a player** (the sim's `apply_damage` call sites are enemy bolt, Fire bolt, explosion, the lava/fire/acid hazard scan and enemy contact only) | - | none, and no damage cause to sound |
| Worm tunnelling near the camera | `rumble`, at most 2/s | worker.ts:737 | has one |
| An enemy bolt launched (imp, Mage) | `crackle` once per bolt | worker.ts:1004 | shares (imp and Mage) |
| Boss phase change (Mage, Colossus) | `roar` | worker.ts:715, 726 | shares (both bosses) |
| **A large amount of water moving near the player** | none | - | **none** |
| Lobby ready / countdown | none | - | none |

### UI events (main thread)

| What | Sound | Status |
|---|---|---|
| Achievement toast (`room.ts:708`) | none | none |
| Chat line (`room.ts:705`, D-229) | none | none |
| Round banner win/lose | music sting (`client/music.ts`) | music covers it |
| Mute toggle (`room.ts:200-211`) | mutes `master`; music has its own mute | - |
| Sandbox brush strokes | none | none |

**Summary.** 30 sound names, 22 call sites. Of the user's three asks: damage by cause has **one** of about twelve
causes (lava); casting has **12 distinct sounds for 15 spells** (three flasks share `flask`; Freeze, Quake and Mudslide
fall through to Push's `push`); moving water has **none**. Falling rock deals no damage in the sim, so "damage from
falling rock" has nothing to attach to client-side (adding it would be a sim change: out of scope, see FUTURE).
There is no volume slider: "the existing volume" is `MASTER_GAIN` and the camera-distance volume, plus mute.

## 2. Built (worker: Sonnet, brief `docs/briefs/sound-build.md`; review and one fix: the lead)

| Commit | What | By |
|---|---|---|
| fa571d5 | The audit (section 1) | Opus lead |
| 2800fa0, 1448e98 | The build brief (worker cap lowered to $6) | Opus lead |
| 0f133f8 | `client/sound-cues.ts`: `hurtCause`, `damageSound`, `hurtClass`/`shouldPlayHurt`, the 15-entry `SPELL_SFX`, `waterMotion`; `hitboxMaterials` in `client/hazard.ts` (`hitboxTouchesLava` kept as a wrapper); `tests/net/sound-cues.test.ts` | Sonnet |
| 826fc3f | `client/sfx.ts`: 14 hurt recipes, 5 new cast recipes, a `play()` request counter | Sonnet |
| 2415f40 | Worker wiring (hurt by cause replaces the lava-only sizzle; my death also plays its cause; the cast table), `setWater` (one persistent voice), the `ambient` worker message, dev `?cfg=creative`, `window.__sfxCounts` | Sonnet |
| e0c18ce | `docs/research/sound-worker.md`, the worker's own report | Sonnet |
| 167c900 | Review fix: silence the water voice when the client leaves `live` (catch-up, reconnect, rejected) or the tab hides. `gameFrame`, which samples the water, does not run then, so the voice would have held its last level | Opus lead |

- **Damage by cause** (the local player's hurts only). The sim names a cause only on death (`EV_DEATH.b`), so a
  non-lethal hurt's cause is inferred from outputs in the frame my health falls. The inference reads, in order, an
  `EV_EXPLODE` reaching my chest (enemy owner gives that enemy's cause, owner 0 gunpowder, else Bomb), an
  `EV_IMPACT` of a Fire bolt near my hitbox (enemy or player), the enemy contact knock (`|a| = 40, b = -24, c = 0`)
  giving the nearest enemy's kind, then the hitbox contents in the sim's own priority (lava, fire, acid).
  14 sounds: `sizzle` (lava, existing), `burn`, `corrode`, `powderhit`, `blasthit`, `bolthit`, `hurt` (unknown or
  another spell), and one per enemy kind: `slimehit`, `imphit`, `acidhit`, `wormbite`, `magehit`, `wisphit`,
  `frosthit`, `colossushit`. Hazards share a 280 ms gap; discrete hits get 120 ms. My `EV_DEATH` plays `death`
  plus the exact cause's sound.
- **Falling rock: cut.** The sim never damages a player with it, so there is nothing to attach a sound to without a
  sim change.
- **A distinct cast sound per spell.** 15 names, all different. The new ones are `acidflask`, `lavaflask`, `freeze`,
  `quake` and `mudslide`. The old table had 12 entries, so Freeze, Quake and Mudslide fell through to Push's sound.
- **Ambient rushing water.** `waterMotion` samples the camera window on a world-aligned stride-2 grid and counts the
  samples whose water/not-water state changed at the same world cell since the last sample. A moving camera over
  still water therefore reads 0. Each changed sample is weighted by distance from my avatar (`1 - d / (window
  width / 2)`), a floor is subtracted (a drip reads 0), and the result is scaled to 0..1. The worker runs it every
  200 ms, smooths it (fast attack, slow release), and posts it only on a change over 0.02. It sends 0 while catching
  up, when not live, or when the tab is hidden. The main thread runs one looping noise voice (bandpass about
  900 Hz, slow LFO, eased gain) through `master`, so mute silences it. It is outside `MAX_VOICES` and stops after
  4 s at 0.
- **Bounds.** Every one-shot still goes through the worker's per-frame `sfxBudget` (24) and `play()`'s 10-voice
  cap. Per-frame hurt sounds are rate-limited as above. There is no per-cell or per-tick sound. Mute acts on
  `master`, and there is no volume slider (`MASTER_GAIN` plus per-sound `vol`).

## 3. Gate and verification

- **Tier: full** (`node scripts/gate-plan.ts`: `client/protocol.ts` and `client/worker.ts`). The gate ran on 167c900
  with a quiet host (load about 2): cargo test (`/tmp/sound-g-cargo.log`, 53 result lines ok), clippy
  (`/tmp/sound-g-clippy.log`), typecheck (`/tmp/sound-g-tsc.log`), determinism **53/53**
  (`/tmp/sound-g-det.log`), net **558 passed, 1 skipped, 75 files** (`/tmp/sound-g-net.log`). `gate exit 0`.
  `APP_URL=http://localhost:8081 pnpm check` against my own server: green, 9/9 (`/tmp/sound-check.log`).
- **Red first** (worker, `docs/research/sound-worker.md`). A stub `sound-cues.ts` that returned the wrong values
  made 13 tests fail, e.g. `expected null to be 42`, `expected 'hurt' to be 'sizzle'`, `expected +0 to be 15`,
  "still water reads 0" (the stub returned 1). One test was not truly red: "a falling mass reads > 0" passed against
  a stub returning 1. The other water tests (still 0, more is higher, farther is lower, a moving camera 0, a drip 0)
  were red. The final count is 17/17 (`/tmp/sound-unit.log`). `tests/net/hazard.test.ts` still passes on the
  generalised hitbox reader.
- **Each sound was verified to fire** by reading the request counter. `play()` counts by name before the
  mute/context checks, and `window.__sfxCounts()` was read in agent-browser on a dev route (vite on :5181).
  Nothing was heard: these are request counts and levels, not audio.

| Sound | How staged | Seen | By |
|---|---|---|---|
| `burn` | `__devPaint` fire on myself (damage-on dev world) | `burn`, health 100 -> 96 | worker |
| `corrode` | acid on myself | `corrode` x3, -> 87 | worker |
| `sizzle` | lava on myself | `sizzle` x1, -> 79 | worker |
| `slimehit` | `?cfg=survival&seed=3`, slime contact | `slimehit` x9, -> 28 | worker |
| `imphit` (death path) | killed by an imp | `death` + `imphit` | worker |
| `powderhit` (death path) | my Bomb at my feet set off gunpowder, which killed me | `bomb`, `impact`, `explode`, `knock`, `death`, `powderhit`, `respawn` | lead |
| 15 cast sounds | `?cfg=creative`, each bar slot cast once | push, blast, dig, water, rose, fire, bomb, acidflask, flask, wall, lavaflask, hole, freeze, quake, mudslide (one each) | worker |
| water ambient | radius-14 water painted 20 cells above me | 0.62 after 1 s, peak 0.97, back to 0 by 6 s; a still lake 0 | worker |
| water silenced on hide | water painted again (0.37 at 1.2 s, peak 0.91), then `visibilitychange` with `document.hidden` true | 0 within 0.5 s, still 0 2 s later | lead |

  **Not seen in a browser** (unit-tested only): `blasthit`, `bolthit`, `hurt`, `acidhit`, `wormbite`, `magehit`,
  `wisphit`, `frosthit`, `colossushit`, and every non-lethal explosion or bolt hurt. A human ear should hear them:
  a playtest of a Survival round with a Bomb thrown near you covers most. No screenshots: nothing visible changed.

## 4. Spend

| | Week reading | Spent |
|---|---|---|
| B0 (start) | $381.37 | |
| Lead: reading, audit, brief | $385.96 | $4.59 |
| Sonnet worker (its own W0 $386.49 to about $387.94) | | about $1.5 |
| Lead: review, fix, gate, browser check, report | $390.05 | |
| **Total** | | **about $8.7 of the $15 cap** |

## 5. Architectural decisions for review

1. **A non-lethal hurt's cause is inferred client-side from outputs**, not reported by the sim. Alternative: a
   sim `EV_HURT {victim, amount, cause}` event, which is exact but needs a sim and `shared/` change and the full
   determinism suite. It costs a heuristic: an explosion and a fire in the same frame report the explosion, and a
   contact knock names the *nearest* enemy, which can be wrong when two kinds touch at once. Wrong only means the
   wrong sound plays, never wrong state (invariant 9 holds: nothing feeds back). The events are peeked in
   `gameFrame` before `spellFx` consumes them.
2. **The enemy-contact signature is `|a| = 40, b = -24, c = 0`** (tuning.rs `CONTACT_KNOCK_X/Y`). This silently
   breaks if those constants change. It degrades to `hurt` or a hazard cause, never a crash. A pin test against
   `tuning.rs` (like `tests/net/spells-table.test.ts`) would catch it. Listed under FUTURE.
3. **A lethal hit plays `death` plus the exact cause's sound** from `EV_DEATH.b`, with no inferred hurt sound
   (`gameFrame` skips dead players). This avoids a double sound.
4. **The music's combat signal now fires on every hurt whose inferred cause is not lava**, including unknown
   causes. Before, it fired on every hurt with no lava in the hitbox. The behaviour is the same except that lava
   is now judged by inferred cause.
5. **The water ambient is one persistent main-thread voice**, outside `MAX_VOICES`, sampled in the worker every
   200 ms and posted only on a change over 0.02 (at most 5 messages a second). It runs only in avatar rooms
   (inside `gameFrame`), never the sandbox. **Spectators hear it** from the camera centre; to reverse, pass
   `quiet` when spectating. The tuning constants (`WATER_FLOOR` 8, `WATER_SCALE` 80, a 900 Hz bandpass, gain 0.6)
   were set by readback only, **not by ear**.
6. **Silencing outside `gameFrame`** (lead fix 167c900): `setNet` to anything but `live`, and a hidden tab, post
   water 0 at once. Without it, a catch-up or reconnect mid-flood left the voice rushing.
7. **The instrumentation ships in every build**: `__sfxCounts` and a per-name integer increment in `play()`.
   It is cheap and read-only. The alternative is gating it on `import.meta.env.DEV`, which would have made
   verification on a real :8081 room impossible.
8. **Dev route `?world=game&avatar=1&cfg=creative`** (vite only, like `cfg=survival`) runs the local sim with the
   `CREATIVE` preset so every spell can be cast. Damage is off there.

## 6. D-row draft (the session model numbers it)

**D-2xx Sound by cause, per spell, and rushing water (client-only, D-178 synthesis).** The local player's
non-lethal hurts get a sound per cause (lava, fire, acid, gunpowder, Bomb, Fire bolt, each of the 8 enemy kinds),
inferred from the frame's events and the hitbox contents (the sim reports cause only on death). A death plays its
exact cause. Every spell has its own cast sound (15, up from 12 names with Freeze, Quake and Mudslide falling
through to Push). One persistent rushing-water voice follows the amount of water changing near the player in the
camera window, rate-limited, and silent while catching up, not live, or hidden. Falling rock does no player damage
in the sim, so it has no hurt sound. Alternative not taken: a sim `EV_HURT` event (exact, but a sim/ABI change on
the last day). Commits fa571d5..167c900 on `sound`; report `docs/research/sound-report.md`.

## 7. FUTURE ideas (listed, not added)

- **Sim `EV_HURT {victim, amount, cause}`**: an exact cause for every hurt, replacing the inference. It also
  lets other players' hurts sound (from the audit and decision 1).
- **Falling-rock damage**, with a `crush` sound, if falling rock should hurt players at all (a sim and design
  decision; from the audit).
- **A pin test** for the contact-knock signature against `tuning.rs` (decision 2).
- **A volume slider** for sound effects (there is only mute; from the audit).
- **Tune the water voice and the 19 new recipes by ear** in a playtest (worker report).
- **Quiet UI cues** for chat lines and achievements, both silent today (from the audit).
