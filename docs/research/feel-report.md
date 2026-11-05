# Feel report

## 1 Lava sizzle
client/hazard.ts + worker.ts gameFrame: health drop this frame while lava cell inside own hitbox (same box as sim hazard_scan), 280 ms gap, sfxSelf "sizzle" (new SfxName). Unit-tested in tests/net/hazard.test.ts (written after the code, not red-first).

## 2 Fight music
Mood "fight" (C minor, 152 bpm, perc every beat, eighth bass) in client/music.ts; stepMood takes optional combatAt, holds FIGHT_HOLD_MS=9000 after the last signal, returns straight to depth mood. Priority: round sting > boss > fight > depth. Worker posts {type:"combat"} (500 ms throttle, silent when replaying) on: my health fell without lava contact (hit by enemy, bolt, explosion, player, also fire/acid), my EV_ENEMY_HURT, EV_KNOCK with attacker == me on another player. Tests in tests/net/music.test.ts (red first: 3 failed before the code).
