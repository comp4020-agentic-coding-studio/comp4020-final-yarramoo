# Feel report

## 1 Lava sizzle
client/hazard.ts + worker.ts gameFrame: health drop this frame while lava cell inside own hitbox (same box as sim hazard_scan), 280 ms gap, sfxSelf "sizzle" (new SfxName). Unit-tested in tests/net/hazard.test.ts (written after the code, not red-first).

## 2 Fight music
Mood "fight" (C minor, 152 bpm, perc every beat, eighth bass) in client/music.ts; stepMood takes optional combatAt, holds FIGHT_HOLD_MS=9000 after the last signal, returns straight to depth mood. Priority: round sting > boss > fight > depth. Worker posts {type:"combat"} (500 ms throttle, silent when replaying) on: my health fell without lava contact (hit by enemy, bolt, explosion, player, also fire/acid), my EV_ENEMY_HURT, EV_KNOCK with attacker == me on another player. Tests in tests/net/music.test.ts (red first: 3 failed before the code).

## 3 Hotbar by pickup order
client/slots.ts (pure: addPickedUp, swapSlots) + room.ts. A spell gets a slot the first time charges > 0 is seen in this session (module-level in the room closure, kept across lives; reset on page reload, not persisted). Infinite starters appear immediately. A spent spell keeps its slot, greyed (existing .empty). Keys 1-9,0,Shift+n and Q/E follow slot order. Drag: pointerdown on a slot then pointerup on another swaps. Casting sends selectedSpell, the real id. Tests: tests/net/slots.test.ts.

## Verification
- `pnpm typecheck && pnpm test:net` green before each commit (58 files, 406 passed). No sim/shared/server changes (`git diff --stat multa` shows client/ and tests/net/ and this report only).
- Browser (vite dev on a local Survival avatar world, agent-browser, 1280x800): `/tmp/feel-3.png` shows hotbar Push/Blast/Dig then Bomb (key 4), Water (key 5): Bomb was picked up first (`__devGoto(5)`), Water second (`__devGoto(2)`), the reverse of bar order. `/tmp/feel-4.png` after dragging Bomb onto Water: Water is slot 4, Bomb slot 5, key 4 selects spell 2 (Water). `/tmp/feel-5.png` sandbox: no spell bar. Lobby and Creative not looked at in the browser (unit-tested only: Creative all-infinite gives bar order).
- Lava: painted lava on the avatar in the browser; health dropped (100 to 65), so the damage path ran, but sound is inaudible to me. The `__evLog` marker for a sizzle only exists when the server announces dev teleport, and the local vite route does not, so the sizzle request path was not observed end to end. Unit tests cover the detector. Fight music: the pure mood logic is tested; whether the room actually switched mood in the browser was not observed (`window.__music` was not read).

## Architectural decisions for review
- **Lava hit detection**: no per-hit signal exists, so the worker compares `me.health` between frames and scans the sim's own hitbox (5x10 cells, same rule as `hazard_scan`) for lava cells. Alternative: derive from EV_DEATH only (misses non-lethal). Cost: a hit by an enemy in the same frame as lava contact reads as lava; harmless.
- **Combat signal**: new `{type:"combat"}` worker message (500 ms throttle). Sources: my health fell with no lava touching (includes fire/acid, enemy, explosion, players), `EV_ENEMY_HURT.player == me`, `EV_KNOCK` with attacker (c) == me on another player. Dropping another player's health after my cast is covered by the knock event only (explosion damage to others without knock is not seen). Fire and acid ticks also count as fighting; arguably they should not.
- **fight mood priority**: sting > boss > fight > depth; the hold is 9 s, and leaving fight skips the 3 s depth debounce. Sandbox ignores combat.
- **Slot order lives in the room.ts closure** (module-lifetime, no localStorage): a spell keeps its slot across lives, resets on reload. Slot unlock is "charges > 0 seen this session". Creative shows all spells in bar order because all are infinite at once. Alternative: persist in localStorage keyed by room; left out as optional.
- The `last-tool` gap now sits after the last infinite slot instead of fixed after slot 3.
