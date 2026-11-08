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
